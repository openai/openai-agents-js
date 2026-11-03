import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  tool,
  type ToolContext,
} from '@openai/agents';
import { ModelServer, message } from './fixtures/model-server';

// ScriptedResponses intentionally does not manufacture native code cells.
const cell = (input: string) => ({
  type: 'custom_tool_call',
  name: 'exec',
  call_id: 'original-cell',
  input,
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-code-interruption',
    supportsWebsockets: false,
  });
}
afterEach(() => ModelServer.closeAll());

function testDeadline() {
  const expired = Promise.withResolvers<never>();
  // Observe expiry even between waits; the Session still owns cancellation.
  void expired.promise.catch(() => {});
  const timer = setTimeout(
    () => expired.reject(new Error('Code interruption deadline exceeded')),
    20_000,
  );
  return {
    wait: <T>(value: Promise<T>) => Promise.race([value, expired.promise]),
    [Symbol.dispose]() {
      clearTimeout(timer);
    },
  };
}

it.each(['before', 'during'] as const)(
  'cancels the original code owner %s an application effect and joins cleanup',
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), 'code-interruption-'));
    const effectPath = join(directory, 'effect.txt');
    const entered = Promise.withResolvers<ToolContext>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = false;
    const server = new ModelServer([
      [cell('text(await tools.record({}));')],
      [message('continued')],
    ]);
    try {
      await using provider = await providerFor(server);
      const record = tool({
        name: 'record',
        description: 'Record one synthetic application effect.',
        parameters: z.strictObject({}),
        execute: async (_args, info) => {
          let abort: (() => void) | undefined;
          try {
            if (boundary === 'during') await appendFile(effectPath, 'effect\n');
            entered.resolve(info);
            await new Promise<never>((_resolve, reject) => {
              abort = () => reject(info.signal.reason);
              info.signal.addEventListener('abort', abort, { once: true });
              if (info.signal.aborted) abort();
            });
            if (boundary === 'before') await appendFile(effectPath, 'effect\n');
            return 'committed application result';
          } finally {
            if (abort) info.signal.removeEventListener('abort', abort);
            cleaning.resolve();
            await release.promise;
            cleaned = true;
          }
        },
      });
      const agent = new Agent({
        instructions: 'Use record from code.',
        provider,
        tools: [record],
        programmaticToolCalling: true,
      });
      await using session = await agent.session();
      using deadline = testDeadline();
      try {
        const turn = await deadline.wait(session.submit('Run the cell.'));
        const outcome = turn.wait().then(
          () => undefined,
          (error: unknown) => error,
        );
        const info = await deadline.wait(
          Promise.race([
            entered.promise,
            outcome.then((error) => {
              throw error ?? new Error('Turn completed before the gate');
            }),
          ]),
        );
        expect(info.submission).toBe(turn);
        expect(info.call).toMatchObject({
          route: 'code',
          sessionId: session.id,
          turnId: turn.turnId,
          callId: null,
          outerCallId: null,
          childId: null,
          cellId: expect.any(String),
          nestedCallId: expect.any(String),
        });
        expect(info.call!.cellId).not.toBe(info.call!.nestedCallId);
        let stopped = false;
        const stopping = turn.cancel().then(() => {
          stopped = true;
        });
        await deadline.wait(cleaning.promise);
        try {
          expect(stopped).toBe(false);
          expect(cleaned).toBe(false);
        } finally {
          release.resolve();
        }
        await deadline.wait(stopping);
        expect(await deadline.wait(outcome)).toBeInstanceOf(Error);
        expect(cleaned).toBe(true);
        const effects = () =>
          readFile(effectPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '';
            throw error;
          });
        expect(await effects()).toBe(boundary === 'before' ? '' : 'effect\n');
        expect(server.requests).toHaveLength(1);
        const next = await deadline.wait(
          session.submit('Continue without another effect.'),
        );
        expect((await deadline.wait(next.wait())).finalOutput).toBe(
          'continued',
        );
        expect(JSON.stringify(server.requests[1].input)).not.toContain(
          'committed application result',
        );
        expect(await effects()).toBe(boundary === 'before' ? '' : 'effect\n');
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    } finally {
      release.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it('refuses a portable manual checkpoint while a real code cell is active', async () => {
  const server = new ModelServer([[cell('text(await tools.decision({}));')]]);
  await using provider = await providerFor(server);
  const decision = manualTool({
    name: 'decision',
    description: 'Wait for the application decision.',
    parameters: z.strictObject({}),
    result: z.string(),
  });
  const agent = new Agent({
    instructions: 'Ask decision from code.',
    provider,
    tools: [decision],
    programmaticToolCalling: true,
  });
  await using session = await agent.session();
  using deadline = testDeadline();
  const turn = await deadline.wait(session.submit('Run the cell.'));
  const outcome = turn.wait().then(
    () => undefined,
    (error: unknown) => error,
  );
  const request = await deadline.wait(
    Promise.race([
      (async () => {
        for await (const event of session.events()) {
          const request = decision.match(event);
          if (request) return request;
        }
        throw new Error('Code cell did not request its manual decision');
      })(),
      outcome.then((error) => {
        throw error ?? new Error('Turn completed before requesting a decision');
      }),
    ]),
  );
  expect(request.call).toMatchObject({
    route: 'code',
    sessionId: session.id,
    turnId: turn.turnId,
    cellId: expect.any(String),
    nestedCallId: expect.any(String),
  });
  const stale = request.reply('stale');
  await expect(deadline.wait(session.suspend())).rejects.toThrow(
    'code-mode session has active cells',
  );
  await deadline.wait(turn.cancel());
  expect(await deadline.wait(outcome)).toBeInstanceOf(Error);
  await expect(deadline.wait(session.respond(stale))).rejects.toThrow();
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
}, 30_000);
