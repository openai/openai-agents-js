import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  tool,
  webSearch,
} from '../../src';
import { captureAgentProfiles } from '../../src/runtime/public-agent';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

const searchOptions = {
  route: 'hosted' as const,
  mode: 'live' as const,
  searchContextSize: 'high' as const,
  allowedDomains: ['example.com'],
  location: {
    country: 'US',
    region: 'NY',
    city: 'New York',
    timezone: 'America/New_York',
  },
  searchContentTypes: ['text', 'image'] as const,
  imageSettings: { maxResults: 3, caption: true },
};
const expectedSearch = {
  type: 'web_search',
  external_web_access: true,
  search_context_size: 'high',
  filters: { allowed_domains: ['example.com'] },
  user_location: {
    type: 'approximate',
    country: 'US',
    region: 'NY',
    city: 'New York',
    timezone: 'America/New_York',
  },
  search_content_types: ['text', 'image'],
  image_settings: { max_results: 3, caption: true },
};
function searchSpecs(request: JsonObject) {
  return (request.tools as JsonObject[]).filter(
    (tool) => tool.type === 'web_search',
  );
}
async function providerFor(server: ModelServer) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-scoped-search',
    supportsWebsockets: false,
    headers: { 'x-provider-fixture': 'scoped-hosted' },
  });
}

it('scopes hosted search to its destination, revokes it on return and keeps local tools', async () => {
  let localEffects = 0;
  const server = new ModelServer([
    (request) => {
      expect(searchSpecs(request)).toEqual([]);
      return [call('transfer_to_target', {}, { callId: 'search-out' })];
    },
    (request) => {
      expect(searchSpecs(request)).toEqual([expectedSearch]);
      return [call('transfer_to_source', {}, { callId: 'search-back' })];
    },
    (request) => {
      expect(searchSpecs(request)).toEqual([]);
      return [call('local_probe', {}, { callId: 'local-after-return' })];
    },
    (request) => {
      expect(searchSpecs(request)).toEqual([]);
      return [message('scoped search complete')];
    },
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'target',
    instructions: 'Search only in this target.',
    tools: [webSearch(searchOptions)],
    handoffs: [() => source],
  });
  const source: Agent<undefined, unknown> = new Agent({
    name: 'source',
    instructions: 'Model-only search authority.',
    provider,
    model: 'gpt-5.5',
    tools: [
      tool({
        name: 'local_probe',
        parameters: z.object({}),
        execute: () => {
          localEffects++;
          return 'local kept';
        },
      }),
    ],
    handoffs: [target],
  });
  await using session = await source.session();
  expect(
    (await (await session.submit('Transfer and return')).wait()).finalOutput,
  ).toBe('scoped search complete');
  expect(await session.getActiveAgent()).toBe(source);
  expect(localEffects).toBe(1);
  expect(
    server.requestHeaders.every(
      (headers) => headers['x-provider-fixture'] === 'scoped-hosted',
    ),
  ).toBe(true);
  server.assertExhausted();
}, 30_000);

it.each(['forced', 'cold'] as const)(
  'preserves scoped hosted-search settings and %s ownership',
  async (mode) => {
    const server = new ModelServer([
      (request) => {
        expect(searchSpecs(request)).toEqual([]);
        return [call('transfer_to_target', {}, { callId: 'search-select' })];
      },
      (request) => {
        expect(searchSpecs(request)).toEqual([expectedSearch]);
        if (mode === 'forced')
          expect(request.tool_choice).toEqual({ type: 'web_search' });
        return [message('target complete')];
      },
      ...(mode === 'cold'
        ? [
            (request: JsonObject) => {
              expect(searchSpecs(request)).toEqual([expectedSearch]);
              return [message('cold target complete')];
            },
          ]
        : []),
    ]);
    await using provider = await providerFor(server);
    const target = new Agent({
      name: 'target',
      instructions: 'Target owns search.',
      tools: [webSearch(searchOptions)],
      modelSettings:
        mode === 'forced' ? { toolChoice: { type: 'web_search' } } : undefined,
    });
    const source = new Agent({
      instructions: 'No source search.',
      provider,
      model: 'gpt-5.5',
      tools: [],
      handoffs: [target],
    });
    let state;
    {
      await using session = await source.session();
      expect(
        (await (await session.submit('Transfer')).wait()).finalOutput,
      ).toBe('target complete');
      expect(await session.getActiveAgent()).toBe(target);
      if (mode === 'cold') {
        const serialized = JSON.stringify(await session.saveState());
        state = parseSessionState(serialized, {
          expectedSha256: createHash('sha256').update(serialized).digest('hex'),
        });
      }
    }
    if (mode === 'cold') {
      await using restored = await source.session({ state });
      expect(await restored.getActiveAgent()).toBe(target);
      expect(
        (await (await restored.submit('Continue')).wait()).finalOutput,
      ).toBe('cold target complete');
    }
    server.assertExhausted();
  },
  30_000,
);

it('keeps homogeneous search and standalone grant capture on the existing path', async () => {
  const hosted = webSearch({ route: 'hosted', mode: 'cached' });
  const sameTarget = new Agent({
    name: 'same',
    instructions: 'Same grant.',
    tools: [hosted],
  });
  const sameRoot = new Agent({
    instructions: 'Same grant.',
    tools: [hosted],
    handoffs: [sameTarget],
  });
  expect(
    captureAgentProfiles(sameRoot).every(
      (profile) => profile.scopedHostedSearch === undefined,
    ),
  ).toBe(true);
  const standalone = new Agent({
    instructions: 'Standalone.',
    tools: [webSearch({ route: 'standalone' })],
    handoffs: [sameTarget],
  });
  expect(() => captureAgentProfiles(standalone)).toThrow(
    'native child-role configuration',
  );
});
