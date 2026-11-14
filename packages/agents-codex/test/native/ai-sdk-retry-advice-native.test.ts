import { expect, it, vi } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';

it.each([
  { stream: false, suggested: true },
  { stream: false, suggested: false },
  { stream: true, suggested: true },
  { stream: true, suggested: false },
])(
  'preserves AI SDK retry diagnostics without granting replay authority ($stream, $suggested)',
  async ({ stream, suggested }) => {
    const failure = Object.assign(new Error('provider fixture is busy'), {
      isRetryable: suggested,
      statusCode: 503,
      responseHeaders: { 'retry-after': '2' },
    });
    let calls = 0;
    const model = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.retry',
        modelId: 'fixture',
        doGenerate() {
          calls++;
          throw failure;
        },
        doStream() {
          calls++;
          throw failure;
        },
      },
      {},
      { stream },
    );
    const policy = vi.fn(() => ({ retry: false }));
    await using provider = new NativeProvider({ modelBackend: model });
    const agent = new Agent({
      model: 'fixture',
      instructions: 'Answer.',
      provider,
      modelSettings: { retry: { maxRetries: 1, policy } },
    });

    await expect(agent.run('begin')).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(policy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        error: failure,
        stream,
        normalizedError: expect.objectContaining({
          statusCode: 503,
          retryAfterMs: 2000,
        }),
        providerAdvice: expect.objectContaining({
          suggested,
          reason: failure.message,
        }),
      }),
    );
  },
);
