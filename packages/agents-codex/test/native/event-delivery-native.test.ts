import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import type { NativeEventBatch } from '../fixtures/native-event-batches';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { Agent, NativeProvider, type ObservedEvent } from '../../src';
import {
  binding,
  type Engine,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

function streamingBody(chunks: string[]): string {
  const item = {
    id: 'message-burst',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: chunks.join('') }],
  };
  const frames = [
    { type: 'response.created', response: { id: 'response-burst' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    ...chunks.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'response-burst', output: [item] },
    },
  ];
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
}

async function* textFrom(events: AsyncIterable<ObservedEvent>) {
  for await (const event of events) {
    if (!('type' in event)) continue;
    expect(event.type).not.toBe('gap');
    if (event.type === 'output_text_delta') yield event.delta;
  }
}

it.each([
  {
    name: 'many small chunks',
    chunks: Array.from(
      { length: 512 },
      (_, index) => `${String(index).padStart(4, '0')}:α🙂:${'x'.repeat(16)}`,
    ),
  },
  {
    name: 'mixed large chunks',
    chunks: [
      ...Array.from(
        { length: 32 },
        (_, index) => `${index}:${'x'.repeat(128)}`,
      ),
      'a'.repeat(20_000),
      'b'.repeat(20_000),
    ],
  },
])(
  'delivers $name to independent consumers while allowing event-loop work',
  async ({ chunks }) => {
    const batches: NativeEventBatch[] = [];
    const native = await binding();
    const nextBatch = native.NativeThread.prototype._next_session_events;
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(function (this: NativeThread) {
      const pending = nextBatch.call(this);
      void pending.then(
        (batch) => {
          batches.push(batch);
        },
        () => {},
      );
      return pending;
    });
    const expected = chunks.join('');
    const server = new ModelServer([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: streamingBody(chunks),
      },
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-event-burst',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const turn = await session.submit('Stream the answer.');
    let heartbeat: Promise<void> | undefined;
    let heartbeatRan = false;
    let heartbeatBeforeLastDelta = false;
    const direct = (async () => {
      const received: string[] = [];
      for await (const event of turn.events()) {
        if (!('type' in event)) continue;
        expect(event.type).not.toBe('gap');
        if (event.type !== 'output_text_delta') continue;
        if (!heartbeat) {
          heartbeat = yieldToEventLoop().then(() => {
            heartbeatRan = true;
          });
        }
        received.push(event.delta);
        if (received.length === chunks.length)
          heartbeatBeforeLastDelta = heartbeatRan;
      }
      return received.join('');
    })();
    const projected = (async () => {
      const received: string[] = [];
      for await (const delta of textFrom(turn.events())) received.push(delta);
      return received.join('');
    })();
    const [directText, projectedText, result] = await Promise.all([
      direct,
      projected,
      turn.wait(),
    ]);
    await heartbeat;
    expect(directText).toBe(expected);
    expect(projectedText).toBe(expected);
    expect(result.finalOutput).toBe(expected);
    expect(heartbeatBeforeLastDelta).toBe(true);
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) firstNativeBatchWire(batch);
    server.assertExhausted();
  },
  20_000,
);

it('keeps native read failures asynchronous after the owner closes', async () => {
  const native = await binding();
  const next = native.NativeThread.prototype._next_session_events;
  let receiver: NativeThread | undefined;
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(function (this: NativeThread) {
    // Keep the receiver to exercise its native method after close.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    receiver = this;
    const result = next.call(this);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
  const server = new ModelServer([[message('done')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-closed-read',
    supportsWebsockets: false,
  });
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  await (await session.submit('Answer.')).wait();
  await session.close();
  expect(receiver).toBeDefined();
  let result: Promise<NativeEventBatch> | undefined;
  expect(() => {
    result = receiver!._next_session_events();
  }).not.toThrow();
  expect(result).toBeInstanceOf(Promise);
  await expect(result).rejects.toThrow(/closed/i);
  server.assertExhausted();
}, 20_000);

it('delivers each queued publication boundary through the native Promise bridge', async () => {
  const native = await binding();
  const server = new ModelServer([]);
  const home = await mkdtemp(join(tmpdir(), 'agents-event-boundary-'));
  let engine: Engine | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    engine = await native.create_engine(
      JSON.stringify({
        ...(await server.config()),
        model: 'gpt-5',
        approval_policy: 'never',
        sandbox_mode: 'danger-full-access',
        web_search: 'disabled',
        'analytics.enabled': false,
        'features.shell_snapshot': false,
      }),
      JSON.stringify({
        codex_home: home,
        cwd: home,
        strict_config: true,
        loader: {
          managed_config_path: join(home, 'managed.toml'),
          system_config_path: join(home, 'system.toml'),
          system_requirements_path: join(home, 'requirements.toml'),
          ignore_user_config: true,
          ignore_project_config: true,
        },
      }),
      'synthetic-publication-boundary',
    );
    const thread = await engine.start_replaceable_thread('{}', '[]');
    thread._enable_native_interception(4, 'thread_tree');
    thread._enable_native_mcp_results(4);
    await thread._next_session_events();
    const deadline = Promise.withResolvers<never>();
    timer = setTimeout(
      () => deadline.reject(new Error('Queued publication boundary was lost')),
      10_000,
    );
    await Promise.race([
      (async () => {
        for (const id of ['first-boundary', 'following-boundary']) {
          const receipt = JSON.parse(
            await thread._replace_mcp_servers(
              '{}',
              undefined,
              undefined,
              undefined,
              undefined,
              id,
            ),
          );
          expect(receipt.result.publication).toBe('published');
          for (;;) {
            const batch = await thread._next_session_events();
            firstNativeBatchWire(batch);
            const event = JSON.parse(batch[0]!);
            if (event.msg.type !== 'sdk_mcp_publication_boundary') continue;
            expect(batch).toHaveLength(1);
            expect(event.id).toBe(id);
            break;
          }
        }
        await thread.close();
      })(),
      deadline.promise,
    ]);
    server.assertExhausted();
  } finally {
    clearTimeout(timer);
    await engine?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);

it('settles a pending batched reader when session close cancels a provider request', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  const server = new ModelServer([
    async () => {
      entered.resolve();
      await release.promise;
      return [message('retired provider answer')];
    },
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-batch-cancellation',
    supportsWebsockets: false,
  });
  const native = await binding();
  const original = native.NativeThread.prototype._next_session_events;
  const reads: Promise<void>[] = [];
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(function (this: NativeThread) {
    const pending = original.call(this);
    reads.push(
      pending.then(
        () => {},
        () => {},
      ),
    );
    return pending;
  });
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  try {
    const turn = await session.submit('Wait for cancellation.');
    const settled = turn.wait().then(
      () => {},
      () => {},
    );
    await entered.promise;
    await session.close();
    await Promise.all(reads);
    await settled;
  } finally {
    release.resolve();
    await session.close();
  }
  server.assertExhausted();
}, 20_000);

it('drops the unread tail of a real text batch when its owner closes', async () => {
  // Core's root event channel is unbounded. Sixteen short deltas also keep
  // fixture transport buffers small. Stored output proves production finished
  // while this test holds the JS reader; the wait has a five-second deadline.
  const chunks = Array.from({ length: 16 }, (_, index) => `batch-${index};`);
  const expected = chunks.join('');
  const server = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: streamingBody(chunks),
    },
    [message('replacement owner')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-buffered-tail',
    supportsWebsockets: false,
  });
  const native = await binding();
  const original = native.NativeThread.prototype._next_session_events;
  const finish = vi.spyOn(
    native.NativeThread.prototype,
    '_finish_child_event_reader',
  );
  // The reader can run before opening assigns this session.
  // eslint-disable-next-line prefer-const
  let session: Awaited<ReturnType<Agent['session']>> | undefined;
  let retired: NativeThread | undefined;
  let closing: Promise<void> | undefined;
  let preparedBacklog = false;
  let multiEventBatch = 0;
  let tailRead = 0;
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    const batch = await original.call(this);
    firstNativeBatchWire(batch);
    const events = batch.map((wire) => JSON.parse(wire));
    const backlogGate = events.some(
      (event) => event.msg.type === 'agent_message_content_delta',
    );
    if (!preparedBacklog && backlogGate) {
      preparedBacklog = true;
      await vi.waitFor(
        async () => {
          expect(await this.read_thread_history(null)).toContain(expected);
        },
        { timeout: 5000, interval: 10 },
      );
    }
    const selectedBatch = batch.length > 1;
    if (session && preparedBacklog && !retired && selectedBatch) {
      expect(preparedBacklog).toBe(true);
      multiEventBatch = batch.length;
      // The assertion must identify the exact retired receiver.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      retired = this;
      const withheld = batch[1]!;
      // Schedule the real public close at the exact access to the first
      // unread tail entry. readEvents must recheck ownership after parsing.
      Object.defineProperty(batch, 1, {
        configurable: true,
        get: () => {
          tailRead++;
          closing = session!.close();
          return withheld;
        },
      });
    }
    return batch;
  });
  session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  try {
    const turn = await session.submit('Stream a bounded backlog.');
    const outcome = turn.wait().then(
      () => {},
      () => {},
    );
    const observed = (async () => {
      const events: ObservedEvent[] = [];
      for await (const event of turn.events()) events.push(event);
      return events;
    })();
    await vi.waitFor(() => expect(tailRead).toBe(1), {
      timeout: 5000,
      interval: 10,
    });
    expect(closing).toBeDefined();
    await closing;
    await outcome;
    const events = await observed;
    expect(multiEventBatch).toBeGreaterThan(1);
    expect(multiEventBatch).toBeLessThanOrEqual(8);
    expect(tailRead).toBe(1);
    expect(finish.mock.contexts).toContain(retired);
    const text = events
      .flatMap((event) =>
        'type' in event && event.type === 'output_text_delta'
          ? [event.delta]
          : [],
      )
      .join('');
    expect(expected.startsWith(text)).toBe(true);
    expect(text.length).toBeLessThan(expected.length);
    // A fresh owner on the same provider receives no retired text.
    await using replacement = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    expect(
      (await (await replacement.submit('Fresh owner.')).wait()).finalOutput,
    ).toBe('replacement owner');
  } finally {
    await session.close();
  }
  server.assertExhausted();
}, 20_000);

it('retires the exact text reader before a supplied context replacement starts reading', async () => {
  const chunks = Array.from({ length: 16 }, (_, index) => `source-${index};`);
  const expected = chunks.join('');
  const server = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: streamingBody(chunks),
    },
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: streamingBody(['new context ', 'answer']),
    },
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-batch-context',
    supportsWebsockets: false,
  });
  const native = await binding();
  const original = native.NativeThread.prototype._next_session_events;
  const finish = vi.spyOn(
    native.NativeThread.prototype,
    '_finish_child_event_reader',
  );
  const contexts = new Set<NativeThread>();
  let source: NativeThread | undefined;
  let backlogPrepared = false;
  let batches = 0;
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    contexts.add(this);
    const batch = await original.call(this);
    firstNativeBatchWire(batch);
    const events = batch.map((wire) => JSON.parse(wire));
    const backlogGate = events.some(
      (event) => event.msg.type === 'agent_message_content_delta',
    );
    if (!backlogPrepared && backlogGate) {
      // Preserve the source identity across native context replacement.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      source = this;
      backlogPrepared = true;
      await vi.waitFor(
        async () => {
          expect(await this.read_thread_history(null)).toContain(expected);
        },
        { timeout: 5000, interval: 10 },
      );
    }
    if (this === source && batch.length > 1) {
      batches++;
    }
    return batch;
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  expect(
    (await (await session.submit('Original context.')).wait()).finalOutput,
  ).toBe(expected);
  expect(batches).toBeGreaterThan(0);
  await session.compact({ summary: 'Only the new context remains active.' });
  expect(source).toBeDefined();
  expect(finish.mock.contexts).toContain(source);
  expect([...contexts].some((owner) => owner !== source)).toBe(true);
  const next = await session.submit('New context.');
  const events = (async () => {
    const text: string[] = [];
    for await (const event of next.events()) {
      if (!('type' in event)) continue;
      expect(event.type).not.toBe('gap');
      if (event.type === 'output_text_delta') text.push(event.delta);
    }
    return text.join('');
  })();
  expect((await next.wait()).finalOutput).toBe('new context answer');
  const projected = await events;
  expect(projected).toBe('new context answer');
  server.assertExhausted();
}, 20_000);
