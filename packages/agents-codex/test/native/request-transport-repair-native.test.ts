import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['agent', 'updated', 'operation'] as const)(
  'retains owned transport through prompted repair: %s',
  async (mode) => {
    const server = new ModelServer([
      [message('{"label":"x"}')],
      [message('{"label":"fixed"}')],
      [message('{"label":"later"}')],
    ]);
    const routes: Array<string | null> = [];
    server.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST')
        routes.push(
          new URL(
            (detail as { path: string }).path,
            'http://loopback.invalid',
          ).searchParams.get('route'),
        );
    };
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
      queryParams: { route: 'provider' },
      headers: { 'x-routing': 'provider' },
      supportsWebsockets: false,
      apiKey: 'synthetic-repair-transport',
    });
    const agent = new Agent({
      instructions: 'Return JSON.',
      model: 'gpt-5',
      provider,
      modelSettings: {
        extraHeaders: { 'x-routing': 'agent' },
        extraQuery: { route: 'agent' },
      },
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string().min(2) }),
        maxRetries: 1,
      },
    });
    await using session = await agent.session();
    if (mode === 'updated') {
      await session.update({
        modelSettings: { extraHeaders: { 'x-routing': 'updated' } },
      });
      await session.update({ modelSettings: { extraQuery: null } });
    }
    const first = await session.submit(
      'First.',
      mode === 'operation'
        ? {
            modelSettingsOverride: {
              extraHeaders: { 'x-routing': 'operation' },
              extraQuery: { route: 'operation' },
            },
          }
        : undefined,
    );
    expect((await first.wait()).finalOutput).toEqual({ label: 'fixed' });
    const later = await session.submit('Later.');
    expect((await later.wait()).finalOutput).toEqual({ label: 'later' });
    const baseHeader = mode === 'updated' ? 'updated' : 'agent';
    const baseRoute = mode === 'updated' ? 'provider' : 'agent';
    expect(
      server.requestHeaders.map((headers) => headers['x-routing']),
    ).toEqual(
      mode === 'operation'
        ? ['operation', 'operation', baseHeader]
        : [baseHeader, baseHeader, baseHeader],
    );
    expect(routes).toEqual(
      mode === 'operation'
        ? ['operation', 'operation', baseRoute]
        : [baseRoute, baseRoute, baseRoute],
    );
    server.assertExhausted();
  },
  25_000,
);

it('uses Worker transport after a real handoff and prompted repair', async () => {
  const server = new ModelServer([
    [call('transfer_to_worker', {}, { callId: 'repair-handoff' })],
    [message('{"label":"x"}')],
    [message('{"label":"fixed"}')],
  ]);
  const routes: Array<string | null> = [];
  server.onRecord = (phase, detail) => {
    if (phase === 'MODEL_REQUEST')
      routes.push(
        new URL(
          (detail as { path: string }).path,
          'http://loopback.invalid',
        ).searchParams.get('route'),
      );
  };
  await using provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    queryParams: { route: 'provider' },
    headers: { 'x-routing': 'provider' },
    supportsWebsockets: false,
    apiKey: 'synthetic-profile-repair-transport',
  });
  const outputType = {
    mode: 'prompted' as const,
    schema: z.object({ label: z.string().min(2) }),
    maxRetries: 1,
  };
  const worker = new Agent({
    name: 'Worker',
    instructions: 'Return JSON.',
    model: 'gpt-5.5',
    provider,
    modelSettings: {
      extraHeaders: { 'x-routing': 'worker' },
      extraQuery: { route: 'worker' },
    },
    outputType,
  });
  const agent = new Agent({
    name: 'Root',
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider,
    handoffs: [worker],
    outputType,
    modelSettings: {
      extraHeaders: { 'x-routing': 'root' },
      extraQuery: { route: 'root' },
    },
  });
  await using session = await agent.session();
  await session.update({
    modelSettings: {
      extraHeaders: { 'x-routing': 'updated-root' },
      extraQuery: { route: 'updated-root' },
    },
  });
  const turn = await session.submit('Delegate to Worker.');
  expect((await turn.wait()).finalOutput).toEqual({ label: 'fixed' });
  expect(server.requestHeaders.map((headers) => headers['x-routing'])).toEqual([
    'updated-root',
    'worker',
    'worker',
  ]);
  expect(routes).toEqual(['updated-root', 'worker', 'worker']);
  server.assertExhausted();
}, 25_000);
