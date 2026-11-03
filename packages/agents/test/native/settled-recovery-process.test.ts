import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

// Bounds include startup and teardown. Root TS build and matching native products are prerequisites.
const CHILD_TIMEOUT = 40_000;
const CASE_TIMEOUT = 150_000;
const fixture = fileURLToPath(
  new URL('./fixtures/settled-recovery-process.mjs', import.meta.url),
);
type Phase = 'before' | 'during' | 'after';
type Binding = {
  sourceActor: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: { orderId: string };
};
const cell = (input: string, callId: string): JsonObject => ({
  type: 'custom_tool_call',
  name: 'exec',
  call_id: callId,
  input,
});
async function durable(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o444);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// The application service outlives every SDK host. It deliberately has no retry/deduplication engine.
async function effectService(directory: string, phase: Phase) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let dispatches = 0;
  let lookups = 0;
  let receiptReads = 0;
  let active = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const binding = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Binding)
        : undefined;
      if (request.method === 'POST' && request.url === '/lookup') {
        lookups++;
        response.writeHead(503).end('Unknown external outcome');
      } else if (request.method === 'GET' && request.url === '/receipt') {
        receiptReads++;
        try {
          const receipt = await readFile(
            join(directory, 'receipt.json'),
            'utf8',
          );
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(receipt);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // Absence is authoritative only if there is also no committed effect or active request.
          const absent = await readFile(join(directory, 'effect.json')).then(
            () => false,
            (failure: NodeJS.ErrnoException) => {
              if (failure.code !== 'ENOENT') throw failure;
              return true;
            },
          );
          response.writeHead(absent && !active ? 404 : 503).end();
        }
      } else if (request.method === 'POST' && request.url === '/effect') {
        dispatches++;
        active = true;
        const original = await json(join(directory, 'original.json'));
        const closed = await json(join(directory, 'closed.json'));
        if (
          JSON.stringify(binding) !== JSON.stringify(original.binding) ||
          !closed.closed
        )
          throw new Error(
            'Dispatch without the original durable binding and closed Session',
          );
        await durable(join(directory, 'effect.json'), {
          binding,
          applied: 'fulfilled',
        });
        entered.resolve();
        if (phase === 'during') await release.promise;
        const receipt = {
          binding,
          result: { orderId: 'order-42', status: 'fulfilled' },
        };
        await durable(join(directory, 'receipt.json'), receipt);
        active = false;
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(receipt));
        finished.resolve();
      } else response.writeHead(404).end();
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end('Effect service failed');
      finished.resolve();
      entered.resolve();
    }
  });
  server.requestTimeout = 20_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing service address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    entered: entered.promise,
    finished: finished.promise,
    release: () => release.resolve(),
    failures,
    counts: () => ({ dispatches, lookups, receiptReads }),
    async close() {
      release.resolve();
      if (active) await finished.promise;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
function launch(config: object) {
  const child = spawn(process.execPath, [fixture, JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT);
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
  // Observe failures immediately, including when a gate is awaited first.
  void done.catch(() => {});
  return {
    child,
    done,
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      try {
        await done;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'settled VM/application effect process recovery',
  () => {
    it.each(['before', 'during', 'after'] as const)(
      'reconciles interruption %s the external effect without replay',
      async (phase) => {
        const directory = await mkdtemp(
          join(tmpdir(), 'agents-settled-process-'),
        );
        const children: ReturnType<typeof launch>[] = [];
        const model = new ModelServer([
          [
            cell(
              "store('value',{n:7,a:[null,true,'雪']}); store('seed',await tools.seed({})); text('seed-cell-settled');",
              'original-cell',
            ),
          ],
          [message('seeded')],
          [
            call(
              'external_effect',
              { orderId: 'order-42' },
              { callId: 'external-call' },
            ),
          ],
          [
            cell(
              "const value=load('value'); if(Object.keys(value).sort().join(',')!=='a,n' || value.n!==7 || JSON.stringify(value.a)!==JSON.stringify([null,true,'雪'])) throw new Error('Stored JSON changed: '+JSON.stringify(value)); text(JSON.stringify([load('seed'),value]));",
              'read-stored',
            ),
          ],
          [message('recovered')],
        ]);
        const service = await effectService(directory, phase);
        const failures: unknown[] = [];
        try {
          const config = await model.config();
          const modelUrl = (
            config['model_providers.fixture'] as { base_url: string }
          ).base_url;
          const run = (mode: string) => {
            const worker = launch({
              directory,
              phase,
              mode,
              modelUrl,
              effectUrl: service.url,
            });
            children.push(worker);
            return worker;
          };
          const source = run('prepare');
          if (phase === 'during') {
            await Promise.race([
              service.entered,
              source.done.then((result) => {
                throw new Error(
                  `Source ended before effect gate: ${JSON.stringify(result)}`,
                );
              }),
            ]);
            source.child.kill('SIGKILL');
            expect((await source.done).signal).toBe('SIGKILL');
            // The service has committed an effect but has not published its receipt.
            expect(await json(join(directory, 'effect.json'))).toHaveProperty(
              'applied',
              'fulfilled',
            );
            await expect(
              readFile(join(directory, 'receipt.json')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
          } else {
            const result = await source.done;
            expect(result, result.output).toMatchObject({
              code: 23,
              signal: null,
            });
          }
          const originalBytes = await readFile(
            join(directory, 'original.json'),
            'utf8',
          );
          const original = JSON.parse(originalBytes);
          const saved = JSON.parse(original.checkpoint);
          expect(original.pid).toBe(source.child.pid);
          expect(await json(join(directory, 'closed.json'))).toEqual({
            pid: original.pid,
            sourceActor: original.binding.sourceActor,
            closed: true,
          });
          expect(saved.format_version).toBe(7);
          expect(saved.manual_continuation).toMatchObject({
            turn_id: original.binding.turnId,
            reply_order: ['external-call'],
            accepted_replies: {},
          });
          expect(saved.root_code_mode.stored_values).toEqual({
            value: { n: 7, a: [null, true, '雪'] },
            seed: 'committed-seed-result',
          });
          expect(model.requests).toHaveLength(3);
          expect(service.counts().dispatches).toBe(phase === 'before' ? 0 : 1);

          const unknown = run('unknown');
          const refused = await unknown.done;
          expect(refused, refused.output).toMatchObject({
            code: 0,
            signal: null,
          });
          expect(await json(join(directory, 'refused.json'))).toMatchObject({
            pid: unknown.child.pid,
            status: 'unknown',
            decision: 'refuse',
            sdkImported: false,
            dispatches: 0,
          });
          expect(model.requests).toHaveLength(3);
          expect(service.counts()).toMatchObject({
            dispatches: phase === 'before' ? 0 : 1,
            lookups: 1,
            receiptReads: 0,
          });
          expect(
            (await readFile(join(directory, 'seed-runs.txt'), 'utf8'))
              .trim()
              .split('\n'),
          ).toEqual([String(original.pid)]);

          // Parent/application explicitly reconciles. The SDK never looks up or retries the effect.
          if (phase === 'during') {
            service.release();
            await service.finished;
          }
          let authoritative = await fetch(`${service.url}/receipt`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (phase === 'before') {
            expect(authoritative.status).toBe(404);
            // Persist the explicit application policy after authoritative absence, before dispatch.
            await durable(join(directory, 'absence-policy.json'), {
              binding: original.binding,
              selectedBy: 'parent-application',
              policy: 'dispatch-on-authoritative-absence',
            });
            const dispatched = await fetch(`${service.url}/effect`, {
              method: 'POST',
              body: JSON.stringify(original.binding),
              signal: AbortSignal.timeout(5_000),
            });
            expect(dispatched.status).toBe(200);
            await dispatched.arrayBuffer();
            authoritative = await fetch(`${service.url}/receipt`, {
              signal: AbortSignal.timeout(5_000),
            });
          }
          expect(authoritative.status).toBe(200);
          const receipt = (await authoritative.json()) as {
            binding: Binding;
            result: { orderId: string; status: string };
          };
          expect(receipt).toEqual({
            binding: original.binding,
            result: { orderId: 'order-42', status: 'fulfilled' },
          });
          const effectBytes = await readFile(
            join(directory, 'effect.json'),
            'utf8',
          );
          expect(JSON.parse(effectBytes)).toEqual({
            binding: original.binding,
            applied: 'fulfilled',
          });
          await durable(join(directory, 'decision.json'), {
            ...receipt,
            selectedBy: 'parent-application',
            policy: 'reply-recorded-result',
          });
          const recovered = run('recover');
          const result = await recovered.done;
          expect(result, result.output).toMatchObject({
            code: 0,
            signal: null,
          });
          const terminal = await json(join(directory, 'recovered.json'));
          expect(
            new Set([original.pid, unknown.child.pid, terminal.pid]).size,
          ).toBe(3);
          expect(terminal.pid).toBe(recovered.child.pid);
          expect(terminal.physicalSession).not.toBe(
            original.binding.sourceActor,
          );
          expect(terminal.binding).toEqual(original.binding);
          expect(terminal.fresh).toMatchObject({
            sessionId: terminal.physicalSession,
            turnId: original.binding.turnId,
            callId: original.binding.callId,
          });
          expect(terminal.fresh.submissionId).not.toBe(original.submissionId);
          expect(terminal.state.root_code_mode.stored_values).toEqual(
            saved.root_code_mode.stored_values,
          );
          expect(
            BigInt(terminal.state.root_code_mode.next_cell_id),
          ).toBeGreaterThan(BigInt(saved.root_code_mode.next_cell_id));
          expect(terminal.turns).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: original.seedTurnId,
                status: 'completed',
              }),
              expect.objectContaining({
                id: original.binding.turnId,
                status: 'completed',
              }),
            ]),
          );
          const responseHistory = (history: JsonObject[]) =>
            history
              .filter((item) => item.type === 'response_item')
              .map((item) => item.payload);
          const prefix = responseHistory(saved.history);
          expect(prefix.length).toBeGreaterThan(0);
          expect(
            responseHistory(terminal.state.history).slice(0, prefix.length),
          ).toEqual(prefix);
          const input = model.requests[4].input as JsonObject[];
          const expected = [
            ['custom_tool_call', 'original-cell'],
            ['custom_tool_call_output', 'original-cell'],
            ['function_call', 'external-call'],
            ['function_call_output', 'external-call'],
            ['custom_tool_call', 'read-stored'],
            ['custom_tool_call_output', 'read-stored'],
          ];
          const indices = expected.map(([type, id]) => {
            const matches = input.flatMap((item, index) =>
              item.type === type && item.call_id === id ? [index] : [],
            );
            expect(matches).toHaveLength(1);
            return matches[0];
          });
          expect(indices).toEqual([...indices].sort((a, b) => a - b));
          expect(
            JSON.stringify(
              input.find(
                (item) =>
                  item.type === 'custom_tool_call_output' &&
                  item.call_id === 'read-stored',
              ),
            ),
          ).toContain('committed-seed-result');
          expect(
            JSON.stringify(
              input.find(
                (item) =>
                  item.type === 'custom_tool_call_output' &&
                  item.call_id === 'read-stored',
              ),
            ),
          ).toContain('雪');
          expect(
            JSON.stringify(
              input.find(
                (item) =>
                  item.type === 'function_call_output' &&
                  item.call_id === 'external-call',
              ),
            ),
          ).toContain('fulfilled');
          expect(
            (await readFile(join(directory, 'seed-runs.txt'), 'utf8'))
              .trim()
              .split('\n'),
          ).toEqual([String(original.pid)]);
          expect(service.counts().dispatches).toBe(1);
          expect(await readFile(join(directory, 'effect.json'), 'utf8')).toBe(
            effectBytes,
          );
          expect(await json(join(directory, 'receipt.json'))).toEqual(receipt);
          expect(service.failures).toEqual([]);
          expect(await readFile(join(directory, 'original.json'), 'utf8')).toBe(
            originalBytes,
          );
          model.assertExhausted();
        } catch (error) {
          failures.push(error);
        } finally {
          service.release();
          const cleanup = await Promise.allSettled([
            ...children.map((worker) => worker.close()),
            service.close(),
            ModelServer.closeAll(),
          ]);
          for (const result of cleanup)
            if (result.status === 'rejected') failures.push(result.reason);
          await rm(directory, { recursive: true, force: true }).catch(
            (error: unknown) => {
              failures.push(error);
            },
          );
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, 'Process harness failed');
      },
      CASE_TIMEOUT,
    );
  },
);
