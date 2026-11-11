import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function providerFor(server: ModelServer) {
  const cfg = await server.config();
  return new NativeProvider({
    baseUrl: (cfg['model_providers.fixture'] as { base_url: string }).base_url,
    apiKey: 'synthetic-guardrail-capture',
    supportsWebsockets: false,
  });
}
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'guardrail input snapshot lifetime',
  () => {
    it.each(['run', 'submit', 'enqueue'] as const)(
      'avoids a redundant input snapshot without guards: %s',
      async (route) => {
        const input = {
          role: 'user' as const,
          content: [{ type: 'input_text' as const, text: 'question' }],
        };
        const server = new ModelServer([[message('done')]]);
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        });
        const clone = globalThis.structuredClone;
        const observe = () =>
          vi
            .spyOn(globalThis, 'structuredClone')
            .mockImplementation((value, options) => {
              if (value === input)
                throw new Error('Redundant guardrail input clone');
              return clone(value, options);
            });
        if (route === 'run') {
          observe();
          expect((await agent.run(input)).finalOutput).toBe('done');
        } else {
          await using session = await agent.session();
          observe();
          const turn =
            route === 'submit'
              ? await session.submit(input)
              : await session.enqueue(input);
          expect((await turn.wait()).finalOutput).toBe('done');
        }
        server.assertExhausted();
      },
      25000,
    );
    it('preserves detached original input for blocking and parallel checks', async () => {
      const input = {
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: 'before' }],
      };
      const server = new ModelServer([[message('done')]]);
      await using provider = await providerFor(server);
      const seen: string[] = [];
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        inputGuardrails: [
          {
            name: 'blocking',
            runInParallel: false,
            callback({ input: observed }) {
              const value = observed as typeof input;
              seen.push(value.content[0].text);
              value.content[0].text = 'guard-only';
              return { tripwireTriggered: false };
            },
          },
          {
            name: 'parallel',
            callback({ input: observed }) {
              seen.push((observed as typeof input).content[0].text);
              return { tripwireTriggered: false };
            },
          },
        ],
      });
      const pending = agent.run(input);
      input.content[0].text = 'caller-after';
      const result = await pending;
      expect(result.finalOutput).toBe('done');
      expect(seen).toEqual(['before', 'before']);
      expect(JSON.stringify(server.requests[0].input)).toContain('before');
      expect(JSON.stringify(server.requests[0].input)).not.toContain(
        'guard-only',
      );
      server.assertExhausted();
    }, 25000);
  },
);
