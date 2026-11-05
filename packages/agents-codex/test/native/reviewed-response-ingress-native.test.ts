import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'reviewed native response decoding',
  () => {
    it('fails malformed later output without returning commentary or repeating a committed effect', async () => {
      let effects = 0;
      const effect = tool({
        name: 'effect',
        description: 'Record one synthetic effect.',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'effect-recorded-once';
        },
      });
      const server = new ModelServer([
        [call('effect', {}, { callId: 'committed-effect' })],
        [
          message('earlier commentary'),
          {
            type: 'message',
            id: 'private-malformed-output',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'private-refusal-payload' }],
          },
        ],
        [message('successor usable')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-reviewed-decoding',
      });
      const agent = new Agent({
        instructions: 'Use the requested synthetic tool.',
        model: 'gpt-5',
        provider,
        tools: [effect],
      });
      await using session = await agent.session();
      const turn = await session.submit('Record one effect.');
      const failure = await turn.wait().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(
        'Native model response ended without complete supported output',
      );
      expect(String(failure)).not.toContain('private-');
      expect(effects).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(
        (await (await session.submit('Continue.')).wait()).finalOutput,
      ).toBe('successor usable');
      expect(effects).toBe(1);
      expect(JSON.stringify(server.requests[2])).not.toContain('private-');
      server.assertExhausted();
    });
  },
);
