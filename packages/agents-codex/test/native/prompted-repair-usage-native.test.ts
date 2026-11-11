import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, OutputValidationError } from '../../src';
import { ModelServer, message } from './fixtures/model-server';
afterEach(async () => {
  await ModelServer.closeAll();
});
const schema = z.object({ label: z.string().min(2) });
const usage = (input: number, output: number) =>
  JSON.stringify({
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  });
async function open(server: ModelServer, maxRetries: number) {
  const cfg = await server.config();
  const provider = new NativeProvider({
    baseUrl: (cfg['model_providers.fixture'] as { base_url: string }).base_url,
    apiKey: 'synthetic-repair-usage',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    outputType: { mode: 'prompted', schema, maxRetries },
  });
  return { provider, session: await agent.session() };
}
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'prompted repair measured usage',
  () => {
    it('counts successful correction once while preserving thread usage and cached wait', async () => {
      const server = new ModelServer(
        [[message('{"label":"x"}')], [message('{"label":"corrected"}')]],
        [usage(5, 2), usage(8, 3)],
      );
      const opened = await open(server, 1);
      await using _provider = opened.provider;
      await using session = opened.session;
      const turn = await session.submit('root');
      const result = await turn.wait();
      expect(result.runUsage).toMatchObject({
        requests: 2,
        totalTokens: 18,
        missingUsageRequests: 0,
      });
      expect(turn.runUsage).toEqual(result.runUsage);
      expect(await turn.wait()).toBe(result);
      expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(7);
      expect(result.repairAttempts).toHaveLength(1);
      expect(result.repairAttempts[0].sessionId).not.toBe(session.id);
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 25000);
    it('retains all exhausted corrections and keeps the next root independent', async () => {
      const server = new ModelServer(
        [
          [message('{"label":"x"}')],
          [message('{"label":"y"}')],
          [message('{"label":"z"}')],
          [message('{"label":"next"}')],
        ],
        [usage(5, 2), usage(8, 3), usage(8, 5), usage(10, 7)],
      );
      const opened = await open(server, 2);
      await using _provider = opened.provider;
      await using session = opened.session;
      const turn = await session.submit('root');
      const failure = await turn.wait().catch((error) => error);
      expect(failure).toBeInstanceOf(OutputValidationError);
      expect(turn.runUsage).toMatchObject({
        requests: 3,
        totalTokens: 31,
        missingUsageRequests: 0,
      });
      await expect(turn.wait()).rejects.toBe(failure);
      const prior = turn.runUsage;
      const next = await (await session.submit('next root')).wait();
      expect(next.runUsage).toMatchObject({ requests: 1, totalTokens: 17 });
      expect(turn.runUsage).toEqual(prior);
      expect(server.requests).toHaveLength(4);
      server.assertExhausted();
    }, 25000);
    it('keeps unknown correction usage measured as an additional request', async () => {
      const server = new ModelServer(
        [[message('{"label":"x"}')], [message('{"label":"valid"}')]],
        [usage(5, 2)],
      );
      const opened = await open(server, 1);
      await using _provider = opened.provider;
      await using session = opened.session;
      const turn = await session.submit('root');
      const result = await turn.wait();
      expect(result.runUsage).toMatchObject({
        requests: 2,
        totalTokens: 7,
        missingUsageRequests: 1,
      });
      expect(turn.runUsage).toEqual(result.runUsage);
      server.assertExhausted();
    }, 25000);
  },
);
