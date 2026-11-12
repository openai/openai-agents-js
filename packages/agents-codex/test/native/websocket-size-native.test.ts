import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import {
  encode,
  type Engine,
  type JsonObject,
} from '../../src/runtime/binding';

const limit = 64 * 1024 * 1024;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function input(text: string) {
  return [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  ];
}

// Calibrate against the final JSON envelope, including string escaping. Keep
// large strings out of expectations and spies so failures cannot print them.
function padded(body: JsonObject, bytes: number, unit = 'a'): JsonObject {
  const empty = { ...body, input: input('') };
  const remaining = bytes - Buffer.byteLength(encode(empty), 'utf8');
  const unitBytes = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2;
  const copies = Math.floor(remaining / unitBytes);
  return {
    ...empty,
    input: input(unit.repeat(copies) + 'a'.repeat(remaining % unitBytes)),
  };
}

async function routePeer(
  restore: (body: JsonObject, request: number) => JsonObject,
  failure?: 'send' | 'receive',
  omitModel = false,
) {
  const routes = new NativeProviderRoutes();
  let origin = '';
  let grant = '';
  let request = 0;
  let restored = 0;
  let responseId = '';
  const restoredBytes: number[] = [];
  const sent: {
    bytes: number;
    characters: number;
    previous: unknown;
    inputs: number;
    hasModel: boolean;
  }[] = [];
  const failures: { nonce: string; oversized: boolean }[] = [];
  const remote = {
    available: true,
    headers: [],
    async send_text(payload: string) {
      const body = JSON.parse(payload) as JsonObject;
      sent.push({
        bytes: Buffer.byteLength(payload, 'utf8'),
        characters: payload.length,
        previous: body.previous_response_id,
        inputs: Array.isArray(body.input) ? body.input.length : 0,
        hasModel: Object.hasOwn(body, 'model'),
      });
      if (failure === 'send') throw new Error('Synthetic uncertain send');
    },
    async receive() {
      if (failure === 'receive') throw new Error('Synthetic disconnect');
      responseId = 'resp_size_' + sent.length;
      return {
        type: 'text',
        text: JSON.stringify({
          type: 'response.completed',
          response: { id: responseId },
        }),
      };
    },
    project_response_items: () => '[]',
    async close() {},
  };
  const engine = {
    _sentinel_bind(value: string, key: string) {
      origin = value;
      grant = key;
    },
    async _sentinel_open() {
      return remote;
    },
    async _sentinel_admit() {
      return JSON.stringify({
        control: 'size-fixture',
        kind: 'generation',
        model: 'fixture',
        model_omitted: omitModel,
        completion: { response_id: responseId, model: 'fixture', output: [] },
      });
    },
    async _sentinel_restore_schemas(
      _provider: string,
      _ticket: string,
      payload: string,
    ) {
      const body = restore(JSON.parse(payload) as JsonObject, ++restored);
      const encoded = encode(body);
      restoredBytes.push(Buffer.byteLength(encoded, 'utf8'));
      return encoded;
    },
    async _sentinel_websocket_failed(
      _provider: string,
      ticket: string,
      oversized: boolean,
    ) {
      const owner = JSON.parse(ticket) as { sdk_sentinel_nonce: string };
      failures.push({ nonce: owner.sdk_sentinel_nonce, oversized });
    },
  } as unknown as Engine;
  await routes.start({}, {});
  cleanup.push(() => routes.close());
  routes.bindEngine(engine);
  const provider = Buffer.from('fixture').toString('base64url');
  const socket = new WebSocket(
    origin.replace('http:', 'ws:') + '/p-' + provider + '/responses',
    { headers: { 'x-sdk-sentinel-grant': grant } },
  );
  cleanup.push(async () => socket.terminate());
  await once(socket, 'open');
  return {
    sent,
    failures,
    restoredBytes,
    async exchange(
      previous?: string,
      changed: JsonObject = {},
    ): Promise<'completed' | 'closed'> {
      const body: JsonObject = {
        type: 'response.create',
        ...(omitModel ? {} : { model: 'fixture' }),
        input: input('next'),
        ...changed,
        client_metadata: {
          sdk_sentinel_thread: 'size-fixture',
          sdk_sentinel_nonce: String(++request),
        },
      };
      if (previous) body.previous_response_id = previous;
      return new Promise((resolve, reject) => {
        const remove = () => {
          socket.off('message', completed);
          socket.off('close', closed);
          socket.off('error', failed);
        };
        const completed = () => {
          remove();
          resolve('completed');
        };
        const closed = () => {
          remove();
          resolve('closed');
        };
        const failed = (error: Error) => {
          remove();
          reject(error);
        };
        socket.once('message', completed);
        socket.once('close', closed);
        socket.once('error', failed);
        socket.send(encode(body), (error) => {
          if (error) failed(error);
        });
      });
    },
  };
}

// This uses the real loopback carrier and a fake native endpoint. It isolates
// final encoded sizing from Core model context limits and native admission.
it.each([
  ['ASCII boundary', 'a', limit, 'completed'],
  ['ASCII oversize', 'a', limit + 1, 'closed'],
  ['Unicode and escapes at boundary', '😀"\n\\', limit, 'completed'],
  ['Unicode and escapes oversize', '😀"\n\\', limit + 1, 'closed'],
] as const)(
  'checks final UTF-8 bytes: %s',
  async (_name, unit, bytes, outcome) => {
    const peer = await routePeer((body) => padded(body, bytes, unit));
    expect(await peer.exchange()).toBe(outcome);
    expect(peer.restoredBytes).toEqual([bytes]);
    if (outcome === 'completed') {
      expect(peer.sent.length).toBe(1);
      expect(peer.sent[0].bytes).toBe(limit);
      if (unit !== 'a') expect(peer.sent[0].characters).toBeLessThan(limit);
      expect(peer.failures).toEqual([]);
    } else {
      expect(peer.sent.length).toBe(0);
      expect(peer.failures).toEqual([{ nonce: '1', oversized: true }]);
    }
  },
  60_000,
);

it('sizes continuation deltas and rejects an oversized full resend', async () => {
  const peer = await routePeer((body, request) =>
    request === 1 ? padded(body, limit) : body,
  );
  expect(await peer.exchange()).toBe('completed');
  expect(await peer.exchange('resp_size_1')).toBe('completed');
  expect(peer.restoredBytes[1]).toBeGreaterThan(limit);
  expect(peer.sent.length).toBe(2);
  expect(peer.sent[1].bytes).toBeLessThan(1024);
  expect(peer.sent[1].previous).toBe('resp_size_1');
  expect(peer.sent[1].inputs).toBe(1);
  expect(peer.failures).toEqual([]);
  // Changed request properties prevent delta reuse and require the full input.
  expect(await peer.exchange('resp_size_2', { temperature: 0.5 })).toBe(
    'closed',
  );
  expect(peer.restoredBytes[2]).toBeGreaterThan(limit);
  expect(peer.sent.length).toBe(2);
  expect(peer.failures).toEqual([{ nonce: '3', oversized: true }]);
}, 60_000);

it('continues an omitted-model request using the admitted completion model', async () => {
  const restored: JsonObject[] = [];
  const peer = await routePeer(
    (body) => {
      restored.push(structuredClone(body));
      return body;
    },
    undefined,
    true,
  );
  const prompt = { id: 'pmpt_carrier_fixture' };
  expect(await peer.exchange(undefined, { prompt })).toBe('completed');
  expect(await peer.exchange('resp_size_1', { prompt })).toBe('completed');
  const fullInput = [...input('next'), ...input('next'), ...input('retry')];
  expect(await peer.exchange(undefined, { prompt, input: fullInput })).toBe(
    'completed',
  );
  expect(restored).toHaveLength(3);
  for (const body of restored) {
    expect(body).not.toHaveProperty('model');
    expect(body.prompt).toEqual(prompt);
  }
  expect(restored[1].input).toEqual([...input('next'), ...input('next')]);
  expect(peer.sent).toHaveLength(3);
  expect(peer.sent[0]).toMatchObject({ hasModel: false, inputs: 1 });
  expect(peer.sent[1]).toMatchObject({
    hasModel: false,
    previous: 'resp_size_1',
    inputs: 1,
  });
  expect(peer.sent[2]).toMatchObject({
    hasModel: false,
    previous: undefined,
    inputs: 3,
  });
  expect(peer.failures).toEqual([]);
});

it.each(['send', 'receive'] as const)(
  'keeps an uncertain %s failure distinct from oversize without retrying',
  async (failure) => {
    const peer = await routePeer((body) => body, failure);
    expect(await peer.exchange()).toBe('closed');
    expect(peer.sent.length).toBe(1);
    expect(peer.failures).toEqual([{ nonce: '1', oversized: false }]);
  },
);
