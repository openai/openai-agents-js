import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeError, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'prompted repair captured credentials',
  () => {
    it('refuses repair when native opening found a later key outside the captured lease', async () => {
      vi.stubEnv('OPENAI_API_KEY', undefined);
      const server = new ModelServer([
        [message('{"label":"x"}')],
        // A tripwire response lets an incorrect second request finish promptly.
        [message('{"label":"incorrectly repaired"}')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        supportsWebsockets: false,
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const acquire = provider._acquire.bind(provider);
      let acquisitions = 0;
      vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
        acquisitions++;
        const lease = acquire(captured);
        if (acquisitions === 1) {
          expect(lease.apiKey).toBeUndefined();
          const open = lease.open.bind(lease);
          lease.open = async () => {
            entered.resolve();
            await release.promise;
            return open();
          };
        }
        return lease;
      });
      const opening = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        outputType: {
          mode: 'prompted',
          schema: z.object({ label: z.string().min(2) }),
          maxRetries: 2,
        },
      }).session();
      await entered.promise;
      // Existing native admission falls back to the environment when the
      // explicit key is absent. Preserve that behavior for original opening.
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-late-original-key');
      release.resolve();
      await using session = await opening;
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-replacement-key');
      const turn = await session.submit('original');
      const failure = await turn.wait().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect(String(failure)).toContain('captured API key');
      await expect(turn.wait()).rejects.toBe(failure);
      expect(acquisitions).toBe(1);
      expect(server.requests).toHaveLength(1);
      expect(server.requestHeaders[0].authorization).toBe(
        'Bearer synthetic-late-original-key',
      );
      const state = await session.saveState();
      if (state.format_version !== 4)
        throw new Error('Expected an output-aware idle checkpoint');
      expect(state.repair_turns).toEqual([]);
      expect(state.repair_items).toEqual([]);
    }, 25000);
  },
);
