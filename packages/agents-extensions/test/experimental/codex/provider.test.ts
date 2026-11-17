import { Agent, Runner, UserError } from '@openai/agents';
import { CodexProvider } from '../../../src/experimental/codex';
import { expect, test, vi } from 'vitest';

const codex = vi.hoisted(() => {
  const run = vi.fn();
  const startThread = vi.fn();
  return { run, startThread, constructor: vi.fn() };
});

// Replace only the Codex SDK boundary. Both Runner paths use the real model adapter.
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      codex.constructor(options);
    }

    startThread = codex.startThread;
  },
}));

test('returns Codex text and usage through both Runner paths', async () => {
  const usage = {
    input_tokens: 17,
    cached_input_tokens: 3,
    cache_write_input_tokens: 5,
    output_tokens: 12,
    reasoning_output_tokens: 4,
  };
  const text = 'Previous value: 42.';
  codex.run.mockResolvedValue({
    items: [{ type: 'agent_message', id: 'message', text }],
    finalResponse: text,
    usage,
  });
  codex.startThread
    .mockReturnValueOnce({ id: 'thread-1', run: codex.run })
    .mockReturnValueOnce({ id: 'thread-2', run: codex.run });

  const modelProvider = new CodexProvider({
    threadOptions: { workingDirectory: '/workspace' },
  });
  const agent = new Agent({
    name: 'assistant',
    instructions: 'Keep the answer concise.',
  });
  const runner = new Runner({ modelProvider, tracingDisabled: true });
  const initial = await runner.run(agent, 'Remember 42.');
  const streamed = await runner.run(
    agent,
    [...initial.history, { role: 'user', content: 'What was the value?' }],
    { stream: true },
  );

  const deltas: string[] = [];
  for await (const event of streamed) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      deltas.push(event.data.delta);
    }
  }
  expect(deltas).toEqual([text]);
  for (const result of [initial, streamed]) {
    expect(result.finalOutput).toBe(text);
    expect(result.state.usage).toMatchObject({
      inputTokens: 17,
      outputTokens: 12,
      totalTokens: 29,
      inputTokensDetails: [{ cached_tokens: 3, cache_write_tokens: 5 }],
      outputTokensDetails: [{ reasoning_tokens: 4 }],
    });
  }
  expect(initial.lastResponseId).toBe('thread-1');
  expect(streamed.lastResponseId).toBe('thread-2');
  expect(codex.startThread).toHaveBeenCalledTimes(2);
  expect(codex.startThread).toHaveBeenCalledWith({
    workingDirectory: '/workspace',
    model: undefined,
  });
  expect(codex.constructor).toHaveBeenCalledWith({
    configOverrides: ['developer_instructions="Keep the answer concise."'],
  });
  expect(codex.run.mock.calls[0][0]).toBe('Remember 42.');
  expect(codex.run.mock.calls[1][0]).toContain(
    '[{"role":"user","text":"Remember 42."},{"role":"assistant","text":"Previous value: 42."}]',
  );
  expect(codex.run.mock.calls[1][0]).toContain('What was the value?');
});

test('rejects SDK conversation IDs before constructing Codex', async () => {
  codex.constructor.mockClear();
  const runner = new Runner({
    modelProvider: new CodexProvider(),
    tracingDisabled: true,
  });
  const agent = new Agent({ name: 'assistant' });

  await expect(
    runner.run(agent, 'Continue.', { previousResponseId: 'resp_123' }),
  ).rejects.toThrow(UserError);
  expect(codex.constructor).not.toHaveBeenCalled();
});

test('rejects multimodal input before constructing Codex', async () => {
  codex.constructor.mockClear();
  const runner = new Runner({
    modelProvider: new CodexProvider(),
    tracingDisabled: true,
  });
  const agent = new Agent({ name: 'assistant' });

  await expect(
    runner.run(agent, [
      {
        role: 'user',
        content: [{ type: 'input_image', image: 'https://example.com/a.png' }],
      },
    ]),
  ).rejects.toThrow(
    'CodexProvider accepts only user and assistant text messages.',
  );
  expect(codex.constructor).not.toHaveBeenCalled();
});
