import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  type HandoffInput,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'replaces canonical history with projected=%s retained=%s and restores B',
  async (projected, retained) => {
    let preparations = 0;
    const server = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'transfer-call' })],
      [message('first complete')],
      (request) => {
        const input = JSON.stringify(request.input);
        expect(input).toContain('canonical replacement');
        expect(input).toContain('DESTINATION authority.');
        expect(input).not.toContain('original-private');
        expect(input.includes('sampling summary')).toBe(projected && retained);
        return [message('second complete')];
      },
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-history-replacement',
      supportsWebsockets: false,
    });
    const target = new Agent({
      name: 'B',
      instructions: 'DESTINATION authority.',
    });
    const prepare = (value: HandoffInput): HandoffInput => {
      preparations++;
      return {
        ...value,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'sampling summary' }],
          },
        ],
        previous: [],
        generated: [],
      };
    };
    const source = new Agent({
      name: 'A',
      instructions: 'SOURCE authority.',
      model: 'gpt-5.5',
      provider,
      handoffs: [target],
      prepareHandoffInput: projected ? prepare : undefined,
    });
    let state: SessionState;
    {
      await using session = await source.session();
      expect(
        (await (await session.submit('original-private')).wait()).finalOutput,
      ).toBe('first complete');
      expect(await session.getActiveAgent()).toBe(target);
      const before = await session.historySnapshot();
      expect(JSON.stringify(before.items)).toContain('original-private');
      const replacement = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'canonical replacement' }],
      };
      const revision = await session.transactHistory({
        expectedRevision: before.revision,
        keep: retained ? before.total : 0,
        items: [replacement],
      });
      const after = await session.historySnapshot();
      expect(after.revision).toBe(revision);
      expect(after.items.at(-1)).toEqual(replacement);
      if (!retained) expect(after.items).toEqual([replacement]);
      state = await session.saveState();
    }
    await using restored = await source.session({ state });
    expect(await restored.getActiveAgent()).toBe(target);
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'second complete',
    );
    expect(preparations).toBe(projected ? 1 : 0);
    expect(server.requests).toHaveLength(3);
    server.assertExhausted();
  },
  30_000,
);

it.each(['model', 'instructions'] as const)(
  'publishes a real %s update and preserves the admitted handoff view',
  async (change) => {
    for (const projected of [false, true]) {
      const server = new ModelServer([
        [call('transfer_to_b', {}, { callId: 'transfer-call' })],
        [message('first complete')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-material-profile-update',
        supportsWebsockets: false,
      });
      const target = new Agent({
        name: 'B',
        instructions: 'DESTINATION authority.',
      });
      const source = new Agent({
        name: 'A',
        instructions: 'SOURCE authority.',
        model: 'gpt-5.5',
        provider,
        handoffs: [target],
        prepareHandoffInput: projected
          ? (value) => ({
              ...value,
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'sampling summary' }],
                },
              ],
              previous: [],
              generated: [],
            })
          : undefined,
      });
      await using session = await source.session();
      expect(
        (await (await session.submit('original-private')).wait()).finalOutput,
      ).toBe('first complete');
      const publications = (state: SessionState) =>
        (state as { history: Record<string, any>[] }).history.filter(
          (row) => row.metadata?.sdk_agent_profile,
        );
      const before = publications(await session.saveState());
      const update =
        change === 'model'
          ? { model: 'gpt-6.1-sol' }
          : { instructions: 'CHANGED destination authority.' };
      await session.update(update);
      const after = publications(await session.saveState());
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)!.metadata.sdk_agent_profile.epoch).toBe(
        before.at(-1)!.metadata.sdk_agent_profile.epoch + 1,
      );
      expect(after.at(-1)!.payload.id).not.toBe(before.at(-1)!.payload.id);
      expect(after.at(-1)!.metadata.sdk_agent_profile.presentation).toEqual(
        before.at(-1)!.metadata.sdk_agent_profile.presentation,
      );
      if (change === 'model')
        expect(after.at(-1)!.metadata.sdk_agent_profile.model.model).toBe(
          'gpt-6.1-sol',
        );
      else
        expect(JSON.stringify(after.at(-1)!.payload)).toContain(
          'CHANGED destination authority.',
        );
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }
  },
  30_000,
);
