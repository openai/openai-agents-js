import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type RetryContext } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

it.each([
  { failure: 'provider', approve: true, replays: false },
  { failure: 'provider-timeout', approve: true, replays: false },
  { failure: 'native-timeout', approve: false, replays: false },
  { failure: 'native-timeout', approve: true, replays: true },
])(
  'keeps provider-unsafe stream replay scoped to an explicitly approved timeout (%o)',
  async ({ failure, approve, replays }) => {
    const timeout = failure === 'native-timeout';
    let attempts = 0;
    const rejection = new Error('synthetic provider rejection');
    if (failure === 'provider-timeout') rejection.name = 'TimeoutError';
    const policy = vi.fn((context: RetryContext) => {
      expect(context.stream).toBe(true);
      expect(context.normalizedError.isTimeout).toBe(timeout);
      return { retry: true, delayMs: 0, approveUnsafeReplay: approve };
    });
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          throw new Error('Expected native producer streaming');
        },
        async *stream(request): AsyncGenerator<JsonObject> {
          if (++attempts === 1) {
            if (timeout)
              await delay(10_000, undefined, { signal: request.signal });
            throw rejection;
          }
          yield {
            type: 'response.created',
            response: { id: 'resp_recovered' },
          };
          yield {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_recovered',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Recovered.' }],
            },
          };
          yield {
            type: 'response.completed',
            response: { id: 'resp_recovered' },
          };
        },
        getRetryAdvice() {
          return {
            suggested: true,
            replaySafety: 'unsafe',
            responseStarted: false,
          };
        },
      },
    });
    const result = new Agent({
      instructions: 'Answer.',
      model: 'custom-model',
      provider,
      modelSettings: {
        attemptTimeoutMs: timeout ? 100 : undefined,
        invocationTimeoutMs: 2000,
        retry: { maxRetries: 1, policy },
      },
    }).run('Answer.');
    if (replays) {
      expect((await result).finalOutput).toBe('Recovered.');
    } else if (timeout) {
      await expect(result).rejects.toThrow();
    } else {
      await expect(result).rejects.toBe(rejection);
    }
    expect(attempts).toBe(replays ? 2 : 1);
    expect(policy).toHaveBeenCalledTimes(timeout ? 1 : 0);
  },
  20_000,
);
