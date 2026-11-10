import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-admission-memo',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
}

const nativeTests = process.env.OPENAI_AGENTS_NATIVE_TESTS === '1';
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(!nativeTests)('plain entry admission memo', () => {
  it('invalidates populated admission when a real retained entry fails readiness', async () => {
    const server = new ModelServer([
      [message('first')],
      [message('second')],
      [message('ordinary')],
      [message('readmitted')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Answer plainly.',
    });
    const native = await binding();
    const admit = vi.spyOn(native.Engine.prototype, '_plain_run_supported');
    const create = vi.spyOn(native.Engine.prototype, '_plain_run');
    expect((await agent.run('first')).finalOutput).toBe('first');
    expect((await agent.run('second')).finalOutput).toBe('second');
    expect(admit).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    // Readiness signal; actual filesystem predicate qualification remains separate.
    const readiness = vi
      .spyOn(native.Engine.prototype, '_private_reuse_ready', 'get')
      .mockReturnValueOnce(false);
    expect((await agent.run('third')).finalOutput).toBe('ordinary');
    expect(readiness).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    expect((await agent.run('fourth')).finalOutput).toBe('readmitted');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(3);
    expect(server.requests).toHaveLength(4);
    server.assertExhausted();
  }, 30_000);

  it('reuses positive admission only for the same retained model and configuration', async () => {
    const server = new ModelServer([
      [message('first')],
      [message('second')],
      [message('third')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Answer plainly.',
    });
    const native = await binding();
    const admit = vi.spyOn(native.Engine.prototype, '_plain_run_supported');
    expect((await agent.run('first')).finalOutput).toBe('first');
    expect((await agent.run('second')).finalOutput).toBe('second');
    expect(admit).toHaveBeenCalledTimes(1);
    const other = new Agent({
      provider,
      model: 'gpt-4.1-mini',
      instructions: 'Answer plainly.',
    });
    expect((await other.run('third')).finalOutput).toBe('third');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(server.requests.map((request) => request.model)).toEqual([
      'gpt-5',
      'gpt-5',
      'gpt-4.1-mini',
    ]);
    server.assertExhausted();
  }, 30_000);
});
