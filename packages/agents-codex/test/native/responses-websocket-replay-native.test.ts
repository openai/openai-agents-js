import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  ResponsesWebSocketModel,
  type ResponsesSocket,
} from '../../src';

it.each([
  ['string', 'synthetic socket read failure'],
  ['null', null],
  ['undefined', undefined],
  ['object', { message: 'synthetic socket read failure' }],
] as const)(
  'denies replay after a sent frame and a %s rejection',
  async (_kind, failure) => {
    let sends = 0;
    const model = new ResponsesWebSocketModel(() => {
      const raw = Object.assign(new EventEmitter(), { readyState: 1 });
      return {
        socket: raw,
        send() {
          sends++;
        },
        close() {
          raw.readyState = 3;
          raw.emit('close');
        },
        async *[Symbol.asyncIterator]() {
          if (sends === 1) await Promise.reject(failure);
          yield {
            type: 'message',
            message: {
              type: 'response.completed',
              response: {
                id: 'resp_replay',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'replayed' }],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          };
        },
      } as unknown as ResponsesSocket;
    });
    await using provider = new NativeProvider({ modelBackend: model });
    const agent = new Agent({
      provider,
      model: 'custom-model',
      instructions: 'Answer.',
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy() {
            return { retry: true, delayMs: 0 };
          },
        },
      },
    });
    const result = await agent.run('Reply.').then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    expect(sends).toBe(1);
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('Expected a rejected request');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).toHaveProperty('cause', failure);
  },
);

it('normalizes asynchronous primitive close failures after a sent frame', async () => {
  let sends = 0;
  const model = new ResponsesWebSocketModel(() => {
    const raw = Object.assign(new EventEmitter(), { readyState: 1 });
    return {
      socket: raw,
      send() {
        sends++;
      },
      async close() {
        raw.readyState = 3;
        raw.emit('close');
        await Promise.reject('synthetic close failure');
      },
      async *[Symbol.asyncIterator]() {
        await Promise.reject('synthetic read failure');
        yield { type: 'open' };
      },
    } as unknown as ResponsesSocket;
  });
  const owner = Object.freeze({
    sessionId: 'synthetic-session',
    turnId: 'synthetic-turn',
  });
  const request = {
    body: { model: 'synthetic', input: [] },
    context: undefined,
    sessionId: owner.sessionId,
    turnId: owner.turnId,
    signal: new AbortController().signal,
    runOwner: owner,
  };
  let failure: unknown;
  try {
    for await (const _event of model.stream(request)) {
      /* No response has been completing. */
    }
  } catch (error) {
    failure = error;
  } finally {
    await model.cleanupOnRunEnd(owner).catch(() => {});
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toHaveProperty('cause.cause', 'synthetic read failure');
  expect((failure as AggregateError).errors[1]).toHaveProperty(
    'cause',
    'synthetic close failure',
  );
  expect(
    model.getRetryAdvice({ error: failure } as Parameters<
      typeof model.getRetryAdvice
    >[0]),
  ).toMatchObject({ suggested: false, replaySafety: 'unsafe' });
  expect(sends).toBe(1);
});
