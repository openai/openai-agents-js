import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/openaiProvider';
import { withResponsesWebSocketSession } from '../src/responsesWebSocketSession';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withResponsesWebSocketSession cleanup failures', () => {
  it('attaches cleanup failure metadata to a mutable callback error', async () => {
    const callbackError = new Error('callback failed');
    const cleanupError = new Error('cleanup failed');
    vi.spyOn(OpenAIProvider.prototype, 'close').mockRejectedValue(cleanupError);

    await expect(
      withResponsesWebSocketSession(() => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expect((callbackError as Error & { cause?: unknown }).cause).toBe(
      cleanupError,
    );
  });

  it('preserves a frozen callback error when cleanup metadata cannot be attached', async () => {
    const callbackError = Object.freeze(new Error('callback failed'));
    const cleanupError = new Error('cleanup failed');
    vi.spyOn(OpenAIProvider.prototype, 'close').mockRejectedValue(cleanupError);

    await expect(
      withResponsesWebSocketSession(() => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
  });
});
