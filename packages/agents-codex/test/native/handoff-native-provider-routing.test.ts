import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Agent, NativeProvider, parseSessionState } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { call, message, ModelServer } from './fixtures/model-server';

it('keeps native provider credentials and response cursors scoped to the admitted Agent', async () => {
  const source = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'source-transfer' })],
  ]);
  const target = new ModelServer([
    [message('destination first')],
    [message('destination restored')],
    [message('destination forked')],
  ]);
  await using sourceProvider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await source.port()}/v1`,
    apiKey: 'synthetic-source-provider-key',
    headers: { 'x-provider-fixture': 'source' },
  });
  await using targetProvider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await target.port()}/v1`,
    apiKey: 'synthetic-target-provider-key',
    headers: { 'x-provider-fixture': 'target' },
  });
  const destination = new Agent({
    name: 'destination',
    instructions: 'Destination provider only.',
    provider: targetProvider,
  });
  const agent = new Agent({
    instructions: 'Source provider only.',
    provider: sourceProvider,
    handoffs: [destination],
  });
  let saved;
  let forked;
  {
    await using session = await agent.session();
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'destination first',
    );
    saved = await session.saveState();
    forked = await session.fork();
    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain('synthetic-source-provider-key');
    expect(serialized).not.toContain('synthetic-target-provider-key');
  }
  {
    await using restored = await agent.session({
      state: parseSessionState(JSON.stringify(saved)),
    });
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('destination restored');
  }
  {
    await using restored = await agent.session({ state: forked });
    expect(
      (await (await restored.submit('Continue fork.')).wait()).finalOutput,
    ).toBe('destination forked');
  }
  source.assertExhausted();
  target.assertExhausted();
  expect(source.requestHeaders[0]).toMatchObject({
    authorization: 'Bearer synthetic-source-provider-key',
    'x-provider-fixture': 'source',
  });
  for (const headers of target.requestHeaders) {
    expect(headers).toMatchObject({
      authorization: 'Bearer synthetic-target-provider-key',
      'x-provider-fixture': 'target',
    });
  }
  for (const request of target.requests) {
    expect(request.previous_response_id).toBeUndefined();
    expect(JSON.stringify(request.input)).toContain(
      'Destination provider only.',
    );
  }
  expect(target.requests[0]?.input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'source-transfer',
    }),
  );
});

it('keeps native WebSocket handoff cursors scoped to their provider', async () => {
  const servers = [new ModelServer([]), new ModelServer([])];
  const sockets = new WebSocketServer({ noServer: true });
  const requests: JsonObject[][] = [[], []];
  const authorization: Array<Array<string | undefined>> = [[], []];
  const sourceCall = call(
    'transfer_to_destination',
    {},
    { callId: 'source-transfer' },
  );
  const outputs = [sourceCall, message('destination response')];
  try {
    for (const [index, server] of servers.entries()) {
      server.onUpgrade((upgrade, socket, head) => {
        authorization[index]!.push(upgrade.headers.authorization);
        sockets.handleUpgrade(upgrade, socket, head, (connection) => {
          connection.on('message', (raw) => {
            const request = JSON.parse(raw.toString()) as JsonObject;
            const sampling = request.generate !== false;
            if (sampling) requests[index]!.push(request);
            // Both endpoints intentionally use the same provider response IDs.
            const id = sampling ? 'shared-response-id' : 'shared-warmup-id';
            const send = (frame: JsonObject) =>
              connection.send(JSON.stringify(frame));
            send({ type: 'response.created', response: { id } });
            if (sampling)
              send({
                type: 'response.output_item.done',
                output_index: 0,
                item: outputs[index]!,
              });
            send({ type: 'response.completed', response: { id } });
          });
        });
      });
    }
    await using sourceProvider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${await servers[0]!.port()}/v1`,
      apiKey: 'websocket-provider-0',
      supportsWebsockets: true,
    });
    await using targetProvider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${await servers[1]!.port()}/v1`,
      apiKey: 'websocket-provider-1',
      supportsWebsockets: true,
    });
    const destination = new Agent({
      name: 'destination',
      instructions: 'Destination websocket only.',
      provider: targetProvider,
    });
    const agent = new Agent({
      instructions: 'Source websocket only.',
      provider: sourceProvider,
      handoffs: [destination],
    });
    await using session = await agent.session();
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'destination response',
    );
    expect(requests.map((route) => route.length)).toEqual([1, 1]);
    for (const [index, seen] of authorization.entries()) {
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(
        new Set([`Bearer websocket-provider-${index}`]),
      );
    }
    expect(requests[1]![0]?.previous_response_id).toBeUndefined();
    expect(requests[1]![0]?.input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'source-transfer',
      }),
    );
    expect(JSON.stringify(requests[1]![0]?.input)).toContain(
      'Destination websocket only.',
    );
    for (const server of servers) server.assertExhausted();
  } finally {
    for (const connection of sockets.clients) connection.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
});

it('sends native compaction to the current handoff provider', async () => {
  const source = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'compact-transfer' })],
  ]);
  const target = new ModelServer([
    [message('destination response')],
    [message('destination summary')],
  ]);
  await using sourceProvider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await source.port()}/v1`,
    apiKey: 'compaction-source-key',
    supportsWebsockets: false,
  });
  await using targetProvider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await target.port()}/v1`,
    apiKey: 'compaction-target-key',
    supportsWebsockets: false,
  });
  const destination = new Agent({
    name: 'destination',
    instructions: 'Destination provider only.',
    provider: targetProvider,
  });
  const agent = new Agent({
    instructions: 'Source provider only.',
    provider: sourceProvider,
    handoffs: [destination],
  });
  await using session = await agent.session();
  expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
    'destination response',
  );
  await session.compact();
  source.assertExhausted();
  target.assertExhausted();
  expect(target.requestHeaders[1]?.authorization).toBe(
    'Bearer compaction-target-key',
  );
  expect(JSON.stringify(target.requests[1]?.input)).toContain(
    'destination response',
  );
});
