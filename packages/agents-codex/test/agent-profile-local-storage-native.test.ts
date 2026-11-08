import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Agent, NativeProvider, localStorage } from '../src';
import { ModelServer } from './native/fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

// Exercise public opening against disk, rather than the in-memory store fixture.
nativeIt.each([false, true])(
  'opens a LocalStorage Session without sampling a model (handoff graph=%s)',
  async (withGraph) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-profile-opening-'));
    const model = new ModelServer([]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-profile-opening',
        supportsWebsockets: false,
      });
      const target = new Agent({
        name: 'B',
        instructions: 'Handle work delegated to B.',
      });
      const source = new Agent({
        name: 'A',
        instructions: 'Handle work or transfer to B.',
        model: 'gpt-5',
        provider,
        ...(withGraph ? { handoffs: [target] } : {}),
      });
      await using session = await source.session({
        storage: localStorage(join(directory, 'profile')),
      });
      expect(session.id).toEqual(expect.any(String));
      expect(session.id.length).toBeGreaterThan(0);
      expect(await session.getActiveAgent()).toBe(source);
      expect(model.requests).toHaveLength(0);
      await session.close();
      expect(model.requests).toHaveLength(0);
      model.assertExhausted();
    } finally {
      try {
        await ModelServer.closeAll();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  30000,
);
