import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '@openai/agents-codex';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('projects transferred native history while preserving the canonical conversation', async () => {
  const secret = 'synthetic-private-source-note';
  const summary = 'Approved transfer summary: help with billing.';
  const destinationInstructions = 'B_DESTINATION: answer the billing request.';
  const server = new ModelServer([
    (request) => {
      expect(JSON.stringify(request.input)).toContain(secret);
      return [call('transfer_to_b', {}, { callId: 'transfer-history' })];
    },
    (request) => {
      expect(JSON.stringify(request)).toContain(destinationInstructions);
      const input = JSON.stringify(request.input);
      expect(input).not.toContain(secret);
      expect(input).toContain(summary);
      expect(input).toContain('transfer-history');
      expect(input).toContain('function_call_output');
      return [message('Billing answer from B')];
    },
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-handoff-history-key',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
  const destination = new Agent({
    name: 'B',
    model: 'gpt-5.5',
    instructions: destinationInstructions,
  });
  await using session = await new Agent({
    name: 'A',
    model: 'gpt-5.5',
    instructions: 'A_SOURCE: transfer the billing request to B.',
    handoffs: [destination],
    provider,
  }).session();
  const preparations: boolean[] = [];
  const turn = await session.submit(`Help with billing. ${secret}`, {
    prepareRequest: ({ request }) => {
      const transferred = request.input.some(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          item.type === 'function_call_output' &&
          item.call_id === 'transfer-history',
      );
      preparations.push(transferred);
      if (!transferred) return undefined;
      return {
        ...request,
        input: [
          ...request.input.filter(
            (item) => !JSON.stringify(item).includes(secret),
          ),
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: summary }],
          },
        ],
      };
    },
  });
  expect((await turn.wait()).finalOutput).toBe('Billing answer from B');
  expect(await session.getActiveAgent()).toBe(destination);
  expect(preparations).toEqual([false, true]);
  expect(server.requests).toHaveLength(2);
  const saved = JSON.stringify(await session.saveState());
  expect(saved).toContain(secret);
  expect(saved).not.toContain(summary);
  server.assertExhausted();
});
