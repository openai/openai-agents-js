import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runner } from '@openai/agents-core';
import { OpenAIProvider } from '../src/openaiProvider';
import { OpenAIResponsesWSModel } from '../src/openaiResponsesModel';
import { withResponsesWebSocketSession } from '../src/responsesWebSocketSession';

const OpenAIMock = vi.hoisted(() =>
  vi.fn(function FakeOpenAI(this: any, config: any) {
    Object.assign(this, config);
    this.chat = { completions: { create: vi.fn() } };
    this.responses = { create: vi.fn(), compact: vi.fn() };
  }),
);

vi.mock('openai', () => ({
  default: OpenAIMock,
  OpenAI: OpenAIMock,
}));

class FakeClient {}

describe('withResponsesWebSocketSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    OpenAIMock.mockClear();
  });

  it('creates a websocket responses provider, exposes a bound run function, and closes on success', async () => {
    const runSpy = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue({ rawResponses: [] } as any);
    const closeSpy = vi
      .spyOn(OpenAIProvider.prototype, 'close')
      .mockResolvedValue(undefined);

    const result = await withResponsesWebSocketSession(
      async ({ provider, runner, run }) => {
        const model = await provider.getModel('gpt-4.1');
        expect(model).toBeInstanceOf(OpenAIResponsesWSModel);
        expect(runner.config.model).toBe('gpt-5.2-mini');

        const fakeAgent = {} as any;
        const fakeInput = 'hello' as any;
        await run(fakeAgent, fakeInput);

        const call = runSpy.mock.calls[0];
        expect(call?.[0]).toBe(fakeAgent);
        expect(call?.[1]).toBe(fakeInput);
        expect(runSpy.mock.instances[0]).toBe(runner);
        return 'ok';
      },
      {
        providerOptions: { openAIClient: new FakeClient() as any },
        runnerConfig: { model: 'gpt-5.2-mini' },
      },
    );

    expect(result).toBe('ok');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the provider when the callback throws', async () => {
    const closeSpy = vi
      .spyOn(OpenAIProvider.prototype, 'close')
      .mockResolvedValue(undefined);

    await expect(
      withResponsesWebSocketSession(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves the callback error when provider.close also fails', async () => {
    const closeError = new Error('close failed');
    const closeSpy = vi
      .spyOn(OpenAIProvider.prototype, 'close')
      .mockRejectedValue(closeError);

    const error = await withResponsesWebSocketSession(async () => {
      throw new Error('boom');
    }).catch((err: unknown) => err as Error & { cause?: unknown });

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(error.message).toBe('boom');
    expect(error.cause).toBe(closeError);
  });
});
