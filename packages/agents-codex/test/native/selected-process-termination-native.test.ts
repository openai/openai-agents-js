import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { Agent, Environment, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() => ModelServer.closeAll());

// The local Linux Codex sandbox deliberately masks the daemon socket directory.
// macOS CI exercises the real selected executor and its live shell process.
it
  .skipIf(process.platform !== 'darwin')
  .each(['accepted', 'rejected'] as const)(
  'waits for a delayed %s process termination response and sends one RPC through public teardown',
  async (acknowledgment) => {
    const entered = Promise.withResolvers<JsonObject>();
    const release = Promise.withResolvers<void>();
    const executor = await startPublicExecutor({
      captureProcessDiagnostics: true,
      async transformTerminateResponse(response) {
        entered.resolve(response);
        await release.promise;
        return acknowledgment === 'accepted'
          ? response
          : {
              id: response.id,
              error: {
                code: -32603,
                message: 'Synthetic termination acknowledgment rejected',
              },
            };
      },
    });
    const server = new ModelServer([
      [
        call(
          'exec_command',
          {
            cmd: 'printf "selected-live\\n"; read -r ignored',
            tty: true,
            yield_time_ms: 1000,
          },
          { callId: 'selected-live-process' },
        ),
      ],
      [message('process remains live')],
    ]);
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-selected-termination',
      supportsWebsockets: false,
    });
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    let liveSession: unknown;
    const terminations = () =>
      executor.requests.filter(
        (request) => request.method === 'process/terminate',
      );
    try {
      session = await new Agent({
        instructions: 'Use the scripted selected command.',
        model: 'gpt-5.5',
        provider,
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
          approval: () => true,
          transformResult(info, value) {
            if (info.toolName === 'exec_command') {
              expect(value).toMatchObject({
                session_id: expect.any(Number),
                output: expect.stringContaining('selected-live'),
              });
              expect((value as JsonObject).exit_code).toBeUndefined();
              liveSession = (value as JsonObject).session_id;
            }
            return value;
          },
        }),
      });
      expect(
        (await (await session.submit('Start the waiting shell.')).wait())
          .finalOutput,
      ).toBe('process remains live');
      expect(liveSession).toBeTypeOf('number');
      expect(terminations()).toHaveLength(0);
      let settled = false;
      const closing = session
        .close()
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          settled = true;
        });
      const upstream = await bounded(
        entered.promise,
        'Termination RPC did not receive a real upstream response',
      );
      expect(upstream.error).toBeUndefined();
      // `running: true` acknowledges a termination request for a live process.
      // It does not report the process's state after termination.
      expect(upstream.result).toMatchObject({ running: true });
      expect(terminations()).toHaveLength(1);
      const starts = executor.requests.filter(
        (request) => request.method === 'process/start',
      );
      expect(starts).toHaveLength(1);
      expect((terminations()[0]!.params as JsonObject).processId).toBe(
        (starts[0]!.params as JsonObject).processId,
      );
      await delay(50);
      expect(settled).toBe(false);
      release.resolve();
      const result = await bounded(
        closing,
        'Session.close did not join the termination acknowledgment',
      );
      expect(result.ok).toBe(acknowledgment === 'accepted');
      if (!result.ok)
        expect(String(result.error)).toMatch(
          /terminat|shutdown|cleanup|acknowledg/i,
        );
      // Command termination has one attempt: an already closed session does
      // not recheck its acknowledgment or issue another termination RPC.
      await expect(
        bounded(session.close(), 'Repeated close did not complete'),
      ).resolves.toBeUndefined();
      expect(terminations()).toHaveLength(1);
      await provider.close();
      await executor.close();
      await delay(50);
      expect(terminations()).toHaveLength(1);
      server.assertExhausted();
    } finally {
      release.resolve();
      await bounded(
        session?.close().catch(() => {}) ?? Promise.resolve(),
        'Session teardown timed out',
      );
      await provider.close();
      await executor.close();
    }
  },
  45_000,
);
