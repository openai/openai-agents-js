import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  fileSearch,
  parseSessionState,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const grant = () =>
  fileSearch('vs_scoped_destination', {
    maxNumResults: 3,
    filters: { type: 'eq', key: 'tenant', value: 'synthetic' },
  });
const expected = {
  type: 'file_search',
  vector_store_ids: ['vs_scoped_destination'],
  max_num_results: 3,
  filters: { type: 'eq', key: 'tenant', value: 'synthetic' },
};
const files = (request: JsonObject) =>
  (request.tools as JsonObject[]).filter((tool) => tool.type === 'file_search');
async function providerFor(server: ModelServer) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-scoped-files',
    supportsWebsockets: false,
  });
}
it('offers exact destination file-search settings once and revokes them on return', async () => {
  const server = new ModelServer([
    (request) => {
      expect(files(request)).toEqual([]);
      return [call('transfer_to_target', {}, { callId: 'files-out' })];
    },
    (request) => {
      expect(files(request)).toEqual([expected]);
      return [call('transfer_to_source', {}, { callId: 'files-back' })];
    },
    (request) => {
      expect(files(request)).toEqual([]);
      return [message('source complete')];
    },
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'target',
    instructions: 'Target owns vector search.',
    tools: [grant()],
    handoffs: [() => source],
  });
  const source: Agent<undefined, unknown> = new Agent({
    name: 'source',
    instructions: 'No vector search.',
    provider,
    model: 'gpt-5.5',
    tools: [],
    handoffs: [target],
  });
  await using session = await source.session();
  expect(
    (await (await session.submit('Transfer and return')).wait()).finalOutput,
  ).toBe('source complete');
  expect(await session.getActiveAgent()).toBe(source);
  server.assertExhausted();
}, 30000);
it('retains exact file-search ownership across trusted cold restore and rejects a changed declaration', async () => {
  const server = new ModelServer([
    (request) => {
      expect(files(request)).toEqual([]);
      return [call('transfer_to_target', {}, { callId: 'files-cold' })];
    },
    (request) => {
      expect(files(request)).toEqual([expected]);
      return [message('target complete')];
    },
    (request) => {
      expect(files(request)).toEqual([expected]);
      return [message('cold complete')];
    },
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'target',
    instructions: 'Target owns vector search.',
    tools: [grant()],
  });
  const source = new Agent({
    name: 'source',
    instructions: 'No vector search.',
    provider,
    model: 'gpt-5.5',
    tools: [],
    handoffs: [target],
  });
  let state;
  {
    await using session = await source.session();
    expect((await (await session.submit('Transfer')).wait()).finalOutput).toBe(
      'target complete',
    );
    const serialized = JSON.stringify(await session.saveState());
    state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }
  const changedTarget = new Agent({
    name: 'target',
    instructions: 'Target owns vector search.',
    tools: [fileSearch('vs_other_authority')],
  });
  const changedSource = new Agent({
    name: 'source',
    instructions: 'No vector search.',
    provider,
    model: 'gpt-5.5',
    tools: [],
    handoffs: [changedTarget],
  });
  await expect(changedSource.session({ state })).rejects.toThrow(
    /declaration|captured|fingerprint|Agent/i,
  );
  expect(server.requests).toHaveLength(2);
  await using restored = await source.session({ state });
  expect(await restored.getActiveAgent()).toBe(target);
  expect((await (await restored.submit('Continue')).wait()).finalOutput).toBe(
    'cold complete',
  );
  server.assertExhausted();
}, 30000);
