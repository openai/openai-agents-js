import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, parseSessionState } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const MODEL = 'fixture-unlisted-metadata-json';
function metadata(phase: string): Record<string, string> {
  return Object.fromEntries([
    ['__proto__', `${phase}-proto`],
    ['constructor', `${phase}-constructor`],
    ['prototype', `${phase}-prototype`],
    ...Array.from({ length: 17 }, (_, index) => [
      `field_${index}`,
      `${phase}-${index}`,
    ]),
    ['k'.repeat(65), `${phase}-${'v'.repeat(513)}`],
  ]);
}
function expectMetadata(value: unknown, phase: string) {
  expect(value).toEqual(metadata(phase));
  expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-settings-json',
    supportsWebsockets: false,
  });
}
afterEach(() => ModelServer.closeAll());

it.each(['agent', 'session'] as const)(
  'preserves metadata own keys on %s opening, sparse update and serialized restore',
  async (route) => {
    const server = new ModelServer([
      [message('opened')],
      [message('updated')],
      [message('restored')],
    ]);
    await using provider = await providerFor(server);
    const opening = metadata('opening');
    const agent = new Agent({
      model: MODEL,
      instructions: 'Answer.',
      provider,
      ...(route === 'agent' ? { modelSettings: { metadata: opening } } : {}),
    });
    let saved;
    {
      await using session = await agent.session(
        route === 'session' ? { modelSettings: { metadata: opening } } : {},
      );
      opening.__proto__ = 'mutated-after-capture';
      expect((await (await session.submit('open')).wait()).finalOutput).toBe(
        'opened',
      );
      expectMetadata(server.requests[0]!.metadata, 'opening');
      const updated = metadata('updated');
      await session.update({ modelSettings: { metadata: updated } });
      updated.__proto__ = 'mutated-after-update';
      expect((await (await session.submit('update')).wait()).finalOutput).toBe(
        'updated',
      );
      expectMetadata(server.requests[1]!.metadata, 'updated');
      saved = await session.saveState();
    }
    {
      await using restored = await agent.session({
        state: parseSessionState(JSON.stringify(saved!)),
      });
      expect(
        (await (await restored.submit('restore')).wait()).finalOutput,
      ).toBe('restored');
    }
    expectMetadata(server.requests[2]!.metadata, 'updated');
    expect(server.requests).toHaveLength(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  },
);

it('preserves metadata own keys in captured root and destination profile settings', async () => {
  const server = new ModelServer([[message('root')], [message('destination')]]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'destination',
    model: 'gpt-5.5',
    provider,
    instructions: 'Answer.',
    modelSettings: { metadata: metadata('destination') },
  });
  const root = new Agent({
    name: 'root',
    model: 'gpt-5.5',
    provider,
    instructions: 'Answer.',
    modelSettings: { metadata: metadata('root') },
    handoffs: [target],
  });
  await using session = await root.session();
  expect((await (await session.submit('root')).wait()).finalOutput).toBe(
    'root',
  );
  expectMetadata(server.requests[0]!.metadata, 'root');
  await session.update({ agent: target });
  expect((await (await session.submit('destination')).wait()).finalOutput).toBe(
    'destination',
  );
  expectMetadata(server.requests[1]!.metadata, 'destination');
  expect(await session.getActiveAgent()).toBe(target);
  expect(server.requests).toHaveLength(2);
});
