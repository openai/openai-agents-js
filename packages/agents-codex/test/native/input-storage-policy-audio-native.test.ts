import { expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type UserMessage } from '../../src';

vi.mock('../../src/runtime/media', async (original) => ({
  ...(await original<typeof import('../../src/runtime/media')>()),
  MAX_AUDIO_INPUT_BYTES: 1024,
}));

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const audio = (size: number): UserMessage => ({
  role: 'user',
  content: [
    {
      type: 'input_audio',
      audio_url: `data:audio/wav;base64,${'A'.repeat(size)}`,
    },
  ],
});
const answer = () => ({
  output: [
    {
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{ type: 'output_text' as const, text: 'accepted' }],
    },
  ],
});

nativeIt.each(['audio budget', 'encoded envelope'] as const)(
  'rejects projected run audio exceeding the combined initial-history %s',
  async (kind) => {
    const complete = vi.fn(answer);
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'synthetic-input-storage-policy',
      modelBackend: { complete },
    });
    const project = vi.fn(() => audio(600));
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'custom-model',
      provider,
      modelSettings: { inputModalities: ['text', 'audio'] },
    });
    await expect(
      agent.run('original', {
        initialMessages: [
          kind === 'audio budget'
            ? audio(600)
            : { role: 'assistant', content: 'p'.repeat(600) },
        ],
        inputStoragePolicy: project,
      }),
    ).rejects.toThrow(RangeError);
    expect(project).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  },
);

nativeIt(
  'budgets the projected run input instead of adding the original audio twice',
  async () => {
    const complete = vi.fn(answer);
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'synthetic-input-storage-policy',
      modelBackend: { complete },
    });
    const result = await new Agent({
      instructions: 'Answer.',
      model: 'custom-model',
      provider,
      modelSettings: { inputModalities: ['text', 'audio'] },
    }).run(audio(400), {
      initialMessages: [audio(200)],
      inputStoragePolicy: () => audio(400),
    });
    expect(result.finalOutput).toBe('accepted');
    expect(complete).toHaveBeenCalledTimes(1);
  },
);

nativeIt(
  'keeps ordinary Session projection on its existing current-input budget',
  async () => {
    const complete = vi.fn(answer);
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'synthetic-input-storage-policy',
      modelBackend: { complete },
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'custom-model',
      provider,
      modelSettings: { inputModalities: ['text', 'audio'] },
    }).session({ initialMessages: [audio(600)] });
    const turn = await session.submit('original', {
      inputStoragePolicy: () => audio(600),
    });
    expect((await turn.wait()).finalOutput).toBe('accepted');
    expect(complete).toHaveBeenCalledTimes(1);
  },
);
