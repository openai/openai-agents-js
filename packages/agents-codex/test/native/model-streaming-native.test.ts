import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  tool,
  type ModelRequest,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

function text(id: string, value: string): JsonObject[] {
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id, role: 'assistant', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: value,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: value }],
      },
    },
  ];
}
function completed(id: string): JsonObject {
  return { type: 'response.completed', response: { id } };
}
function call(): JsonObject {
  return {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      call_id: 'one-call',
      name: 'record',
      arguments: '{"value":"once"}',
    },
  };
}
function complete(): never {
  throw new Error('Streaming request entered buffered complete');
}

it('rejects retained byte overflow before admitting tool effects and joins iterator cleanup', async () => {
  const effects: string[] = [];
  let requests = 0;
  let closed = false;
  const record = tool({
    name: 'record',
    parameters: z.object({ value: z.string() }),
    execute({ value }) {
      effects.push(value);
      return 'recorded';
    },
  });
  await using provider = new NativeProvider({
    modelBackend: {
      complete,
      async *stream(): AsyncGenerator<JsonObject> {
        requests++;
        try {
          yield call();
          for (let index = 0; index < 5; index++)
            yield {
              type: 'response.output_text.delta',
              delta: 'x'.repeat(2 * 1024 * 1024),
            };
          yield completed('oversized-suffix');
        } finally {
          closed = true;
        }
      },
    },
  });
  await expect(
    new Agent({
      model: 'fixture-stream-model',
      instructions: 'Use record.',
      provider,
      tools: [record],
    }).run('Begin.'),
  ).rejects.toThrow('Native model stream deferred output exceeds its limit');
  expect(effects).toEqual([]);
  expect(requests).toBe(1);
  expect(closed).toBe(true);
}, 20_000);

it.each([false, true])(
  'retains successful terminal observations with a tool suffix %s',
  async (withTool) => {
    let requests = 0;
    const record = tool({
      name: 'record',
      parameters: z.object({ value: z.string() }),
      execute: () => 'recorded',
    });
    await using provider = new NativeProvider({
      modelBackend: {
        complete,
        async *stream(): AsyncGenerator<JsonObject> {
          const attempt = ++requests;
          if (withTool && attempt === 1) yield call();
          else
            for (const event of text(`observed-${attempt}`, 'finished'))
              yield event;
          yield {
            type: 'response.completed',
            response: {
              id: `observed-response-${attempt}`,
              status: 'completed',
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          };
        },
      },
    });
    await using session = await new Agent({
      model: 'fixture-stream-model',
      instructions: 'Answer.',
      provider,
      tools: withTool ? [record] : [],
    }).session();
    expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
      'finished',
    );
    const responses = [];
    for await (const recorded of session.turns())
      responses.push(...(recorded.responses ?? []));
    expect(responses).toHaveLength(withTool ? 2 : 1);
    for (const [index, response] of responses.entries())
      expect(response).toMatchObject({
        responseId: `observed-response-${index + 1}`,
        status: 'completed',
        usageSource: 'received',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
  },
);

it('accepts many small text deltas after a deferred tool without admitting its effects early', async () => {
  let requests = 0;
  const effects: string[] = [];
  const record = tool({
    name: 'record',
    parameters: z.object({ value: z.string() }),
    execute({ value }) {
      effects.push(value);
      return 'recorded';
    },
  });
  await using provider = new NativeProvider({
    modelBackend: {
      complete,
      async *stream(): AsyncGenerator<JsonObject> {
        if (++requests === 1) {
          yield call();
          const [added, , done] = text('long-text', 'x'.repeat(4096));
          yield { ...added, output_index: 1 };
          for (let index = 0; index < 4096; index++)
            yield {
              type: 'response.output_text.delta',
              item_id: 'long-text',
              output_index: 1,
              content_index: 0,
              delta: 'x',
            };
          yield { ...done, output_index: 1 };
          expect(effects).toEqual([]);
          yield completed('long-text-response');
          expect(effects).toEqual([]);
        } else {
          for (const event of text('after-long-text', 'finished')) yield event;
          yield completed('after-long-text');
        }
      },
    },
  });
  const result = await new Agent({
    model: 'fixture-stream-model',
    instructions: 'Use record.',
    tools: [record],
    provider,
  }).run('Begin.');
  expect(result.finalOutput).toBe('finished');
  expect(effects).toEqual(['once']);
  expect(requests).toBe(2);
}, 20_000);

it('delivers a native text delta before the application stream finishes', async () => {
  const release = Promise.withResolvers<void>();
  await using provider = new NativeProvider({
    modelBackend: {
      complete,
      async *stream(): AsyncGenerator<JsonObject> {
        yield { type: 'response.created', response: { id: 'incremental' } };
        const [added, delta, done] = text('stream-item', 'incremental');
        yield added;
        yield delta;
        await release.promise;
        yield done;
        yield completed('incremental');
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'fixture-stream-model',
    provider,
  }).session();
  const turn = await session.submit('Begin.');
  try {
    for await (const event of turn.events()) {
      if (event.type === 'output_text_delta') {
        expect(event.delta).toBe('incremental');
        break;
      }
    }
  } finally {
    release.resolve();
  }
  expect((await turn.wait()).finalOutput).toBe('incremental');
}, 20_000);

it.each(['complete', 'missing', 'duplicate'] as const)(
  'admits streamed tools only after one terminal and iterator finish: %s',
  async (terminal) => {
    const effects: string[] = [];
    const record = tool({
      name: 'record',
      parameters: z.object({ value: z.string() }),
      execute({ value }) {
        effects.push(value);
        return 'recorded';
      },
    });
    let requests = 0;
    await using provider = new NativeProvider({
      modelBackend: {
        complete,
        async *stream(request: ModelRequest): AsyncGenerator<JsonObject> {
          requests++;
          if (requests > 1) {
            expect(JSON.stringify(request.body.input)).toContain('one-call');
            expect(JSON.stringify(request.body.input)).toContain('recorded');
            for (const event of text('after-tool', 'recorded')) yield event;
            yield completed('after-tool');
            return;
          }
          yield call();
          if (terminal !== 'missing') yield completed('before-tool');
          if (terminal === 'duplicate') yield completed('duplicate');
          expect(effects).toEqual([]);
        },
      },
    });
    const agent = new Agent({
      model: 'fixture-stream-model',
      provider,
      tools: [record],
      instructions: 'Use record.',
    });
    if (terminal === 'complete')
      expect((await agent.run('Record.')).finalOutput).toBe('recorded');
    else await expect(agent.run('Record.')).rejects.toBeInstanceOf(NativeError);
    expect(effects).toEqual(terminal === 'complete' ? ['once'] : []);
  },
  20_000,
);

it('joins application iterator cleanup before an aborted native run retires', async () => {
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleaned = false;
  const controller = new AbortController();
  await using provider = new NativeProvider({
    modelBackend: {
      complete,
      async *stream(request: ModelRequest): AsyncGenerator<JsonObject> {
        try {
          yield {
            type: 'response.created',
            response: { id: 'cancelled-stream' },
          };
          entered.resolve();
          if (!request.signal.aborted)
            await new Promise<void>((resolve) =>
              request.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
        } finally {
          cleaning.resolve();
          await release.promise;
          cleaned = true;
        }
      },
    },
  });
  let settled = false;
  const result = new Agent({
    model: 'fixture-stream-model',
    provider,
    instructions: 'Answer.',
  }).run('Begin.', { signal: controller.signal });
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await entered.promise;
    controller.abort(new Error('stop stream'));
    await cleaning.promise;
    expect(settled).toBe(false);
  } finally {
    release.resolve();
  }
  await expect(result).rejects.toThrow();
  expect(cleaned).toBe(true);
}, 20_000);

it.each([undefined, 0] as const)(
  'applies native response-fact retention to streamed events: topLogprobs=%s',
  async (topLogprobs) => {
    const secret = 'stream-private-probability';
    await using provider = new NativeProvider({
      modelBackend: {
        complete,
        async *stream(): AsyncGenerator<JsonObject> {
          yield { type: 'response.created', response: { id: 'facts' } };
          const [added, delta, done] = text('fact-item', 'readable');
          yield added;
          yield {
            ...delta,
            logprobs: [{ token: secret, logprob: -0.5, top_logprobs: [] }],
          };
          yield done;
          yield completed('facts');
        },
      },
    });
    await using session = await new Agent({
      model: 'fixture-stream-model',
      provider,
      instructions: 'Answer.',
      modelSettings: topLogprobs === undefined ? undefined : { topLogprobs },
    }).session();
    const turn = await session.submit('Begin.');
    expect((await turn.wait()).finalOutput).toBe('readable');
    const facts: unknown[] = [];
    for await (const event of turn.events({ includeExecutionDetails: true }))
      if (event.type === 'response_fact') facts.push(event);
    expect(JSON.stringify(facts).includes(secret)).toBe(
      topLogprobs !== undefined,
    );
  },
  20_000,
);

it.each([
  [
    { type: 'response.refusal.done', refusal: 'application-private-refusal' },
    'provider_refusal',
  ],
  [
    { type: 'response.output_item.done', item: { type: 'message', role: 3 } },
    'undecodable_output_item',
  ],
] as const)(
  'preserves typed native stream integrity failures without tool effects: %s',
  async (failedEvent, reason) => {
    const effects: string[] = [];
    let closed = false;
    const record = tool({
      name: 'record',
      parameters: z.object({ value: z.string() }),
      execute({ value }) {
        effects.push(value);
        return value;
      },
    });
    await using provider = new NativeProvider({
      modelBackend: {
        complete,
        async *stream(): AsyncGenerator<JsonObject> {
          try {
            yield { type: 'response.created', response: { id: 'integrity' } };
            yield call();
            yield failedEvent;
            throw new Error('Producer advanced after its integrity failure');
          } finally {
            closed = true;
          }
        },
      },
    });
    await using session = await new Agent({
      model: 'fixture-stream-model',
      provider,
      tools: [record],
      instructions: 'Use record.',
    }).session();
    const turn = await session.submit('Record.');
    try {
      await turn.wait();
      throw new Error('Invalid stream unexpectedly completed');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeError);
      expect((error as NativeError).responseIntegrityReason).toBe(reason);
      expect(String(error)).not.toContain('application-private-refusal');
    }
    expect(effects).toEqual([]);
    expect(closed).toBe(true);
  },
  20_000,
);

it('retains received terminal usage in native history when content filtering rejects the stream', async () => {
  let attempts = 0;
  await using provider = new NativeProvider({
    modelBackend: {
      complete,
      async *stream(): AsyncGenerator<JsonObject> {
        const responseId = `filtered-with-usage-${++attempts}`;
        yield { type: 'response.created', response: { id: responseId } };
        yield {
          type: 'response.incomplete',
          response: {
            id: responseId,
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        };
        throw new Error('Producer advanced after content-filter rejection');
      },
    },
  });
  await using session = await new Agent({
    model: 'fixture-stream-model',
    instructions: 'Answer.',
    provider,
  }).session();
  const turn = await session.submit('Begin.');
  await expect(turn.wait()).rejects.toThrow(/content_filter/);
  const responses = [];
  for await (const recorded of session.turns())
    responses.push(...(recorded.responses ?? []));
  expect(attempts).toBeGreaterThan(0);
  expect(responses).toHaveLength(attempts);
  for (const [index, response] of responses.entries())
    expect(response).toMatchObject({
      responseId: `filtered-with-usage-${index + 1}`,
      status: 'incomplete',
      incompleteReason: 'content_filter',
      usageSource: 'received',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
}, 20_000);

it('closes a returned iterator when cancellation wins during its asynchronous factory', async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  let closed = false;
  let advances = 0;
  await using provider = new NativeProvider({
    modelBackend: {
      complete,
      async stream(request: ModelRequest): Promise<AsyncIterable<JsonObject>> {
        entered.resolve();
        if (!request.signal.aborted)
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<JsonObject>> {
                advances++;
                return { done: true, value: undefined };
              },
              async return(): Promise<IteratorResult<JsonObject>> {
                closed = true;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
  });
  const result = new Agent({
    model: 'fixture-stream-model',
    instructions: 'Answer.',
    provider,
  }).run('Begin.', { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('cancel factory'));
  await expect(result).rejects.toThrow();
  expect(advances).toBe(0);
  expect(closed).toBe(true);
}, 20_000);
