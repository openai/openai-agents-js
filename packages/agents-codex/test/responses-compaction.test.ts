import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import { responsesCompaction } from '../src/runtime/responses-compaction';
import type { CompactionContext } from '../src/runtime/model-callbacks';

const items = [
  {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'original' }],
  },
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'candidate' }],
  },
];
const context = (): CompactionContext => ({
  context: undefined,
  sessionId: 'session',
  turnId: 'turn',
  requestId: 'request',
  automatic: true,
  model: 'generation',
  signal: new AbortController().signal,
  items,
});
const result = () => ({
  id: 'compact-result',
  object: 'response.compaction',
  created_at: 1,
  output: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'before' }],
    },
    { type: 'compaction', id: 'opaque', encrypted_content: 'opaque' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'after', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 4,
    input_tokens_details: { cached_tokens: 1 },
    output_tokens: 2,
    total_tokens: 6,
  },
});

it('uses the captured borrowed method and preserves the complete returned window', async () => {
  const bodies: unknown[] = [];
  const client = new OpenAI({
    apiKey: 'synthetic',
    maxRetries: 0,
    fetch: async (_request, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(result()), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const options = { client, model: 'compact' };
  const factory = responsesCompaction(options);
  options.model = 'changed';
  vi.spyOn(client.responses, 'compact').mockRejectedValue(
    new Error('replaced method'),
  );
  const prepared = factory.prepareContext(context(), [1], undefined, false);
  expect(prepared).toMatchObject({
    model: 'compact',
    mode: 'input',
    candidates: [items[1]],
  });
  expect(Object.isFrozen(prepared)).toBe(true);
  const observe = vi.fn();
  const window = await factory.requestWindow(prepared, undefined, observe);
  expect(bodies).toEqual([{ model: 'compact', input: items }]);
  expect(window.items).toEqual(result().output);
  expect(observe).toHaveBeenCalledExactlyOnceWith({
    inputTokens: 4,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 6,
  });
});
it.each(['auto', 'input', 'previous_response_id'] as const)(
  'resolves %s before predicate or client effects',
  (mode) => {
    const client = new OpenAI({ apiKey: 'synthetic' });
    const factory = responsesCompaction({ client, mode });
    if (mode === 'previous_response_id')
      expect(() =>
        factory.prepareContext(context(), [], undefined, false),
      ).toThrow('acknowledged');
    else
      expect(factory.prepareContext(context(), [], undefined, false).mode).toBe(
        'input',
      );
    expect(() =>
      factory.prepareContext(context(), [], undefined, true),
    ).toThrow();
    const prepared = factory.prepareContext(
      context(),
      [],
      { response_id: 'ordinary-current', model: 'actual-provider-model' },
      true,
    );
    expect(prepared.model).toBe('actual-provider-model');
    expect(prepared.mode).toBe(
      mode === 'input' ? 'input' : 'previous_response_id',
    );
  },
);
it('reports a completed malformed response once without admitting a window', async () => {
  const client = new OpenAI({
    apiKey: 'synthetic',
    maxRetries: 0,
    fetch: async () =>
      new Response(JSON.stringify({ id: 'bad' }), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  const factory = responsesCompaction({ client, model: 'compact' });
  const prepared = factory.prepareContext(context(), [], undefined, false);
  const observe = vi.fn();
  await expect(
    factory.requestWindow(prepared, undefined, observe),
  ).rejects.toThrow();
  expect(observe).toHaveBeenCalledExactlyOnceWith(null);
});
it('reports no completion for a failed compact invocation', async () => {
  const client = new OpenAI({
    apiKey: 'synthetic',
    maxRetries: 0,
    fetch: async () => {
      throw new Error('transport failed');
    },
  });
  const factory = responsesCompaction({ client, model: 'compact' });
  const observe = vi.fn();
  await expect(
    factory.requestWindow(
      factory.prepareContext(context(), [], undefined, false),
      undefined,
      observe,
    ),
  ).rejects.toThrow();
  expect(observe).not.toHaveBeenCalled();
});

it.each([7, false, '', ' '])(
  'rejects malformed response ID %s before native reply',
  async (id) => {
    const client = new OpenAI({
      apiKey: 'synthetic',
      maxRetries: 0,
      fetch: async () =>
        new Response(JSON.stringify({ ...result(), id }), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const factory = responsesCompaction({ client });
    const prepared = factory.prepareContext(context(), [], undefined, false);
    const observe = vi.fn();
    await expect(
      factory.requestWindow(prepared, undefined, observe),
    ).rejects.toThrow('response ID');
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0].totalTokens).toBe(6);
  },
);

it('reconciles an exact transformed control echo to detached canonical instructions', async () => {
  const original = [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'private instructions' }],
    },
  ];
  const redacted = [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'redacted instructions' }],
    },
  ];
  const bodies: any[] = [];
  const client = new OpenAI({
    apiKey: 'synthetic',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({
          ...result(),
          output: [
            ...body.input,
            { type: 'compaction', encrypted_content: 'opaque' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const factory = responsesCompaction({ client });
  const prepared = factory.prepareContext(
    { ...context(), items: redacted },
    [],
    undefined,
    false,
  );
  const window = await factory.requestWindow(
    prepared,
    undefined,
    () => {},
    original,
  );
  expect(bodies[0].input).toEqual(redacted);
  expect(window.items).toEqual([
    ...original,
    { type: 'compaction', encrypted_content: 'opaque' },
  ]);
});

it('keeps control aliases exact and single-use before native validation', async () => {
  const original = [
    {
      type: 'message',
      role: 'developer',
      id: 'control',
      content: [{ type: 'input_text', text: 'canonical' }],
    },
  ];
  const redacted = [
    { ...original[0], content: [{ type: 'input_text', text: 'redacted' }] },
  ];
  const factory = responsesCompaction({
    client: {
      responses: {
        compact: async () => ({
          ...result(),
          output: [...redacted, ...redacted],
        }),
      },
    } as unknown as OpenAI,
  });
  const prepared = factory.prepareContext(
    { ...context(), items: redacted },
    [],
    undefined,
    false,
  );
  const window = await factory.requestWindow(
    prepared,
    undefined,
    () => {},
    original,
  );
  expect(window.items).toEqual([original[0], redacted[0]]);
});
it('preserves request-only control projections without granting canonical aliases', async () => {
  const compact = vi.fn(async (body: any) => ({
    ...result(),
    output: body.input,
  }));
  const factory = responsesCompaction({
    client: { responses: { compact } } as unknown as OpenAI,
  });
  const original = [
    { type: 'message', role: 'developer', id: 'control', content: [] },
  ];
  for (const replacement of [
    { ...original[0], role: 'system' },
    { ...original[0], id: 'different' },
  ]) {
    const prepared = factory.prepareContext(
      { ...context(), items: [replacement] },
      [],
      undefined,
      false,
    );
    const window = await factory.requestWindow(
      prepared,
      undefined,
      () => {},
      original,
    );
    expect(window.items).toEqual([replacement]);
  }
  expect(compact).toHaveBeenCalledTimes(2);
});

it('keeps a later exact alias after an unmatched returned control', async () => {
  const original = [
    {
      type: 'message',
      role: 'developer',
      id: 'control',
      content: [{ type: 'input_text', text: 'canonical' }],
    },
  ];
  const redacted = [
    { ...original[0], content: [{ type: 'input_text', text: 'redacted' }] },
  ];
  const foreign = {
    ...redacted[0],
    content: [{ type: 'input_text', text: 'foreign' }],
  };
  const factory = responsesCompaction({
    client: {
      responses: {
        compact: async () => ({ ...result(), output: [foreign, ...redacted] }),
      },
    } as unknown as OpenAI,
  });
  const prepared = factory.prepareContext(
    { ...context(), items: redacted },
    [],
    undefined,
    false,
  );
  const window = await factory.requestWindow(
    prepared,
    undefined,
    () => {},
    original,
  );
  expect(window.items).toEqual([foreign, original[0]]);
});
