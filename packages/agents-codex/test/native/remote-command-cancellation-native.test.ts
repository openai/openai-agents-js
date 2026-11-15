import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Agent,
  Environment,
  NativeProvider,
  telemetry,
  TurnAborted,
} from '../../src';
import { beforeAll, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { call, message, ModelServer } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

beforeAll(async () => telemetry.configure());

it.each([
  'before-start-reply',
  'rejected-start-reply',
  'missing-start-reply',
  'missing-scoped-start-reply',
  'live-result-before-delivery',
  'delivered',
  'close-without-stream-close',
] as const)(
  'preserves remote terminal ownership at %s',
  async (phase) => {
    const rejectedStart = phase === 'rejected-start-reply';
    const closeWithoutDrain = phase === 'close-without-stream-close';
    const scoped = phase === 'missing-scoped-start-reply';
    const missingStart = phase === 'missing-start-reply' || scoped;
    const holdStart =
      phase === 'before-start-reply' || missingStart || rejectedStart;
    const transportClosed = Promise.withResolvers<void>();
    const startReply = Promise.withResolvers<void>();
    const stopReply = Promise.withResolvers<void>();
    const resultReady = Promise.withResolvers<void>();
    const followup = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const forwardedStop = Promise.withResolvers<void>();
    let emitExit: (() => Promise<void>) | undefined;
    let deliveredId: number | undefined;
    const releaseResult = Promise.withResolvers<void>();
    const releaseModel = Promise.withResolvers<void>();
    const executor = await startPublicExecutor({ syntheticTerminal: true });
    const dir = dirname(executor.caCertificate);
    const ca = await readFile(executor.caCertificate);
    const server = createServer({
      key: await readFile(join(dir, 'server.key')),
      cert: await readFile(join(dir, 'server.pem')),
    });
    const relay = new WebSocketServer({ noServer: true });
    let forwardedStops = 0;
    server.on('upgrade', (request, socket, head) => {
      if (
        request.url !== '/executor' ||
        request.headers.authorization !== executor.headers.Authorization
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      relay.handleUpgrade(request, socket, head, (downstream) => {
        downstream.once('close', () => transportClosed.resolve());
        const upstream = new WebSocket(executor.url, {
          ca,
          headers: executor.headers,
        });
        const requests = new Map<number | string, string>();
        const lastOutput = new Map<string, number>();
        downstream.on('message', async (data) => {
          const frame = JSON.parse(data.toString());
          if (rejectedStart && frame.method === 'process/start') {
            startReply.resolve();
            await releaseStart.promise;
            if (downstream.readyState === WebSocket.OPEN) {
              downstream.send(
                JSON.stringify({
                  id: frame.id,
                  error: {
                    code: -32602,
                    message: 'Synthetic process start rejection',
                  },
                }),
              );
            }
            return;
          }
          if (frame.id !== undefined) requests.set(frame.id, frame.method);
          if (upstream.readyState === WebSocket.OPEN)
            upstream.send(data.toString());
          else upstream.once('open', () => upstream.send(data.toString()));
        });
        upstream.on('message', async (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.method === 'process/output') {
            const { processId, seq } = frame.params;
            lastOutput.set(processId, seq);
          }
          const method = requests.get(frame.id);
          requests.delete(frame.id);
          if (method === 'process/start' && holdStart) {
            startReply.resolve();
            await releaseStart.promise;
          }
          if (method === 'process/terminate') {
            const [processId] = executor.syntheticStarts;
            assert(processId);
            // Give the same process an exit record and an output-drained record.
            emitExit = async () => {
              const seq = (lastOutput.get(processId) ?? 0) + 1;
              for (const frame of [
                {
                  method: 'process/exited',
                  params: {
                    processId,
                    seq,
                    exitCode: 137,
                    sandboxDenied: false,
                  },
                },
                {
                  method: 'process/closed',
                  params: { processId, seq: seq + 1 },
                },
              ]) {
                if (closeWithoutDrain && frame.method === 'process/closed')
                  break;
                await new Promise<void>((resolve, reject) => {
                  downstream.send(JSON.stringify(frame), (error) =>
                    error ? reject(error) : resolve(),
                  );
                });
              }
            };
            stopReply.resolve();
            await releaseStop.promise;
            if (downstream.readyState === WebSocket.OPEN) {
              downstream.send(data.toString(), (error) => {
                if (error) forwardedStop.reject(error);
                else {
                  forwardedStops++;
                  forwardedStop.resolve();
                }
              });
            }
            return;
          }
          if (downstream.readyState === WebSocket.OPEN)
            downstream.send(data.toString());
        });
        for (const [a, b] of [
          [upstream, downstream],
          [downstream, upstream],
        ]) {
          a.on('error', () => b.terminate());
          a.on('close', () => b.terminate());
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const model = new ModelServer([
      ...(scoped
        ? [[call('transfer_to_child', {}, { callId: 'handoff' })]]
        : []),
      [
        call(
          'exec_command',
          {
            cmd: 'synthetic-pty',
            tty: true,
            login: false,
            yield_time_ms: 1000,
          },
          { callId: 'start' },
        ),
      ],
      ...(phase === 'delivered'
        ? [
            async (request: Parameters<typeof findToolOutput>[0]) => {
              const delivered = findToolOutput(request, 'start');
              assert.equal(typeof delivered.session_id, 'number');
              assert.equal(delivered.output, 'SOURCE_OUTPUT');
              deliveredId = delivered.session_id;
              followup.resolve();
              await releaseModel.promise;
              return [message('cancelled model response')];
            },
            () => {
              assert(deliveredId);
              return [
                call(
                  'write_stdin',
                  {
                    session_id: deliveredId,
                    chars: 'still-live\n',
                    yield_time_ms: 1000,
                  },
                  { callId: 'preserved-stdin' },
                ),
              ];
            },
            (request: Parameters<typeof findToolOutput>[0]) => {
              const live = findToolOutput(request, 'preserved-stdin');
              assert.equal(live.session_id, deliveredId);
              return [message('retained terminal is usable')];
            },
          ]
        : closeWithoutDrain || missingStart || rejectedStart
          ? []
          : [[message('successor completed')]]),
    ]);
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    const config = await model.config();
    const baseUrl = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const provider = new NativeProvider({
      baseUrl,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const terminations = () =>
      executor.requests.filter(({ method }) => method === 'process/terminate');
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    try {
      const environment = new Environment({
        url: `wss://127.0.0.1:${addr.port}/executor`,
        headers: executor.headers,
        cwd: executor.cwd,
        tools: ['exec_command', 'write_stdin'],
        ...(!scoped
          ? {
              async transformResult(context, value) {
                if (
                  (phase === 'live-result-before-delivery' ||
                    closeWithoutDrain) &&
                  context.toolName === 'exec_command'
                ) {
                  assert(
                    value && typeof value === 'object' && !Array.isArray(value),
                  );
                  assert.equal(typeof value.session_id, 'number');
                  resultReady.resolve();
                  await releaseResult.promise;
                }
                return value;
              },
            }
          : {}),
      });
      const child = scoped
        ? new Agent({
            name: 'child',
            model: 'gpt-5.5',
            provider,
            instructions: 'Start the scripted terminal.',
            environment,
          })
        : undefined;
      session = await new Agent({
        model: 'gpt-5.5',
        provider,
        instructions: child
          ? 'Transfer to the child.'
          : 'Start the scripted terminal.',
        ...(child ? { handoffs: [child] } : {}),
      }).session({
        tracing: { disabled: true },
        ...(child ? {} : { environment }),
      });
      const turn = await session.submit('Start waiting.');
      const ran = turn.wait().catch((error) => error);
      const ready = holdStart
        ? startReply
        : phase === 'delivered'
          ? followup
          : resultReady;
      await bounded(
        Promise.race([
          ready.promise,
          ran.then((early) => {
            throw early instanceof Error
              ? early
              : new Error('Turn settled before phase barrier');
          }),
        ]),
        'phase barrier',
      );
      assert.equal(executor.syntheticStarts.length, rejectedStart ? 0 : 1);
      assert.equal(
        model.requests.length,
        phase === 'delivered' || scoped ? 2 : 1,
      );
      if (rejectedStart) {
        const closing = session.close();
        void closing.catch(() => {});
        await stillPending(closing, 'process start rejection held');
        releaseStart.resolve();
        await bounded(closing, 'close after explicit start rejection', 18_000);
        assert.equal(terminations().length, 0);
        assert.equal(executor.syntheticStarts.length, 0);
        model.assertExhausted();
        return;
      }
      if (missingStart) {
        await assert.rejects(
          bounded(session.close(), 'close with no start reply', 18_000),
          /remote process termination attempt was not acknowledged/i,
        );
        await bounded(transportClosed.promise, 'remote socket retirement');
        assert.equal(terminations().length, 0);
        assert.equal(model.requests.length, scoped ? 2 : 1);
        model.assertExhausted();
        return;
      }
      const cancelled = closeWithoutDrain ? session.close() : turn.cancel();
      // The test may fail at a wire barrier before we get to await cancellation.
      void cancelled.catch(() => {});
      // Release the phase gate after requesting cancellation. The stop
      // acknowledgment and peer exit stay independently gated.
      releaseStart.resolve();
      releaseResult.resolve();
      if (phase === 'delivered') {
        await bounded(cancelled, 'delivered terminal cancellation');
        assert.equal(terminations().length, 0);
        releaseModel.resolve();
      } else {
        await bounded(stopReply.promise, 'held stop reply');
        assert.equal(terminations().length, 1);
        assert.equal(forwardedStops, 0);
        await stillPending(cancelled, 'both peer receipts held');
        assert(emitExit);
        releaseStop.resolve();
        await bounded(forwardedStop.promise, 'sent stop acknowledgment');
        await stillPending(cancelled, 'peer exit held after acknowledgment');
        await emitExit();
        await bounded(
          cancelled,
          closeWithoutDrain
            ? 'session close after acknowledgment and peer exit'
            : 'turn cancellation after both peer receipts',
        );
        assert.equal(model.requests.length, 1);
      }
      if (closeWithoutDrain) {
        await bounded(ran, 'turn interrupted by close');
        assert.equal(terminations().length, 1);
        const [stop] = terminations();
        assert.equal(
          (stop.params as { processId: string }).processId,
          executor.syntheticStarts[0],
        );
        model.assertExhausted();
        return;
      }
      assert((await bounded(ran, 'cancelled turn')) instanceof TurnAborted);
      const successor = await session.submit('Run the successor turn.');
      const result = await bounded(successor.wait(), 'successor completion');
      if (phase === 'delivered') {
        assert.equal(result.finalOutput, 'retained terminal is usable');
        assert.equal(terminations().length, 0);
        const writes = executor.requests.filter(
          ({ method }) => method === 'process/write',
        );
        assert.equal(writes.length, 1);
        assert.equal(
          (writes[0].params as { processId: string }).processId,
          executor.syntheticStarts[0],
        );
      } else {
        assert.equal(result.finalOutput, 'successor completed');
      }
      if (phase === 'delivered') {
        const closing = session.close();
        void closing.catch(() => {});
        await bounded(stopReply.promise, 'delivered terminal stop reply');
        assert.equal(terminations().length, 1);
        await stillPending(closing, 'delivered terminal acknowledgment held');
        releaseStop.resolve();
        await bounded(
          forwardedStop.promise,
          'sent delivered terminal acknowledgment',
        );
        assert(emitExit);
        await emitExit();
        await bounded(closing, 'delivered terminal teardown');
      } else {
        await bounded(session.close(), 'public session teardown');
      }
      assert.equal(terminations().length, 1);
      assert.equal(executor.syntheticStarts.length, 1);
      model.assertExhausted();
      const params = terminations()[0]?.params;
      assert(params && typeof params === 'object' && !Array.isArray(params));
      assert.equal(params.processId, executor.syntheticStarts[0]);
    } finally {
      releaseStart.resolve();
      releaseStop.resolve();
      releaseResult.resolve();
      releaseModel.resolve();
      if (session)
        await bounded(session.close(), 'cleanup session close').catch(() => {});
      await bounded(provider.close(), 'cleanup provider close').catch(() => {});
      await ModelServer.closeAll().catch(() => {});
      for (const downstream of relay.clients) downstream.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      await executor.close();
    }
  },
  20_000,
);

function findToolOutput(request: { input?: unknown }, callId: string) {
  assert(Array.isArray(request.input));
  const item = request.input.find(
    (item) => item?.type === 'function_call_output' && item.call_id === callId,
  );
  assert.equal(typeof item?.output, 'string');
  return JSON.parse(item.output);
}

async function stillPending(promise: Promise<void>, label: string) {
  const settled = await Promise.race([
    promise.then(() => true),
    delay(100, false),
  ]);
  assert.equal(settled, false, label);
}

async function bounded<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
