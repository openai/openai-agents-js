import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  Agent,
  NativeError,
  TraceContext,
  telemetry,
  tool,
} from '@openai/agents';
import {
  httpError,
  text,
  toolCall,
  withScriptedResponses,
} from '@openai/agents/testing';
import { z } from 'zod';
import { startTraceReceiver } from './native-telemetry';

const SENTINEL = 'SYNTHETIC_PRIVATE_CONTENT_7e942';
type WorkerReceipt = {
  outcome: 'completed' | 'provider_failure';
  usage: { providerRequests: number };
  parent: string;
  events: telemetry.TraceEvent[];
  flush: telemetry.FlushResult;
};

async function configure(endpoint: string, service: string) {
  // Each service owns its policy. W3C headers carry identity, never privacy policy.
  // The worker uses external parentTrace with content logging disabled below.
  // A global false restriction opens an implicit SDK scope, conflicting with that parent.
  if (service === 'orchestrator')
    telemetry.setSensitiveDataLoggingEnabled(false);
  await telemetry.configure({
    traces: { kind: 'otlp-http', endpoint, protocol: 'json' },
    logUserPrompt: false,
    logAgentResponses: false,
    toolResultMaxBytes: 0,
    spanAttributes: { 'business.service': service },
    environment: 'synthetic-local',
  });
}

async function worker(endpoint: string) {
  const events: telemetry.TraceEvent[] = [];
  await configure(endpoint, 'fulfilment');
  await telemetry.addTraceProcessor({
    onEvent: (event) => {
      events.push(event);
    },
  });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert(request.url === '/success' || request.url === '/stopped');
      request.resume();
      assert(typeof request.headers.traceparent === 'string');
      const parent = new TraceContext({
        traceparent: request.headers.traceparent,
        ...(typeof request.headers.tracestate === 'string'
          ? { tracestate: request.headers.tracestate }
          : {}),
      });
      const offset = events.length;
      const failed = request.url === '/stopped';
      const usage = await withScriptedResponses(
        failed ? [httpError(400)] : [[text(SENTINEL)]],
        async (peer) => {
          const agent = new Agent({
            instructions: 'Resolve the synthetic fulfilment request.',
            provider: peer.provider,
          });
          let rejected = false;
          try {
            const result = await agent.run(SENTINEL, { parentTrace: parent });
            assert.equal(result.finalOutput, SENTINEL);
          } catch (error) {
            if (
              !(error instanceof NativeError) ||
              error.message !==
                '{"error":{"message":"Scripted provider error","type":"scripted_error"}}'
            )
              throw error;
            rejected = true;
          }
          assert.equal(rejected, failed);
          peer.assertExhausted();
          return { providerRequests: peer.requests.length };
        },
      );
      const flush = await telemetry.forceFlush({ timeoutMs: 5000 });
      const receipt: WorkerReceipt = {
        outcome: failed ? 'provider_failure' : 'completed',
        usage,
        parent: parent.traceparent,
        events: events.slice(offset),
        flush,
      };
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(receipt));
    } catch {
      response.writeHead(500).end('Synthetic worker failed');
    }
  });
  server.maxConnections = 2;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  assert(address && typeof address !== 'string');
  process.send?.({ url: `http://127.0.0.1:${address.port}` });
  process.once('message', () => {
    void (async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await telemetry.shutdown();
      process.disconnect();
    })().catch(() => {
      process.exitCode = 1;
      process.disconnect();
    });
  });
}

/** Two synthetic business requests; run once in a fresh process. */
export async function businessWorkflow() {
  await using receiver = await startTraceReceiver();
  const child = fork(
    typeof __filename !== 'undefined'
      ? __filename
      : fileURLToPath(import.meta.url),
    ['--worker', receiver.endpoint],
    {
      execArgv: process.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  const exited = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? done()
        : reject(new Error('Synthetic worker exited unsuccessfully')),
    );
  });
  // Attach immediately so startup/cleanup errors never become unhandled rejections.
  void exited.catch(() => {});
  const events: telemetry.TraceEvent[] = [];
  let configured = false;
  try {
    const url = await new Promise<string>((ready, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker startup timed out')),
        15000,
      );
      child.once('message', (message) => {
        clearTimeout(timer);
        const parsed = z.object({ url: z.string().url() }).safeParse(message);
        if (parsed.success) ready(parsed.data.url);
        else reject(new Error('Invalid synthetic worker startup receipt'));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Worker exited before listening'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await configure(receiver.endpoint, 'orchestrator');
    configured = true;
    // Additive registration preserves native OTLP export.
    const receiptSink = {
      onEvent: (event: telemetry.TraceEvent) => {
        events.push(event);
      },
    };
    await telemetry.addTraceProcessor(receiptSink);
    let failDelivery = false;
    await telemetry.addTraceProcessor({
      onEvent() {
        if (failDelivery) throw new Error('Controlled synthetic delivery loss');
      },
    });
    const receipts = [];
    for (const scenario of ['success', 'stopped'] as const) {
      let remote: WorkerReceipt | undefined;
      let traceId = '';
      failDelivery = scenario === 'stopped';
      await telemetry.withTrace(
        {
          name: 'business.order',
          includeSensitiveData: false,
          metadata: {
            'business.stage': 'fulfilment',
            'business.route': scenario,
          },
        },
        async (root) => {
          traceId = root.context.traceId;
          await withScriptedResponses(
            [
              [toolCall('fulfil', { note: SENTINEL }, { callId: scenario })],
              [text(SENTINEL)],
            ],
            async (peer) => {
              const agent = new Agent({
                instructions: 'Use fulfil for the synthetic order.',
                provider: peer.provider,
                tools: [
                  tool({
                    name: 'fulfil',
                    parameters: z.object({ note: z.string() }),
                    async execute(_args, context) {
                      assert(context.traceContext);
                      const response = await fetch(`${url}/${scenario}`, {
                        method: 'POST',
                        headers: context.traceContext.toHeaders(),
                        signal: AbortSignal.timeout(10000),
                      });
                      assert.equal(response.status, 200);
                      remote = (await response.json()) as WorkerReceipt;
                      return SENTINEL;
                    },
                  }),
                ],
              });
              assert.equal((await agent.run(SENTINEL)).finalOutput, SENTINEL);
              peer.assertExhausted();
            },
          );
          assert(remote);
          assert.equal(
            remote.outcome,
            scenario === 'success' ? 'completed' : 'provider_failure',
          );
          await telemetry.withSpan(
            {
              name: `business.outcome.${remote.outcome}`,
              metadata: {
                'business.stage': 'settlement',
                'business.route': scenario,
                'business.usage.provider_requests':
                  remote.usage.providerRequests,
                'business.usage.tokens': 'unavailable',
                'business.outcome': remote.outcome,
              },
            },
            async () => {},
          );
        },
      );
      const flush = await telemetry.forceFlush({ timeoutMs: 5000 });
      assert(remote);
      const settledOutcome = remote.outcome;
      const settlement = events.find(
        (event) =>
          event.trace_id === traceId &&
          event.name === `business.outcome.${settledOutcome}`,
      );
      assert(settlement);
      assert.equal(
        settlement.attributes['sdk.metadata.business.outcome'],
        remote.outcome,
      );
      assert.equal(
        settlement.attributes['sdk.metadata.business.usage.provider_requests'],
        String(remote.usage.providerRequests),
      );
      assert.equal(
        settlement.attributes['sdk.metadata.business.usage.tokens'],
        'unavailable',
      );
      assert.equal(
        flush.status,
        scenario === 'stopped' ? 'partial' : 'success',
      );
      assert.equal(flush.droppedRecords, 0);
      assert.equal(flush.failedDeliveries > 0, scenario === 'stopped');
      assert(!JSON.stringify(remote.events).includes(SENTINEL));
      assert.equal(remote.flush.status, 'success');
      assert.equal(remote.flush.failedDeliveries, 0);
      assert.equal(remote.flush.droppedRecords, 0);
      const carrier = remote.parent.split('-');
      assert.equal(carrier[1], traceId);
      assert(
        events.some(
          (event) => event.span_id === carrier[2] && event.trace_id === traceId,
        ),
      );
      assert(
        remote.events.some(
          (event) =>
            event.trace_id === traceId && event.parent_span_id === carrier[2],
        ),
      );
      const remoteSpan = remote.events.find(
        (event) => event.lifecycle === 'end' && event.trace_id === traceId,
      );
      assert(remoteSpan);
      assert(JSON.stringify(receiver.batches).includes(remoteSpan.span_id));
      assert(JSON.stringify(receiver.batches).includes(traceId));
      receipts.push({
        scenario,
        traceId,
        outcome: remote.outcome,
        usage: remote.usage,
        flush,
        workerFlush: remote.flush,
      });
    }
    failDelivery = false;
    // Replacement removes built-in OTLP and the controlled failing processor.
    await telemetry.setTraceProcessors([receiptSink]);
    let replacedTrace = '';
    await telemetry.withTrace(
      { name: 'business.replaced-route' },
      async (span) => {
        replacedTrace = span.context.traceId;
      },
    );
    const replacedFlush = await telemetry.forceFlush({ timeoutMs: 5000 });
    assert.equal(replacedFlush.status, 'partial');
    assert.equal(
      replacedFlush.failedDeliveries,
      receipts[1]!.flush.failedDeliveries,
    );
    assert.equal(replacedFlush.droppedRecords, 0);
    assert(events.some((event) => event.trace_id === replacedTrace));
    assert(!JSON.stringify(receiver.batches).includes(replacedTrace));
    assert(
      !JSON.stringify({ events, batches: receiver.batches }).includes(SENTINEL),
    );
    return {
      receipts,
      replacement: { callbackReceived: true, otlpReceived: false },
      batchesReceived: receiver.batches.length,
    };
  } finally {
    const shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    if (child.connected) child.send('shutdown');
    else child.kill();
    try {
      await exited;
    } finally {
      clearTimeout(shutdownTimer);
      if (configured) await telemetry.shutdown();
    }
  }
}

if (
  typeof require !== 'undefined'
    ? require.main === module
    : process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const task =
    process.argv[2] === '--worker'
      ? worker(process.argv[3]!)
      : businessWorkflow().then((result) =>
          console.log(JSON.stringify(result)),
        );
  task.catch(() => {
    console.error(
      'Synthetic business workflow failed; check local runtime and delivery receipts.',
    );
    process.exitCode = 1;
  });
}
