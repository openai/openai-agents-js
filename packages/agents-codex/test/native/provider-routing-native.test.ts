import { afterEach, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type NativeProviderOptions } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

async function urlFor(model: ModelServer) {
  const config = await model.config();
  return (config['model_providers.fixture'] as { base_url: string }).base_url;
}
afterEach(async () => {
  try {
    await ModelServer.closeAll();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('captures header/env/query/org/project routing and preserves duplicates and literal query values', async () => {
  vi.stubEnv('B02_ROUTE_ENV', 'env-original-canary');
  vi.stubEnv('B02_NEVER_SET', undefined);
  const server = new ModelServer(
    Array.from({ length: 3 }, () => [message('routed')]),
  );
  const paths: string[] = [];
  server.onRecord = (phase, detail) => {
    if (phase === 'MODEL_REQUEST')
      paths.push((detail as { path: string }).path);
  };
  const headers = { 'X-Route': 'header-original-canary' };
  const query = {
    existing: 'three',
    reserved: 'a&=+% /☃',
    empty: '',
    canary: 'query-original-canary',
  };
  await using provider = new NativeProvider({
    baseUrl: (await urlFor(server)) + '?existing=one&existing=two',
    apiKey: 'synthetic-routing-key',
    supportsWebsockets: false,
    headers,
    envHeaders: { 'X-Env': 'B02_ROUTE_ENV', 'X-Missing': 'B02_NEVER_SET' },
    queryParams: query,
    organization: 'org-original-canary',
    project: 'project-original-canary',
  });
  headers['X-Route'] = 'mutated';
  query.reserved = 'mutated';
  vi.stubEnv('B02_ROUTE_ENV', 'env-changed-canary');
  const agent = new Agent({
    model: 'fixture-unlisted-routing',
    instructions: 'Answer.',
    provider,
  });
  const session = await agent.session();
  let saved;
  try {
    await (await session.submit('first')).wait();
    saved = await session.saveState();
  } finally {
    await session.close();
  }
  await agent.run('fresh session');
  {
    await using restored = await agent.session({ state: saved! });
    await (await restored.submit('restore current provider')).wait();
  }
  for (const path of paths) {
    const parsed = new URL(path, 'http://fixture.invalid');
    expect(parsed.pathname).toBe('/v1/responses');
    expect(parsed.searchParams.getAll('existing')).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(parsed.searchParams.get('reserved')).toBe('a&=+% /☃');
    expect(parsed.searchParams.get('empty')).toBe('');
  }
  expect(paths).toHaveLength(3);
  for (const actual of server.requestHeaders) {
    expect(actual['x-route']).toBe('header-original-canary');
    expect(actual['x-env']).toBe('env-original-canary');
    expect(actual['openai-organization']).toBe('org-original-canary');
    expect(actual['openai-project']).toBe('project-original-canary');
    expect(actual).not.toHaveProperty('x-missing');
    expect(actual).not.toHaveProperty('x-sdk-sentinel-grant');
  }
  for (const secret of [
    'header-original-canary',
    'env-original-canary',
    'query-original-canary',
    'org-original-canary',
    'project-original-canary',
  ]) {
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(provider)).not.toContain(secret);
  }
  server.assertExhausted();
}, 35_000);

it.each(['same', 'foreign'] as const)(
  'blocks %s-origin redirect on both upstream and private hops with custom routing',
  async (origin) => {
    let location = '';
    const source = new ModelServer([
      () => ({
        status: 307,
        body: 'synthetic redirect',
        headers: { location },
      }),
    ]);
    const foreign = new ModelServer([]);
    location =
      (origin === 'same' ? await urlFor(source) : await urlFor(foreign)) +
      '/redirected';
    await using provider = new NativeProvider({
      baseUrl: await urlFor(source),
      apiKey: 'synthetic-redirect-key',
      supportsWebsockets: false,
      headers: { 'X-Route': 'redirect-header-canary' },
    });
    await expect(
      new Agent({
        model: 'fixture-unlisted-routing',
        instructions: 'Answer.',
        provider,
      }).run('do not follow'),
    ).rejects.toThrow();
    expect(source.requests).toHaveLength(1);
    expect(foreign.requests).toHaveLength(0);
    expect(source.requestHeaders[0]?.['x-route']).toBe(
      'redirect-header-canary',
    );
    expect(source.requestHeaders[0]).not.toHaveProperty('x-sdk-sentinel-grant');
    source.assertExhausted();
    foreign.assertExhausted();
  },
  35_000,
);

it.each(['same', 'foreign'] as const)(
  'preserves the current upstream %s-origin redirect behavior without custom routing',
  async (origin) => {
    let location = '';
    const source = new ModelServer(
      origin === 'same'
        ? [
            () => ({
              status: 307,
              body: 'synthetic redirect',
              headers: { location },
            }),
            [message('same-origin final')],
          ]
        : [
            () => ({
              status: 307,
              body: 'synthetic redirect',
              headers: { location },
            }),
          ],
    );
    const foreign = new ModelServer(
      origin === 'foreign' ? [[message('foreign final')]] : [],
    );
    location =
      (origin === 'same' ? await urlFor(source) : await urlFor(foreign)) +
      '/redirected';
    await using provider = new NativeProvider({
      baseUrl: await urlFor(source),
      apiKey: 'synthetic-redirect-key',
      supportsWebsockets: false,
    });
    const result = await new Agent({
      model: 'fixture-unlisted-routing',
      instructions: 'Answer.',
      provider,
    }).run('default behavior');
    expect(result.finalOutput).toBe(
      origin === 'same' ? 'same-origin final' : 'foreign final',
    );
    expect(source.requests).toHaveLength(origin === 'same' ? 2 : 1);
    expect(foreign.requests).toHaveLength(origin === 'foreign' ? 1 : 0);
    for (const actual of [...source.requestHeaders, ...foreign.requestHeaders])
      expect(actual).not.toHaveProperty('x-sdk-sentinel-grant');
    source.assertExhausted();
    foreign.assertExhausted();
  },
  35_000,
);

it.each([
  { headers: { Authorization: 'forged' } },
  { headers: { 'X-SDK-Sentinel-Grant': 'forged' } },
  { headers: { 'X-Codex-Turn-State': 'forged' } },
  { headers: { 'X-Route': 'line\r\nbreak' } },
  { headers: { 'X-Route': 'one' }, envHeaders: { 'x-route': 'B02_ENV' } },
  { headers: { 'OpenAI-Organization': 'use-dedicated-field' } },
  { organization: '' },
  { queryParams: { bad: 7 } },
])(
  'rejects a transport/auth routing conflict before opening: %j',
  (options) => {
    expect(
      () => new NativeProvider(options as NativeProviderOptions),
    ).toThrow();
  },
);
