import type OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  responsesCompaction,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

nativeIt.each([
  ['auto', true, false, false],
  ['previous_response_id', true, false, false],
  ['auto', false, false, false],
  ['previous_response_id', false, false, false],
  ['auto', true, true, false],
  ['auto', true, false, true],
  ['previous_response_id', true, false, true],
] as const)(
  'uses only a stored acknowledged native window: mode=%s store=%s automatic=%s transformed=%s',
  async (mode, store, automatic, transformed) => {
    const server = new ModelServer([[message('ACKNOWLEDGED_WINDOW')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });
    const compact = vi.fn(async (_body: unknown) => ({
      output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
    }));
    const client = { responses: { compact } } as unknown as OpenAI;
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store },
      instructions: 'Current application instructions.',
      transformContext: transformed
        ? (context) => context.items.filter((item) => item.role !== 'developer')
        : undefined,
      compaction: responsesCompaction({
        client,
        model: 'gpt-5.5',
        mode,
        shouldCompact: () => automatic,
      }),
    });
    await using session = await agent.session();
    await (await session.submit('EXACT_NATIVE_INPUT')).wait();
    expect(server.requests[0]?.store).toBe(store);
    if ((!store || transformed) && mode === 'previous_response_id') {
      await expect(session.compact()).rejects.toThrow('acknowledged');
      expect(compact).not.toHaveBeenCalled();
      return;
    }
    if (!automatic) await session.compact();
    expect(compact).toHaveBeenCalledOnce();
    const body = compact.mock.calls[0]![0] as Record<string, unknown>;
    if (store && !transformed) {
      const completed = JSON.parse(server.completedFrames[0]!);
      expect(body.previous_response_id).toBe(completed.response.id);
      expect(body).not.toHaveProperty('input');
    } else {
      expect(body).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(body.input)).toContain('ACKNOWLEDGED_WINDOW');
    }
  },
);

nativeIt.each(['auto', 'previous_response_id'] as const)(
  'does not import acknowledged lineage through cold state: mode=%s',
  async (mode) => {
    const server = new ModelServer([[message('COLD_ACKNOWLEDGED_WINDOW')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });
    const compact = vi.fn(async (_body: unknown) => ({
      output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
    }));
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({
        client: { responses: { compact } } as unknown as OpenAI,
        model: 'gpt-5.5',
        mode,
        shouldCompact: () => false,
      }),
    });
    const saved = await (async () => {
      await using session = await agent.session();
      await (await session.submit('EXACT_NATIVE_INPUT')).wait();
      return session.saveState();
    })();
    await using restored = await agent.session({
      state: parseSessionState(JSON.stringify(saved)),
    });
    if (mode === 'previous_response_id') {
      await expect(restored.compact()).rejects.toThrow('acknowledged');
      expect(compact).not.toHaveBeenCalled();
    } else {
      await restored.compact();
      const body = compact.mock.calls[0]![0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(body.input)).toContain('COLD_ACKNOWLEDGED_WINDOW');
    }
  },
);

nativeIt.each(['auto', 'previous_response_id'] as const)(
  'does not reuse lineage after current instructions change: mode=%s',
  async (mode) => {
    const server = new ModelServer([[message('OLD_SCOPE_WINDOW')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });
    const compact = vi.fn(async (_body: unknown) => ({
      output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
    }));
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Original instructions.',
      compaction: responsesCompaction({
        client: { responses: { compact } } as unknown as OpenAI,
        model: 'gpt-5.5',
        mode,
        shouldCompact: () => false,
      }),
    });
    await using session = await agent.session();
    await (await session.submit('EXACT_NATIVE_INPUT')).wait();
    await session.update({ instructions: 'Current instructions.' });
    if (mode === 'previous_response_id') {
      await expect(session.compact()).rejects.toThrow('acknowledged');
      expect(compact).not.toHaveBeenCalled();
    } else {
      await session.compact();
      const body = compact.mock.calls[0]![0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('previous_response_id');
    }
  },
);

nativeIt.each(['auto', 'previous_response_id'] as const)(
  'does not grant lineage to an application-produced response ID: mode=%s',
  async (mode) => {
    const complete = vi.fn(() => ({
      output: [message('APPLICATION_PRODUCED_WINDOW')],
      responseId: 'UNPROVEN_EXTERNAL_RESPONSE_ID',
    }));
    await using provider = new NativeProvider({ modelBackend: { complete } });
    const compact = vi.fn(async (_body: unknown) => ({
      output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
    }));
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({
        client: { responses: { compact } } as unknown as OpenAI,
        model: 'gpt-5.5',
        mode,
        shouldCompact: () => false,
      }),
    });
    await using session = await agent.session();
    await (await session.submit('EXACT_NATIVE_INPUT')).wait();
    expect(complete).toHaveBeenCalledOnce();
    if (mode === 'previous_response_id') {
      await expect(session.compact()).rejects.toThrow('acknowledged');
      expect(compact).not.toHaveBeenCalled();
    } else {
      await session.compact();
      const body = compact.mock.calls[0]![0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(body.input)).toContain(
        'APPLICATION_PRODUCED_WINDOW',
      );
    }
  },
);

nativeIt.each(['auto', 'previous_response_id'] as const)(
  'does not grant lineage to schema-bearing discovery history: mode=%s',
  async (mode) => {
    const server = new ModelServer([[message('DISCOVERY_HISTORY_FOLLOWUP')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });
    const compact = vi.fn(async (_body: unknown) => ({
      output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
    }));
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({
        client: { responses: { compact } } as unknown as OpenAI,
        model: 'gpt-5.5',
        mode,
        shouldCompact: () => false,
      }),
    });
    await using session = await agent.session();
    const initial = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: initial.revision,
      keep: 0,
      items: [
        {
          type: 'tool_search_output',
          call_id: null,
          status: 'completed',
          execution: 'server',
          tools: [],
        },
      ],
    });
    await (await session.submit('EXACT_NATIVE_INPUT')).wait();
    expect(
      (server.requests[0]!.input as { type: string }[]).some(
        (item) => item.type === 'tool_search_output',
      ),
    ).toBe(true);
    if (mode === 'previous_response_id') {
      await expect(session.compact()).rejects.toThrow('acknowledged');
      expect(compact).not.toHaveBeenCalled();
    } else {
      await session.compact();
      const body = compact.mock.calls[0]![0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('previous_response_id');
    }
  },
);
