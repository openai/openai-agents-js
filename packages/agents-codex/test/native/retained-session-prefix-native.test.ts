import { createServer } from 'node:http';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import type { NativeThread } from '../../native';
import { ModelServer, message } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    apiKey: 'synthetic-prefix',
    supportsWebsockets: false,
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
  });
}

async function reads() {
  const native = await binding();
  const prototype = native.NativeThread.prototype;
  const collect = prototype._next_owned_session_events;
  const stop = prototype._stop_session_event_collection;
  expect(typeof collect).toBe('function');
  expect(typeof stop).toBe('function');
  const calls: string[] = [];
  const ordinary = prototype._next_session_events;
  let overlaps = 0;
  const active = new Set<Promise<string[]>>();
  const entered = Promise.withResolvers<void>();
  vi.spyOn(prototype, '_next_session_events').mockImplementation(function (
    this: NativeThread,
  ) {
    if (active.size) overlaps++;
    return ordinary.call(this);
  });
  vi.spyOn(prototype, '_next_owned_session_events').mockImplementation(
    function (this: NativeThread, turn, seen) {
      calls.push(turn);
      const pending = collect.call(this, turn, seen);
      active.add(pending);
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      );
      entered.resolve();
      return pending;
    },
  );
  return {
    prototype,
    stop,
    calls,
    active,
    entered,
    get overlaps() {
      return overlaps;
    },
  };
}

// A real Responses peer publishes a small text prefix and then waits. The
// application must be able to observe/cancel without completing that response.
async function heldPeer() {
  const release = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const item = {
    type: 'message',
    id: 'prefix-message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'first' }],
  };
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* read the complete request */
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of [
      { type: 'response.created', response: { id: 'prefix-response' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: 'first',
      },
    ])
      response.write(frame(value));
    sent.resolve();
    await release.promise;
    if (!response.destroyed)
      response.end(
        frame({ type: 'response.output_item.done', output_index: 0, item }) +
          frame({
            type: 'response.completed',
            response: { id: 'prefix-response', output: [item] },
          }),
      );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing prefix peer address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    sent,
    async [Symbol.asyncDispose]() {
      release.resolve();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    release,
  };
}

// Unlike message()'s done-only fixture, these frames produce actual public
// text deltas, so exact replay assertions exercise the collector's wire path.
function streamingMessage(text: string, responseId: string) {
  const item = message(text);
  const frames = [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text },
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: responseId, output: [item] },
    },
  ];
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''),
  };
}

it('collects two public retained roots and preserves each issued result and replay', async () => {
  const observed = await reads();
  const server = new ModelServer([
    streamingMessage('first', 'replay-first'),
    streamingMessage('second', 'replay-second'),
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  const first = await session.submit('one');
  expect((await first.wait()).finalOutput).toBe('first');
  const second = await session.submit('two');
  expect((await second.wait()).finalOutput).toBe('second');
  expect(first.turnId).not.toBe(second.turnId);
  expect(observed.calls).toContain(first.turnId);
  expect(observed.calls).toContain(second.turnId);
  expect((await first.wait()).finalOutput).toBe('first');
  const replay = await Array.fromAsync(first.events());
  expect(
    replay
      .flatMap((event) =>
        event.type === 'output_text_delta' ? [event.delta] : [],
      )
      .join(''),
  ).toBe('first');
  await session.close();
  expect(observed.active.size).toBe(0);
  expect(observed.overlaps).toBe(0);
  server.assertExhausted();
}, 30_000);

it.each(['turn', 'session'] as const)(
  'late %s observation publishes text before the held provider completes',
  async (kind) => {
    const observed = await reads();
    await using peer = await heldPeer();
    await using provider = new NativeProvider({
      baseUrl: peer.baseUrl,
      apiKey: 'synthetic-prefix',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const turn = await session.submit('one');
    await peer.sent.promise;
    await observed.entered.promise;
    const reader = (kind === 'turn' ? turn.events() : session.events())[
      Symbol.asyncIterator
    ]();
    let sequence = 0;
    await vi.waitFor(
      async () => {
        while (true) {
          const next = await reader.next();
          if (next.done) throw new Error('Reader ended before held text');
          if (next.value.type === 'action_requested')
            throw new Error('Unexpected manual request');
          expect(next.value.sequence).toBeGreaterThan(sequence);
          sequence = next.value.sequence;
          if (next.value.type === 'output_text_delta') {
            expect(next.value.delta).toBe('first');
            break;
          }
        }
      },
      { timeout: 5_000 },
    );
    await reader.return?.();
    // Detachment does not resume collection or stop the original work.
    const count = observed.calls.length;
    peer.release.resolve();
    expect((await turn.wait()).finalOutput).toBe('first');
    expect(observed.calls).toHaveLength(count);
    await session.close();
    expect(observed.active.size).toBe(0);
    expect(observed.overlaps).toBe(0);
  },
  30_000,
);

it('joins the original native read when reduction of a drained prefix fails', async () => {
  const observed = await reads();
  await using peer = await heldPeer();
  await using provider = new NativeProvider({
    baseUrl: peer.baseUrl,
    apiKey: 'synthetic-prefix',
    supportsWebsockets: false,
  });
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  try {
    const turn = await session.submit('one');
    const completion = turn.wait();
    void completion.catch(() => {});
    await peer.sent.promise;
    await observed.entered.promise;
    await vi.waitFor(() => expect(observed.active.size).toBe(1));
    vi.spyOn(
      observed.prototype,
      '_stop_session_event_collection',
    ).mockImplementation(function (this: NativeThread) {
      observed.stop.call(this); // Transfer the real prefix before injecting a bridge parse failure.
      return ['not-json'];
    });
    const reader = turn.events();
    void reader.next().catch(() => {});
    await expect(completion).rejects.toThrow();
    await session.close();
    expect(observed.active.size).toBe(0);
    expect(observed.overlaps).toBe(0);
    await reader.return?.();
  } finally {
    peer.release.resolve();
    await session.close();
  }
}, 30_000);

it.each(['beforeStep', 'prepareRequest', 'output', 'tools'] as const)(
  'keeps a later per-send %s override ordinary',
  async (kind) => {
    const observed = await reads();
    const server = new ModelServer([[message('first')], [message('second')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    await (await session.submit('first')).wait();
    expect(observed.calls.length).toBeGreaterThan(0);
    const count = observed.calls.length;
    let callbacks = 0;
    const options =
      kind === 'beforeStep'
        ? {
            beforeStep: () => {
              callbacks++;
              return undefined;
            },
          }
        : kind === 'prepareRequest'
          ? {
              prepareRequest: () => {
                callbacks++;
                return undefined;
              },
            }
          : kind === 'output'
            ? { outputType: z.string() }
            : { tools: [] };
    expect(
      (await (await session.submit('second', options)).wait()).finalOutput,
    ).toBe('second');
    expect(observed.calls).toHaveLength(count);
    if (kind === 'beforeStep' || kind === 'prepareRequest')
      expect(callbacks).toBeGreaterThan(0);
    server.assertExhausted();
  },
  30_000,
);

it('publishes a collector result exactly once when observation attaches after native resolution', async () => {
  const native = await binding();
  const prototype = native.NativeThread.prototype;
  const collect = prototype._next_owned_session_events;
  expect(typeof collect).toBe('function');
  const stop = vi.spyOn(prototype, '_stop_session_event_collection');
  let attach = () => {};
  let attached = false;
  vi.spyOn(prototype, '_next_owned_session_events').mockImplementation(
    function (this: NativeThread, turn, seen) {
      const pending = collect.call(this, turn, seen);
      void pending.then(
        (rows) => {
          if (
            !attached &&
            rows.some(
              (row) =>
                JSON.parse(row).msg.type === 'agent_message_content_delta',
            )
          ) {
            attached = true;
            attach(); // Rust already moved this batch into its ORIGINAL result.
          }
        },
        () => {},
      );
      return pending;
    },
  );
  const server = new ModelServer([streamingMessage('first', 'resolved-race')]);
  await using provider = await providerFor(server);
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  let reader: ReturnType<typeof session.events> | undefined;
  attach = () => {
    reader = session.events();
  };
  try {
    expect((await (await session.submit('one')).wait()).finalOutput).toBe(
      'first',
    );
    expect(attached).toBe(true);
    await session.close();
    const events = await Array.fromAsync(reader!);
    expect(
      events
        .flatMap((event) =>
          event.type === 'output_text_delta' ? [event.delta] : [],
        )
        .join(''),
    ).toBe('first');
    // Either race winner is valid; a drain after native commit owns no rows.
    for (const result of stop.mock.results) {
      expect(result.type).toBe('return');
      expect(result.value).toEqual([]);
    }
    server.assertExhausted();
  } finally {
    await reader?.return?.();
    await session.close();
  }
}, 30_000);

it('terminates a Worker with its original collector read pending', async () => {
  await using peer = await heldPeer();
  const sdk = new URL('../../dist/index.mjs', import.meta.url).href;
  const bindingModule = new URL(
    '../../dist/runtime/binding.mjs',
    import.meta.url,
  ).href;
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { Agent, NativeProvider } = await import(${JSON.stringify(sdk)});
    const { binding } = await import(${JSON.stringify(bindingModule)});
    const native = await binding();
    const original = native.NativeThread.prototype._next_owned_session_events;
    if (typeof original !== 'function') throw new Error('Wrong native collector binary');
    let current;
    let armed = false;
    function inspectPending() {
      const candidate = current;
      setImmediate(() => {
        if (armed && candidate && candidate === current && !candidate.settled) {
          armed = false;
          parentPort.postMessage('pending');
        }
      });
    }
    parentPort.on('message', message => {
      if (message === 'inspect-pending') { armed = true; inspectPending(); }
    });
    native.NativeThread.prototype._next_owned_session_events = function (...args) {
      const pending = Reflect.apply(original, this, args);
      const read = { pending, settled: false };
      current = read;
      void pending.then(() => { read.settled = true; }, () => { read.settled = true; });
      if (armed) inspectPending();
      return pending;
    };
    const provider = new NativeProvider({ baseUrl: workerData.baseUrl, apiKey: 'synthetic-worker-prefix', supportsWebsockets: false });
    let session;
    try {
      session = await new Agent({ instructions: 'Answer.', model: 'gpt-5', provider }).session();
      await (await session.submit('one')).wait();
    } finally { await session?.close(); await provider.close(); }
  `;
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    { workerData: { baseUrl: peer.baseUrl } },
  );
  try {
    const pending = once(worker, 'message', {
      signal: AbortSignal.timeout(10_000),
    });
    const [, message] = await Promise.all([
      peer.sent.promise.then(() => worker.postMessage('inspect-pending')),
      pending,
    ]);
    expect(message[0]).toBe('pending');
    expect(await worker.terminate()).toBe(1);
  } finally {
    await worker.terminate();
  }
  // Forced Worker termination proves bounded exit/no native crash, not GC
  // deadlines or complete background-drain/home-removal guarantees.
}, 30_000);
