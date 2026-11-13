import { once } from 'node:events';
import { binding, type NativeThread } from '../../src/runtime/binding';
import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  ResponsesWebSocketModel,
  type ModelRequest,
} from '../../src';

type Wire = Record<string, any>;
const servers: WebSocketServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const final = (text: string) => ({
  type: 'message',
  id: 'msg_' + text,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
function reply(socket: WebSocket, id: string, output: Wire[]) {
  socket.send(
    JSON.stringify({
      type: 'response.created',
      response: { id, status: 'in_progress', output: [] },
    }),
  );
  for (const [output_index, item] of output.entries())
    socket.send(
      JSON.stringify({ type: 'response.output_item.done', output_index, item }),
    );
  socket.send(
    JSON.stringify({
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    }),
  );
}
async function fixture(onFrame: (frame: Wire, socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  const frames: Wire[] = [];
  let connections = 0;
  let closes = 0;
  const headers: unknown[] = [];
  server.on('connection', (socket, request) => {
    connections++;
    headers.push(request.headers['x-fixture']);
    socket.on('close', () => closes++);
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      onFrame(frame, socket);
    });
  });
  const client = new OpenAI({
    apiKey: 'synthetic-borrowed',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  });
  return {
    client,
    frames,
    headers,
    connections: () => connections,
    closes: () => closes,
  };
}

it('borrows the real client through native handoff and reuses it in a fresh run', async () => {
  let requests = 0;
  const call = {
    type: 'function_call',
    id: 'fc_borrowed',
    call_id: 'call_borrowed',
    name: 'transfer_to_b',
    arguments: '{}',
  };
  const f = await fixture((frame, socket) => {
    requests++;
    expect(frame.type).toBe('response.create');
    expect(frame).not.toHaveProperty('stream');
    if (requests === 1) reply(socket, 'resp_first', [call]);
    else {
      if (requests === 2)
        expect(frame.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_output',
            call_id: call.call_id,
          }),
        );
      reply(socket, 'resp_' + requests, [final('done')]);
    }
  });
  const seen: ModelRequest[] = [];
  const model = new ResponsesWebSocketModel(
    (_request, options) =>
      new ResponsesWS(f.client, { headers: options.headers as any }),
    undefined,
    {
      requestOptions(request) {
        seen.push(request);
        return { headers: { 'x-fixture': 'captured' } };
      },
    },
  );
  await using provider = new NativeProvider({
    modelBackend: model,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-provider',
  });
  const target = new Agent({ name: 'B', instructions: 'Finish.' });
  const agent = new Agent({
    name: 'A',
    provider,
    model: 'gpt-5.5',
    instructions: 'Transfer to B.',
    handoffs: [target],
  });
  expect((await agent.run('start')).finalOutput).toBe('done');
  expect(f.connections()).toBe(1);
  await expect.poll(f.closes).toBe(1);
  expect(seen[1].runOwner).toBe(seen[0].runOwner);
  expect(seen[0].body).not.toHaveProperty('runOwner');
  expect((await agent.run('again')).finalOutput).toBe('done');
  expect(seen[2].runOwner).not.toBe(seen[0].runOwner);
  expect(f.connections()).toBe(2);
  await expect.poll(f.closes).toBe(2);
  expect(f.headers).toEqual(['captured', 'captured']);
  expect(f.client.apiKey).toBe('synthetic-borrowed');
}, 20_000);

it('closes a public borrowed socket after I/O cancellation without replay', async () => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture((_frame, socket) => {
    socket.send(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_partial', output: [] },
      }),
    );
    entered.resolve();
  });
  const model = new ResponsesWebSocketModel(() => new ResponsesWS(f.client));
  await using provider = new NativeProvider({
    modelBackend: model,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-provider',
  });
  const controller = new AbortController();
  const pending = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Wait.',
  }).run('start', { signal: controller.signal });
  void pending.catch(() => {});
  await Promise.race([entered.promise, pending]);
  controller.abort(new Error('synthetic abort'));
  await expect(pending).rejects.toThrow();
  await expect.poll(f.closes).toBe(1);
  expect(f.frames).toHaveLength(1);
  expect(f.connections()).toBe(1);
}, 20_000);

it('closes on a post-send read timeout without issuing a second create', async () => {
  const f = await fixture(() => {});
  const model = new ResponsesWebSocketModel(
    () => new ResponsesWS(f.client),
    undefined,
    { requestOptions: { timeoutMs: 20 } },
  );
  await using provider = new NativeProvider({
    modelBackend: model,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-provider',
  });
  await expect(
    new Agent({ provider, model: 'gpt-5.5', instructions: 'Wait.' }).run(
      'start',
    ),
  ).rejects.toThrow(/timed out/);
  await expect.poll(f.closes).toBe(1);
  expect(f.frames).toHaveLength(1);
  expect(f.connections()).toBe(1);
}, 20_000);

it('keeps the public socket across a separately admitted retained SDK step', async () => {
  const native = await binding();
  const next = native.NativeThread.prototype._next_session_events;
  const submit = native.NativeThread.prototype._submit;
  let projected = false;
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    const raw = await next.call(this);
    const event = JSON.parse(firstNativeBatchWire(raw));
    if (
      !projected &&
      !event.subagent_id &&
      ['task_complete', 'turn_complete'].includes(event.msg.type)
    ) {
      projected = true;
      event.sdk_unsampled_steering = true;
      return replaceSingletonNativeBatchEvent(raw, event);
    }
    return raw;
  });
  vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
    async function (this: NativeThread, raw) {
      const request = JSON.parse(raw);
      if (request.mode !== 'continue_if_idle') return submit.call(this, raw);
      return submit.call(
        this,
        JSON.stringify({
          mode: 'start_if_idle',
          input: [{ type: 'text', text: 'retained input' }],
          start: request.start,
        }),
      );
    },
  );
  let count = 0;
  const f = await fixture((_frame, socket) => {
    count++;
    reply(socket, 'resp_' + count, [final(count === 1 ? 'first' : 'last')]);
  });
  const seen: ModelRequest[] = [];
  const model = new ResponsesWebSocketModel(
    () => new ResponsesWS(f.client),
    undefined,
    {
      requestOptions(request) {
        seen.push(request);
        return {};
      },
    },
  );
  await using provider = new NativeProvider({
    modelBackend: model,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-provider',
  });
  expect(
    (
      await new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Finish.',
      }).run('start')
    ).finalOutput,
  ).toBe('last');
  expect(seen).toHaveLength(2);
  expect(seen[0].turnId).not.toBe(seen[1].turnId);
  expect(seen[0].runOwner).toBe(seen[1].runOwner);
  expect(f.frames.map((frame) => frame.type)).toEqual([
    'response.create',
    'response.create',
  ]);
  expect(f.connections()).toBe(1);
  await expect.poll(f.closes).toBe(1);
}, 20_000);

it('closes before reporting a definitive provider failure', async () => {
  const f = await fixture((_frame, socket) => {
    socket.send(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_failed', output: [] },
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_failed',
          status: 'failed',
          output: [],
          error: {
            code: 'invalid_request_error',
            message: 'synthetic failure',
          },
        },
      }),
    );
  });
  const model = new ResponsesWebSocketModel(() => new ResponsesWS(f.client));
  await using provider = new NativeProvider({
    modelBackend: model,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-provider',
  });
  await expect(
    new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Finish.',
      modelSettings: { retry: { maxRetries: 0 } },
    }).run('start'),
  ).rejects.toThrow();
  await expect.poll(f.closes).toBe(1);
  expect(f.frames).toHaveLength(1);
}, 20_000);

it('runs model cleanup inside the existing owned callback guard', async () => {
  const f = await fixture((_frame, socket) =>
    reply(socket, 'resp_guard', [final('done')]),
  );
  const model = new ResponsesWebSocketModel(() => new ResponsesWS(f.client));
  const close = model.cleanupOnRunEnd.bind(model);
  await using provider = new NativeProvider({
    modelBackend: model,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-provider',
  });
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Finish.',
  }).session();
  let guarded = 0;
  model.cleanupOnRunEnd = async (owner) => {
    await expect(session.submit('reentrant')).rejects.toThrow(/callback/);
    guarded++;
    await close(owner);
  };
  expect((await (await session.submit('start')).wait()).finalOutput).toBe(
    'done',
  );
  expect(guarded).toBe(1);
  expect(f.frames).toHaveLength(1);
  await expect.poll(f.closes).toBe(1);
}, 20_000);
