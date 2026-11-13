import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  fileSessionStore,
  localStorage,
} from '../../src';
import { ModelServer } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['local', 'custom'] as const)(
  'keeps caller developer originals separate from native instruction publications (%s)',
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), 'native-original-eligibility-'));
    const server = new ModelServer([]);
    try {
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-original-eligibility',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Opening native configuration.',
        model: 'gpt-5.5',
        provider,
      });
      const storage =
        kind === 'local'
          ? localStorage(join(home, 'store'))
          : fileSessionStore(join(home, 'store'));
      await using source = await agent.session({ storage });
      const originals = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ORIGINAL_USER' }],
        },
        {
          type: 'message',
          id: 'caller-developer',
          role: 'developer',
          content: [{ type: 'input_text', text: 'CALLER_DEVELOPER' }],
        },
      ];
      const initial = await source.historySnapshot();
      await source.transactHistory({
        expectedRevision: initial.revision,
        keep: 0,
        items: originals,
      });
      const before = await source.historySnapshot();
      expect(before.items).toEqual(originals);
      await source.update({ instructions: 'Current native configuration.' });
      expect(await source.historySnapshot()).toEqual(before);
      const context = JSON.stringify((await source.modelContext()).items);
      expect(context).toContain('Current native configuration.');
      expect(context).toContain('CALLER_DEVELOPER');
      expect(server.requests).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
