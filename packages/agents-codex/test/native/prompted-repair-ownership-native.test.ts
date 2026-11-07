import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeProvider,
  OutputValidationError,
  tool,
  type MCPResultContext,
  type ObservedEvent,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const report = z.object({ label: z.string().min(2) });
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  vi.restoreAllMocks();
  await ModelServer.closeAll();
  if (failures.length)
    throw new AggregateError(failures, 'Ownership fixture cleanup failed');
});

// Same native HTTP MCP wire fixture as mcp-policy-native.test.ts. The peer
// records actual tools/call admission, rather than inferring it from a yield.
async function peer() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: JsonObject[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: JsonObject = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: (rpc.params as JsonObject).protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'repair-ownership-peer', version: '1' },
        };
      if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Read a record',
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
                additionalProperties: false,
              },
            },
          ],
        };
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params as JsonObject);
        entered.resolve();
        await release.promise;
        result = {
          content: [{ type: 'text', text: 'original-record-effect' }],
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer address');
  cleanup.push(async () => {
    release.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(failures).toEqual([]);
  });
  return {
    entered,
    release,
    calls,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-ownership-key',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  return provider;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native prompted repair preserves original ownership',
  () => {
    it.skipIf(process.platform !== 'linux')(
      'waits for a yielded MCP cell before accepting a change to writable roots',
      async () => {
        const executor = await startPublicExecutor();
        const originalRoots = [dirname(executor.cwd)];
        cleanup.push(() => executor.close());
        const remote = await peer();
        let cellId = '';
        const server = new ModelServer([
          [
            {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'pending-cell',
              input:
                'const pending = tools.mcp__records__lookup({key:"original"}); yield_control(); text(await pending);',
            },
          ],
          (request) => {
            const output = (request.input as JsonObject[]).find(
              (item) =>
                item.call_id === 'pending-cell' &&
                item.type === 'custom_tool_call_output',
            );
            const value = output?.output;
            const contents =
              typeof value === 'string'
                ? value
                : (value as JsonObject[] | undefined)
                    ?.map((item) => item.text ?? '')
                    .join('');
            const match = /Script running with cell ID ([^\s.]+)/.exec(
              contents ?? '',
            );
            if (!match) throw new Error('Expected a yielded MCP cell');
            cellId = match[1];
            return [message('Pending lookup')];
          },
          [message('Same roots')],
          () => [
            call(
              'wait',
              { cell_id: cellId, yield_time_ms: 10000 },
              { callId: 'collect-cell' },
            ),
          ],
          (request) => {
            expect(JSON.stringify(request.input)).toContain(
              'original-record-effect',
            );
            return [message('Lookup collected')];
          },
          [message('Changed roots')],
        ]);
        const provider = await providerFor(server);
        const session = await new Agent({
          provider,
          model: 'gpt-5.5',
          instructions: 'Look up the record.',
          programmaticToolCalling: true,
          tools: [
            new HttpMCP({
              name: 'records',
              url: remote.url,
              tools: ['lookup'],
              approvalMode: 'preapproved',
            }),
          ],
        }).session({
          environment: new Environment({
            url: executor.url,
            headers: executor.headers,
            cwd: executor.cwd,
            writableRoots: originalRoots,
            tools: ['exec_command'],
          }),
        });
        cleanup.push(() => session.close());
        async function run(
          input: string,
          options: { writableRoots?: string[] } = {},
        ) {
          const turn = await session.submit(input, options);
          return (await turn.wait()).finalOutput;
        }
        try {
          expect(await run('Start lookup')).toBe('Pending lookup');
          await remote.entered.promise;
          await expect(
            run('Change roots', { writableRoots: [] }),
          ).rejects.toThrow(/earlier executor work/);
          expect(server.requests).toHaveLength(2);
          expect(
            await run('Keep roots', { writableRoots: originalRoots }),
          ).toBe('Same roots');
          remote.release.resolve();
          expect(await run('Collect lookup')).toBe('Lookup collected');
          expect(await run('Change roots', { writableRoots: [] })).toBe(
            'Changed roots',
          );
          server.assertExhausted();
        } finally {
          remote.release.resolve();
        }
      },
      30000,
    );

    it.each([false, true])(
      'joins an actually admitted yielded original MCP result policy (fails=%s)',
      async (policyFails) => {
        const remote = await peer();
        const atRepair = Promise.withResolvers<void>();
        const releaseRepair = Promise.withResolvers<void>();
        const atPolicy = Promise.withResolvers<void>();
        const releasePolicy = Promise.withResolvers<void>();
        const correctionFinished = Promise.withResolvers<void>();
        const seen: MCPResultContext[] = [];
        const fixtureFailure = Promise.withResolvers<never>();
        fixtureFailure.promise.catch(() => {});
        const server = new ModelServer([
          [
            {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'original-cell',
              input:
                'const pending = tools.mcp__records__lookup({key:"original"}); yield_control(); text(await pending);',
            },
          ],
          async (request) => {
            // Inspect the actual custom-tool result before waiting for the peer.
            // A code-host failure must surface its output instead of looking
            // like a missing native MCP admission.
            const outputs = (request.input as JsonObject[]).filter(
              (item) =>
                item.type === 'custom_tool_call_output' &&
                item.call_id === 'original-cell',
            );
            expect(outputs, JSON.stringify(request.input)).toHaveLength(1);
            const output = outputs[0].output;
            const text =
              typeof output === 'string'
                ? output
                : (output as JsonObject[])
                    .map((item) => item.text ?? '')
                    .join('');
            expect(
              text,
              `Actual original code result: ${JSON.stringify(output)}`,
            ).toContain('Script running with cell ID ');
            await remote.entered.promise;
            return [message('{"label":"x"}')];
          },
          async (request) => {
            expect(request.tools ?? []).toEqual([]);
            expect(JSON.stringify(request.input)).not.toContain(
              'original-record-effect',
            );
            atRepair.resolve();
            await releaseRepair.promise;
            return [message('{"label":"corrected"}')];
          },
        ]);
        const provider = await providerFor(server);
        const session = await new Agent({
          instructions: 'Read a record.',
          model: 'gpt-5.5',
          provider,
          tools: [
            new HttpMCP({
              name: 'records',
              url: remote.url,
              tools: ['lookup'],
              approvalMode: 'preapproved',
              async transformResult(ctx, result) {
                seen.push(ctx);
                atPolicy.resolve();
                await releasePolicy.promise;
                if (policyFails)
                  throw new Error('private original callback error');
                return result;
              },
            }),
          ],
          programmaticToolCalling: true,
          outputType: { mode: 'prompted', schema: report, maxRetries: 2 },
        }).session();
        cleanup.push(() => session.close());
        const events: ObservedEvent[] = [];
        const phases: string[] = [];
        server.onRecord = (phase, detail) => {
          phases.push(phase);
          if (phase === 'MODEL_REQUEST_ERROR')
            fixtureFailure.reject(
              new Error(`Original model fixture failed: ${String(detail)}`),
            );
        };
        const prematureRoot = Promise.withResolvers<never>();
        prematureRoot.promise.catch(() => {});
        const waitForPhase = async (name: string, arrived: Promise<void>) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const diagnostic = () =>
            JSON.stringify({
              phase: name,
              modelRequests: server.requests.length,
              completedFrames: server.completedFrames.length,
              peerCalls: remote.calls.length,
              admittedResultPolicies: seen.length,
              originalContinuationInput: server.requests[1]?.input,
              phases,
              events: events.map((event) => ({
                type: event.type,
                ...('submissionId' in event
                  ? {
                      submissionId: event.submissionId,
                      parentSubmissionId:
                        'parentSubmissionId' in event
                          ? event.parentSubmissionId
                          : undefined,
                    }
                  : {}),
              })),
            });
          try {
            await Promise.race([
              arrived,
              prematureRoot.promise,
              fixtureFailure.promise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Native ownership phase did not arrive within 8s: ${diagnostic()}`,
                      ),
                    ),
                  8000,
                );
              }),
            ]);
          } catch (error) {
            throw new Error(
              `Native ownership phase ${name} failed: ${diagnostic()}`,
              {
                cause: error,
              },
            );
          } finally {
            clearTimeout(timer);
          }
        };
        const reading = (async () => {
          for await (const event of session.events()) {
            events.push(event);
            if (event.type === 'turn_finished' && event.parentSubmissionId)
              correctionFinished.resolve();
          }
        })();
        try {
          const root = await session.submit('original root');
          let settled = false;
          const outcome = root.wait().then(
            (result) => {
              settled = true;
              return { result };
            },
            (error: unknown) => {
              settled = true;
              return { error };
            },
          );
          void outcome.then((completed) => {
            prematureRoot.reject(
              new Error(
                'error' in completed
                  ? `Original root failed before the held ownership phase: ${String(completed.error)}`
                  : 'Original root completed before the held ownership phase',
              ),
            );
          });
          await waitForPhase(
            'original peer tools/call admission',
            remote.entered.promise,
          );
          await waitForPhase(
            'atRepair: correction model request admission',
            atRepair.promise,
          );
          remote.release.resolve();
          // Ownership begins at the actual native result-policy notice. Do not
          // add a barrier for an MCP call whose policy has not been admitted.
          await waitForPhase(
            'atPolicy: original result-policy callback admission',
            atPolicy.promise,
          );
          expect(seen[0].submission).toBe(root);
          expect(seen[0]).toMatchObject({
            serverName: 'records',
            toolName: 'lookup',
          });
          releaseRepair.resolve();
          await waitForPhase(
            'correctionFinished: linked correction terminal after response release',
            correctionFinished.promise,
          );
          expect(settled).toBe(false);
          expect(
            events.some(
              (event) =>
                event.type === 'turn_finished' &&
                event.submissionId === root.submissionId,
            ),
          ).toBe(false);
          expect(remote.calls).toHaveLength(1);
          expect(seen).toHaveLength(1);
          expect(server.requests).toHaveLength(3);
          releasePolicy.resolve();
          const completed = await outcome;
          if (policyFails) {
            if (!('error' in completed))
              throw new Error('Expected original policy failure');
            expect(String(completed.error)).toContain(
              'MCP result policy failed',
            );
            expect(String(completed.error)).not.toContain(
              'private original callback error',
            );
            expect(completed.error).not.toBeInstanceOf(OutputValidationError);
            await expect(root.wait()).rejects.toBe(completed.error);
          } else {
            if (!('result' in completed))
              throw new Error('Expected repaired result');
            expect(completed.result.finalOutput).toEqual({
              label: 'corrected',
            });
            expect(completed.result.repairAttempts).toHaveLength(1);
            expect(await root.wait()).toBe(completed.result);
          }
          expect(remote.calls).toHaveLength(1);
          expect(seen).toHaveLength(1);
          expect(server.requests).toHaveLength(3);
          server.assertExhausted();
        } finally {
          remote.release.resolve();
          releaseRepair.resolve();
          releasePolicy.resolve();
          await session.close();
          await reading;
        }
      },
      35000,
    );

    it.each(['approval-denied', 'before-error', 'callback-error'] as const)(
      'does not output-retry original %s',
      async (failureKind) => {
        const remote = await peer();
        const original = new Error('private original function failure');
        const callback = vi.fn(() => {
          throw original;
        });
        const server = new ModelServer([
          [
            failureKind === 'callback-error'
              ? call('failing', {}, { callId: 'original-callback' })
              : call(
                  'lookup',
                  { key: 'original' },
                  {
                    namespace: 'mcp__records',
                    callId: 'original-policy',
                  },
                ),
          ],
        ]);
        const provider = await providerFor(server);
        const policy = vi.fn(() => {
          if (failureKind === 'before-error')
            throw new Error('private original before failure');
          return false;
        });
        const session = await new Agent({
          instructions: 'Use the selected tool.',
          model: 'gpt-5.5',
          provider,
          tools: [
            new HttpMCP({
              name: 'records',
              url: remote.url,
              tools: ['lookup'],
              ...(failureKind === 'before-error'
                ? {
                    before: () => {
                      policy();
                      return { action: 'allow' as const };
                    },
                  }
                : { approvalMode: 'preapproved' as const, approval: policy }),
            }),
            tool({
              name: 'failing',
              parameters: z.object({}),
              execute: callback,
            }),
          ],
          outputType: { mode: 'prompted', schema: report, maxRetries: 3 },
        }).session();
        cleanup.push(() => session.close());
        const root = await session.submit('original');
        const failure = await root.wait().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(OutputValidationError);
        await expect(root.wait()).rejects.toBe(failure);
        if (failureKind === 'callback-error') {
          expect(callback).toHaveBeenCalledTimes(1);
          expect(failure).toBe(original);
          expect(policy).not.toHaveBeenCalled();
        } else {
          expect(policy).toHaveBeenCalledTimes(1);
          expect(callback).not.toHaveBeenCalled();
        }
        expect(remote.calls).toEqual([]);
        expect(server.requests).toHaveLength(1);
        expect(
          (await collect(session.turns())).filter(
            (turn) => 'parentTurnId' in turn,
          ),
        ).toEqual([]);
        server.assertExhausted();
      },
      25000,
    );
  },
);
