import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider } from '../../src';
import { ObservationBuffer } from '../../src/runtime/observation';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
afterEach(() => vi.restoreAllMocks());

it.each([
  ['x', 350],
  ['y'.repeat(70_000), 1],
] as const)(
  'retains native deltas for slow and late independent readers (case %#)',
  async (chunk, count) => {
    const item = message(chunk.repeat(count));
    const events = [
      { type: 'response.created', response: { id: 'retained-response' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, content: [] },
      },
      ...Array.from({ length: count }, () => ({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: chunk,
      })),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'retained-response' } },
    ];
    const server = new ModelServer([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      },
    ]);
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session({ observationRetention: 'all' });
    try {
      const slow = session.events();
      await session.events().return?.();
      expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
        chunk.repeat(count),
      );
      await session.close();
      const late = await Array.fromAsync(session.events());
      expect(await Array.fromAsync(slow)).toEqual(late);
      expect(late.some((event) => event.type === 'gap')).toBe(false);
      expect(
        late
          .filter((event) => event.type === 'output_text_delta')
          .map((event) => event.delta)
          .join(''),
      ).toBe(chunk.repeat(count));
      expect(
        late.map((event) => ('sequence' in event ? event.sequence : null)),
      ).toEqual(Array.from({ length: late.length }, (_, i) => i + 1));
    } finally {
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  },
);

it('preserves the bounded default', async () => {
  const buffer = new ObservationBuffer('bounded');
  for (let i = 0; i < 350; i++)
    buffer.append({ type: 'warning', message: String(i) });
  buffer.finish('closed');
  const events = await Array.fromAsync(buffer.events());
  expect(events[0]?.type).toBe('gap');
  expect(events.length).toBeLessThanOrEqual(257);
});

it('rejects invalid retention before opening', async () => {
  const agent = new Agent({ instructions: 'Answer.' });
  await expect(
    // @ts-expect-error Exercise validation at the JavaScript boundary.
    agent.session({ observationRetention: 'invalid' }),
  ).rejects.toThrow('observationRetention');
});

it('preserves observations before a source gap in all mode', async () => {
  const buffer = new ObservationBuffer('all', { retention: 'all' });
  buffer.append({ type: 'warning', message: 'before gap' });
  buffer.gap();
  buffer.finish('closed');
  const events = await Array.fromAsync(buffer.events());
  expect(events.map((event) => event.type)).toEqual([
    'warning',
    'gap',
    'session_ended',
  ]);
  expect(events[1]).toMatchObject({ firstSequence: 2, sequence: 2 });
});

it.each(['root', 'child'])(
  'exposes retained source gaps to %s scopes',
  async (owner) => {
    const buffer = new ObservationBuffer('all', { retention: 'all' });
    buffer.gap();
    buffer.finish('closed');
    const events = await Array.fromAsync(
      buffer.events(
        {},
        {
          includes: (event) =>
            'submissionId' in event && event.submissionId === owner,
          phase: () => 'ended',
        },
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'gap',
      firstSequence: 1,
      sequence: 1,
    });
  },
);

it('replays a retained source gap through native Turn.events', async () => {
  const server = new ModelServer([[message('done')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session({ observationRetention: 'all' });
  const turn = await session.submit('begin');
  expect((await turn.wait()).finalOutput).toBe('done');
  (
    session as unknown as { observations: ObservationBuffer }
  ).observations.gap();
  const events = await Array.fromAsync(turn.events());
  expect(events.some((event) => event.type === 'gap')).toBe(true);
  server.assertExhausted();
});

it('forwards a repair source gap through public parent Turn.events', async () => {
  const link = ObservationBuffer.prototype.linkRepairParent;
  vi.spyOn(ObservationBuffer.prototype, 'linkRepairParent').mockImplementation(
    function (this: ObservationBuffer, parent, submissionId) {
      link.call(this, parent, submissionId);
      // Inject source loss at the real correction-to-parent publication boundary.
      this.gap();
    },
  );
  const server = new ModelServer([
    [message('{"label":"x"}')],
    [message('{"label":"corrected"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-repair-gap',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ label: z.string().min(2) }),
      maxRetries: 1,
    },
  }).session({ observationRetention: 'all' });
  const turn = await session.submit('begin');
  expect((await turn.wait()).finalOutput).toEqual({ label: 'corrected' });
  const events = await Array.fromAsync(turn.events());
  const gap = events.find((event) => event.type === 'gap');
  expect(gap).toMatchObject({ type: 'gap', sessionId: session.id });
  expect(gap?.sequence).toBeGreaterThan(1);
  expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(
    2,
  );
  expect(await Array.fromAsync(turn.events())).toEqual(events);
  server.assertExhausted();
});

it.each(['bounded', 'all'] as const)(
  'scopes source gaps to Turn admission in %s mode',
  async (observationRetention) => {
    const server = new ModelServer([[message('first')], [message('second')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session({ observationRetention });
    const first = await session.submit('first');
    await first.wait();
    const buffer = (session as unknown as { observations: ObservationBuffer })
      .observations;
    buffer.gap();
    const second = await session.submit('second');
    await second.wait();
    expect(
      (await Array.fromAsync(second.events())).some(
        (event) => event.type === 'gap',
      ),
    ).toBe(false);
    expect(
      (await Array.fromAsync(first.events())).some(
        (event) => event.type === 'gap',
      ),
    ).toBe(true);
    buffer.gap();
    const events = await Array.fromAsync(second.events());
    const gaps = events.filter((event) => event.type === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    expect(
      await Array.fromAsync(second.events({ after: gaps.at(-1)!.sequence })),
    ).toEqual([]);
    server.assertExhausted();
  },
);

it('visits retained array entries linearly for independent replay cursors', async () => {
  const buffer = new ObservationBuffer('linear', { retention: 'all' });
  const count = 4096;
  for (let i = 0; i < count; i++)
    buffer.append({ type: 'warning', message: String(i) });
  buffer.finish('closed');
  let reads = 0;
  const records = Reflect.get(buffer, 'records') as unknown[];
  Reflect.set(
    buffer,
    'records',
    new Proxy(records, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  expect(await Array.fromAsync(buffer.events())).toHaveLength(count + 1);
  expect(reads).toBeLessThanOrEqual(3 * (count + 1) + 3);
  reads = 0;
  expect(
    await Array.fromAsync(buffer.events({ after: count - 2 })),
  ).toHaveLength(3);
  expect(reads).toBeLessThanOrEqual(12);
});
