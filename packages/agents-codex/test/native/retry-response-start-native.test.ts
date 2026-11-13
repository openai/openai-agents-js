import { expect, it } from 'vitest';
import { Agent, NativeProvider, type RetryContext } from '../../src';

// The native callback exchange, not a host retry loop, owns actual attempts.
it.each([
  ['unknown', undefined, 'safe'],
  ['explicit false', false, 'safe'],
  ['unsafe replay', false, 'unsafe'],
] as const)(
  'retries an external model only with explicit safe response evidence (%s)',
  async (_label, responseStarted, replaySafety) => {
    const original = new Error('synthetic external model failure');
    let attempts = 0;
    const seen: RetryContext[] = [];
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          if (++attempts === 1) throw original;
          return {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'recovered' }],
              },
            ],
          };
        },
        getRetryAdvice() {
          return {
            suggested: true,
            replaySafety,
            responseStarted,
            normalized: {
              statusCode: 429,
              requestId: 'provider-fact',
              isAbort: false,
            },
          };
        },
      },
    });
    const result = new Agent({
      instructions: 'Answer.',
      model: 'custom-model',
      provider,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, maxDelayMs: 0 },
          policy(context) {
            seen.push(context);
            expect(context.normalizedError.statusCode).toBe(429);
            expect(context.normalizedError.requestId).toBe('provider-fact');
            return {
              retry:
                !context.responseStarted &&
                context.providerAdvice?.responseStarted === false,
            };
          },
        },
      },
    }).run('Reply.');
    if (responseStarted === false && replaySafety === 'safe') {
      expect((await result).finalOutput).toBe('recovered');
      expect(attempts).toBe(2);
    } else {
      await expect(result).rejects.toBe(original);
      expect(attempts).toBe(1);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].responseStarted).toBe(false);
    expect(seen[0].providerAdvice?.responseStarted).toBe(responseStarted);
  },
);
