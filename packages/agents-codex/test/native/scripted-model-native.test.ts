import { expect, it } from 'vitest';
import { Agent, NativeProvider, type ModelResponse } from '@openai/agents';
import { ScriptedModel } from '@openai/agents/testing';

const response = (value: string): ModelResponse => ({
  output: [
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_scripted',
      content: [{ type: 'output_text', text: value, annotations: [] }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
});

it('returns a native result and usage from the public finite model script', async () => {
  const model = new ScriptedModel([response('scripted native result')]);
  await using provider = new NativeProvider({ modelBackend: model });
  const result = await new Agent({
    instructions: 'Answer.',
    model: 'custom-model',
    provider,
  }).run('go');
  expect(result.finalOutput).toBe('scripted native result');
  expect(result.runUsage.inputTokens).toBe(3);
  model.assertComplete();
});

it('keeps the identical scripted error through the native failure path', async () => {
  const error = new Error('synthetic exact failure');
  const model = new ScriptedModel([{ type: 'error', error }]);
  await using provider = new NativeProvider({ modelBackend: model });
  await expect(
    new Agent({ instructions: 'Answer.', model: 'custom-model', provider }).run(
      'go',
    ),
  ).rejects.toBe(error);
  model.assertComplete();
});

it('distinguishes unused steps from native script exhaustion', async () => {
  const model = new ScriptedModel([response('first result')]);
  expect(() => model.assertComplete()).toThrow('Unconsumed');
  await using provider = new NativeProvider({ modelBackend: model });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'custom-model',
    provider,
  });
  expect((await agent.run('first')).finalOutput).toBe('first result');
  await expect(agent.run('extra')).rejects.toThrow(
    'Unexpected scripted model call',
  );
  model.assertComplete();
});

it('correlates the exact native error and advice before Core retries', async () => {
  const error = new Error('synthetic retry failure');
  let decisions = 0;
  const model = new ScriptedModel([
    {
      type: 'error',
      error,
      retryAdvice: {
        suggested: true,
        replaySafety: 'safe',
        reason: 'scripted advice',
      },
    },
    response('retried result'),
  ]);
  await using provider = new NativeProvider({ modelBackend: model });
  const result = await new Agent({
    instructions: 'Answer.',
    model: 'custom-model',
    provider,
    modelSettings: {
      retry: {
        maxRetries: 1,
        backoff: { initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        policy(context) {
          expect(context.error).toBe(error);
          expect(context.providerAdvice?.reason).toBe('scripted advice');
          decisions++;
          return { retry: true, delayMs: 0 };
        },
      },
    },
  }).run('go');
  expect(result.finalOutput).toBe('retried result');
  expect(decisions).toBe(1);
  expect(result.runUsage.requests).toBe(2);
  model.assertComplete();
});
