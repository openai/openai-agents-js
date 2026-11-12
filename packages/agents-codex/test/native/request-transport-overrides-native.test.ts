import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'non-credential-transport-fixture',
    headers: { 'x-routing': 'provider', 'x-omit': 'provider' },
    queryParams: { route: 'provider' },
    // Omission has been preserving the automatic HTTP choice for this custom endpoint.
  });
}

it('keeps the automatic custom-endpoint HTTP route without transport overrides', async () => {
  const server = new ModelServer([[message('done')]]);
  await using source = await provider(server);
  const agent = new Agent({
    provider: source,
    model: 'fixture',
    instructions: 'Respond.',
  });
  expect((await agent.run('Baseline.')).finalOutput).toBe('done');
  expect(server.requests).toHaveLength(1);
  expect(server.requestHeaders[0]?.upgrade).toBeUndefined();
});

it('sends scoped public query and header overrides and restores provider defaults on the next run', async () => {
  const server = new ModelServer([[message('first')], [message('second')]]);
  const paths: string[] = [];
  server.onRecord = (phase, detail) => {
    if (phase === 'MODEL_REQUEST')
      paths.push(String((detail as { path: string }).path));
  };
  await using source = await provider(server);
  const agent = new Agent({
    provider: source,
    model: 'fixture',
    instructions: 'Respond.',
  });
  expect(
    (
      await agent.run('Override.', {
        modelSettings: {
          extraHeaders: { 'x-routing': 'request', 'x-omit': null },
          extraQuery: {
            route: 'request',
            tags: ['one', 'two'],
            count: 2,
            empty: null,
          },
        },
      })
    ).finalOutput,
  ).toBe('first');
  expect((await agent.run('Defaults.')).finalOutput).toBe('second');
  expect(server.requestHeaders[0]?.['x-routing']).toBe('request');
  expect(server.requestHeaders[0]?.['x-omit']).toBeUndefined();
  expect(server.requestHeaders[1]?.['x-routing']).toBe('provider');
  expect(server.requestHeaders[1]?.['x-omit']).toBe('provider');
  const first = new URL(paths[0]!, 'http://loopback.invalid');
  const second = new URL(paths[1]!, 'http://loopback.invalid');
  expect(first.searchParams.get('route')).toBe('request');
  expect(first.searchParams.getAll('tags[]')).toEqual(['one', 'two']);
  expect(first.searchParams.get('count')).toBe('2');
  expect(first.searchParams.get('empty')).toBe('');
  expect(second.searchParams.get('route')).toBe('provider');
  expect(
    server.requestHeaders.every((headers) => headers.upgrade === undefined),
  ).toBe(true);
});

it('keeps per-turn transport out of portable state and retains independent defaults', async () => {
  const server = new ModelServer([
    [message('before restore')],
    [message('after restore')],
    [message('default turn')],
  ]);
  const query: Array<string | null> = [];
  server.onRecord = (phase, detail) => {
    if (phase === 'MODEL_REQUEST') {
      const { path } = detail as { path: string };
      query.push(
        new URL(path, 'http://loopback.invalid').searchParams.get('route'),
      );
    }
  };
  await using source = await provider(server);
  const agent = new Agent({
    provider: source,
    model: 'fixture',
    instructions: 'Respond.',
    modelSettings: {
      extraHeaders: { 'x-routing': 'agent-header' },
      extraQuery: { route: 'agent-query' },
    },
  });

  const headerOverride = 'synthetic-first-turn-header';
  const queryOverride = 'synthetic-restored-turn-query';
  await using initial = await agent.session();
  const first = await initial.submit('Original input in saved history.', {
    modelSettingsOverride: { extraHeaders: { 'x-routing': headerOverride } },
  });
  expect((await first.wait()).finalOutput).toBe('before restore');
  const checkpoint = await initial.saveState();
  expect(JSON.stringify(checkpoint)).not.toContain(headerOverride);
  await initial.close();

  await using restored = await agent.session({ state: checkpoint });
  const second = await restored.submit('Restored input.', {
    modelSettingsOverride: { extraQuery: { route: queryOverride } },
  });
  expect((await second.wait()).finalOutput).toBe('after restore');
  expect(JSON.stringify(await restored.saveState())).not.toContain(
    queryOverride,
  );
  const third = await restored.submit('Use the Agent defaults again.');
  expect((await third.wait()).finalOutput).toBe('default turn');

  expect(server.requestHeaders.map((headers) => headers['x-routing'])).toEqual([
    headerOverride,
    'agent-header',
    'agent-header',
  ]);
  expect(query).toEqual(['agent-query', queryOverride, 'agent-query']);
  expect(JSON.stringify(server.requests[1]?.input)).toContain(
    'Original input in saved history.',
  );
  for (const request of server.requests)
    expect(request).not.toHaveProperty('request_transport');
  server.assertExhausted();
});

it('uses scoped transport on the automatic Responses WebSocket request', async () => {
  const server = new ModelServer([]);
  const sockets = new WebSocketServer({ noServer: true });
  const samples: Array<{ route: string | null; header: string | undefined }> =
    [];
  const upgrades: Array<string | undefined> = [];
  server.onUpgrade((request, socket, head) => {
    const header = request.headers['x-routing'];
    const routeHeader = typeof header === 'string' ? header : undefined;
    const route = new URL(
      request.url ?? '/',
      'http://loopback.invalid',
    ).searchParams.get('route');
    upgrades.push(routeHeader);
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { generate?: boolean };
        const warmup = frame.generate === false;
        if (!warmup) samples.push({ route, header: routeHeader });
        const id = warmup ? 'warmup' : `sample-${samples.length}`;
        const send = (event: object) => connection.send(JSON.stringify(event));
        send({ type: 'response.created', response: { id } });
        if (!warmup)
          send({
            type: 'response.output_item.done',
            output_index: 0,
            item: message('socket answer'),
          });
        send({ type: 'response.completed', response: { id } });
      });
    });
  });
  try {
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
      queryParams: { route: 'provider' },
      supportsWebsockets: true,
      apiKey: 'synthetic-websocket',
      headers: { 'x-routing': 'provider' },
    });
    const agent = new Agent({
      model: 'gpt-5',
      instructions: 'Respond.',
      provider,
      modelSettings: {
        extraHeaders: { 'x-routing': 'agent' },
        extraQuery: { route: 'agent' },
      },
    });
    await using session = await agent.session();
    const first = await session.submit('Scoped.', {
      modelSettingsOverride: {
        extraHeaders: { 'x-routing': 'operation' },
        extraQuery: { route: 'operation' },
      },
    });
    expect((await first.wait()).finalOutput).toBe('socket answer');
    const second = await session.submit('Defaults.');
    expect((await second.wait()).finalOutput).toBe('socket answer');
    const checkpoint = await session.saveState();
    await session.close();
    await using restored = await agent.session({ state: checkpoint });
    const third = await restored.submit('Restored defaults.');
    expect((await third.wait()).finalOutput).toBe('socket answer');
    expect(samples).toEqual([
      { route: 'operation', header: 'operation' },
      { route: 'agent', header: 'agent' },
      { route: 'agent', header: 'agent' },
    ]);
    expect(upgrades).not.toContain('provider');
    expect(server.requests).toHaveLength(0);
  } finally {
    for (const connection of sockets.clients) connection.terminate();
    sockets.close();
  }
}, 15_000);
