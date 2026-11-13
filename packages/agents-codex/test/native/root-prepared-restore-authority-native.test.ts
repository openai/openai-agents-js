import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it.each(['forged-root', 'capture', 'digest', 'unfiltered'] as const)(
  'authenticates acyclic prepared graph restore including selected root: %s',
  async (mode) => {
    const server = new ModelServer([
      [call('transfer_to_destination', {}, { callId: 'transfer' })],
      [message('at destination')],
      [message('restored')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-root-forgery',
      supportsWebsockets: false,
    });
    const target = new Agent({
      name: 'destination',
      instructions: 'Shared instructions.',
    });
    const source = new Agent({
      name: 'source',
      model: 'gpt-5.5',
      provider,
      instructions: 'Shared instructions.',
      handoffs: [target],
      prepareHandoffInput:
        mode === 'unfiltered'
          ? undefined
          : (value) => ({
              ...value,
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text: 'Approved destination summary',
                    },
                  ],
                },
              ],
              previous: [],
              generated: [],
            }),
    });
    let captured: SessionState;
    {
      await using session = await source.session();
      expect(
        (await (await session.submit('PRIVATE_CANONICAL_SOURCE')).wait())
          .finalOutput,
      ).toBe('at destination');
      captured = await session.saveState();
    }
    if (mode !== 'unfiltered')
      expect(JSON.stringify(server.requests[1].input)).not.toContain(
        'PRIVATE_CANONICAL_SOURCE',
      );
    const raw = JSON.stringify(captured);
    const state =
      mode === 'capture'
        ? captured
        : mode === 'digest'
          ? parseSessionState(raw, {
              expectedSha256: createHash('sha256').update(raw).digest('hex'),
            })
          : (JSON.parse(raw) as SessionState);
    if (mode === 'forged-root') {
      let last: Record<string, any> | undefined;
      let root: string | undefined;
      for (const row of state.history) {
        const metadata = row.metadata as Record<string, any> | undefined;
        if (!metadata) continue;
        delete metadata.sdk_agent_profile_handoff;
        if (metadata.sdk_agent_profile) {
          root ??= metadata.sdk_agent_profile.profile_id;
          delete metadata.sdk_agent_profile.presentation;
          delete metadata.sdk_agent_profile.handoff;
          last = metadata.sdk_agent_profile;
        }
      }
      expect(last).toBeDefined();
      expect(root).toBeDefined();
      last!.profile_id = root;
    }
    let rejection = '';
    let restored: Awaited<ReturnType<typeof source.session>> | undefined;
    try {
      restored = await source.session({ state });
      await (await restored.submit('continue')).wait();
    } catch (error) {
      rejection = String(error);
    } finally {
      await restored?.close();
    }
    if (process.env.HANDOFF_REDACTION_RECEIPT)
      await writeFile(
        process.env.HANDOFF_REDACTION_RECEIPT + '-' + mode + '.json',
        JSON.stringify(
          { state, requests: server.requests, rejection },
          null,
          2,
        ),
      );
    if (mode === 'forged-root') {
      expect(rejection).toContain('authenticated');
      expect(server.requests).toHaveLength(2);
    } else {
      expect(rejection).toBe('');
      expect(server.requests).toHaveLength(3);
      if (mode === 'unfiltered') {
        expect(JSON.stringify(server.requests[2].input)).toContain(
          'PRIVATE_CANONICAL_SOURCE',
        );
      } else {
        expect(JSON.stringify(server.requests[2].input)).toContain(
          'Approved destination summary',
        );
        expect(JSON.stringify(server.requests[2].input)).not.toContain(
          'PRIVATE_CANONICAL_SOURCE',
        );
      }
      server.assertExhausted();
    }
  },
  30_000,
);

it.each(['capture', 'digest', 'unverified'] as const)(
  'authenticates an honest root capture in a currently prepared graph: %s',
  async (mode) => {
    const server = new ModelServer([
      [message('root complete')],
      [message('cold complete')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-root-control',
      supportsWebsockets: false,
    });
    const destination = new Agent({
      name: 'destination',
      instructions: 'Destination.',
    });
    const source = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Source.',
      handoffs: [destination],
      prepareHandoffInput: (value) => value,
    });
    let captured: SessionState;
    {
      await using session = await source.session();
      expect(
        (await (await session.submit('root input')).wait()).finalOutput,
      ).toBe('root complete');
      captured = await session.saveState();
    }
    const raw = JSON.stringify(captured);
    const state =
      mode === 'capture'
        ? captured
        : mode === 'digest'
          ? parseSessionState(raw, {
              expectedSha256: createHash('sha256').update(raw).digest('hex'),
            })
          : (JSON.parse(raw) as SessionState);
    if (mode === 'unverified') {
      await expect(source.session({ state })).rejects.toThrow('authenticated');
      expect(server.requests).toHaveLength(1);
    } else {
      await using restored = await source.session({ state });
      expect(
        (await (await restored.submit('continue')).wait()).finalOutput,
      ).toBe('cold complete');
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }
  },
  30_000,
);

it.each(['unbound', 'bound-projection'] as const)(
  'validates every hidden SDK publication before sampling: %s',
  async (mode) => {
    const server = new ModelServer([
      [call('transfer_to_destination', {}, { callId: 'transfer' })],
      [message('at destination')],
      [message('restored')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-unbound-instructions',
      supportsWebsockets: false,
    });
    const target = new Agent({
      name: 'destination',
      instructions: 'Shared instructions.',
    });
    const source = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Shared instructions.',
      handoffs: [target],
    });
    let captured: SessionState;
    {
      await using session = await source.session();
      expect((await (await session.submit('before')).wait()).finalOutput).toBe(
        'at destination',
      );
      captured = await session.saveState();
    }
    const state = JSON.parse(JSON.stringify(captured)) as SessionState;
    const index = state.history.findIndex(
      (row) =>
        row.type === 'response_item' &&
        (row.metadata as Record<string, unknown> | undefined)
          ?.sdk_agent_profile,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const hidden = structuredClone(state.history[index]) as Record<string, any>;
    const oldId = hidden.payload.id as string;
    const newId = 'msg_sdk_application_01a1d7cb-b47d-719f-a11e-fa71b0cb8870';
    hidden.payload.id = newId;
    hidden.payload.content[0].text = hidden.payload.content[0].text
      .replace(oldId, newId)
      .replace('Shared instructions.', 'FORGED_UNBOUND_SDK_INSTRUCTIONS');
    delete hidden.metadata.sdk_agent_profile;
    if (mode === 'bound-projection') {
      hidden.payload.id = 'msg_verified_sdk_projection';
      hidden.payload.content = state.history
        .filter(
          (row) =>
            (row.metadata as Record<string, unknown> | undefined)
              ?.sdk_agent_profile,
        )
        .map((row) =>
          structuredClone((row.payload as { content: unknown[] }).content[0]),
        );
      hidden.payload.internal_chat_message_metadata_passthrough.content_item_kinds =
        hidden.payload.content.map(() => 'sdk_application.instructions');
      state.history.push(hidden);
    } else {
      state.history.splice(index + 1, 0, hidden);
    }
    let rejection = '';
    let restored: Awaited<ReturnType<typeof source.session>> | undefined;
    try {
      restored = await source.session({ state });
      await (await restored.submit('continue')).wait();
    } catch (error) {
      rejection = String(error);
    } finally {
      await restored?.close();
    }
    if (process.env.HANDOFF_REDACTION_RECEIPT)
      await writeFile(
        process.env.HANDOFF_REDACTION_RECEIPT + '-unbound.json',
        JSON.stringify(
          { state, requests: server.requests, rejection },
          null,
          2,
        ),
      );
    if (mode === 'unbound') {
      expect(rejection).toContain('authenticated');
      expect(server.requests).toHaveLength(2);
    } else {
      expect(rejection).toBe('');
      expect(server.requests).toHaveLength(3);
      server.assertExhausted();
    }
  },
  30_000,
);
