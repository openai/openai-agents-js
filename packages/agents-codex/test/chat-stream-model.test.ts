import { expect, it, vi } from 'vitest';
import { ChatCompletionsModel, type ModelRequest } from '../src/runtime/models';

const request = (): ModelRequest => ({
  body: {
    model: 'chat-model',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hi' }],
      },
    ],
  },
  context: undefined,
  sessionId: 'session',
  turnId: 'turn',
  signal: new AbortController().signal,
});

it.each([undefined, true, false])(
  'streams text before completion with includeUsage=%s',
  async (includeUsage) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let usageReleased = false;
    const create = vi.fn(async function* (_body: unknown, _options: unknown) {
      yield {
        id: 'chat-response',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Hello' },
            finish_reason: null,
          },
        ],
      };
      await gate;
      usageReleased = true;
      yield {
        id: 'chat-response',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      if (includeUsage !== false)
        yield {
          id: 'chat-response',
          choices: [],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        };
    });
    const model = new ChatCompletionsModel(
      { chat: { completions: { create } } },
      undefined,
      { stream: true, includeUsage },
    );
    expect(model.stream).toBeTypeOf('function');
    const iterator = model.stream!(request())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: 'response.created',
    });
    let firstText;
    do {
      firstText = (await iterator.next()).value;
    } while (firstText?.type !== 'response.output_text.delta');
    expect(firstText).toMatchObject({
      type: 'response.output_text.delta',
      delta: 'Hello',
    });
    expect(usageReleased).toBe(false);
    const sent = create.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ stream: true });
    if (includeUsage === false)
      expect(sent).not.toHaveProperty('stream_options');
    else
      expect(sent).toMatchObject({ stream_options: { include_usage: true } });
    release();
    const rest = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'chat-response',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello' }],
          },
        ],
      },
    });
    if (includeUsage === false)
      expect(rest.at(-1)?.response).not.toHaveProperty('usage');
    else
      expect(rest.at(-1)).toMatchObject({
        response: {
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      });
  },
);

it('retains the completed default and omits streaming options on that route', async () => {
  const create = vi.fn(async (_body: unknown, _options: unknown) => ({
    id: 'complete',
    choices: [{ finish_reason: 'stop', message: { content: 'Done' } }],
  }));
  const model = new ChatCompletionsModel({ chat: { completions: { create } } });
  expect(model.stream).toBeUndefined();
  await expect(model.complete(request())).resolves.toMatchObject({
    responseId: 'complete',
  });
  expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: false });
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty('stream_options');
});

it('closes the borrowed iterator on consumer retirement without completing a response', async () => {
  let closed = false;
  const client = {
    chat: {
      completions: {
        async *create() {
          try {
            yield {
              id: 'cancelled',
              choices: [
                {
                  index: 0,
                  delta: { content: 'partial' },
                  finish_reason: null,
                },
              ],
            };
            yield {
              id: 'cancelled',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
          } finally {
            closed = true;
          }
        },
      },
    },
  };
  const model = new ChatCompletionsModel(client, undefined, { stream: true });
  const iterator = model.stream!(request())[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({
    type: 'response.created',
  });
  await iterator.return?.();
  expect(closed).toBe(true);
});

it('does not manufacture terminal completion after truncated Chat input', async () => {
  const client = {
    chat: {
      completions: {
        async *create() {
          yield {
            id: 'truncated',
            choices: [
              { index: 0, delta: { content: 'partial' }, finish_reason: null },
            ],
          };
        },
      },
    },
  };
  const model = new ChatCompletionsModel(client, undefined, { stream: true });
  const seen: unknown[] = [];
  await expect(
    (async () => {
      for await (const event of model.stream!(request())) seen.push(event.type);
    })(),
  ).rejects.toThrow('without a completed choice');
  expect(seen).not.toContain('response.completed');
});

it('bounds fragmented tool arguments before admitting the tool call', async () => {
  let closed = false;
  const create = async function* () {
    try {
      const argumentsDelta = 'x'.repeat(256 * 1024);
      for (let index = 0; index < 40; index++) {
        yield {
          id: 'oversized',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    function: {
                      name: index === 0 ? 'example' : '',
                      arguments: argumentsDelta,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
      }
    } finally {
      closed = true;
    }
  };
  const model = new ChatCompletionsModel(
    { chat: { completions: { create } } },
    undefined,
    { stream: true },
  );
  const seen: unknown[] = [];
  await expect(
    (async () => {
      for await (const event of model.stream!(request())) seen.push(event.type);
    })(),
  ).rejects.toThrow('buffer limit');
  expect(seen).toEqual(['response.created']);
  expect(closed).toBe(true);
});
