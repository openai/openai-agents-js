import OpenAI from 'openai';
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
    const compact = vi.fn(async (_body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
      }),
    }));
    const server = new ModelServer([[message('ACKNOWLEDGED_WINDOW')], compact]);
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    await using provider = new NativeProvider({
      baseUrl: baseURL,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });
    const client = new OpenAI({
      baseURL,
      apiKey: 'synthetic-lineage',
      maxRetries: 0,
    });
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
    const compact = vi.fn(async (_body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
      }),
    }));
    const server = new ModelServer([
      [message('COLD_ACKNOWLEDGED_WINDOW')],
      compact,
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });

    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({
        client: new OpenAI({
          baseURL: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-lineage',
          maxRetries: 0,
        }),
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
    const compact = vi.fn(async (_body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
      }),
    }));
    const server = new ModelServer([[message('OLD_SCOPE_WINDOW')], compact]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });

    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Original instructions.',
      compaction: responsesCompaction({
        client: new OpenAI({
          baseURL: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-lineage',
          maxRetries: 0,
        }),
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
    const compact = vi.fn(async (_body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
      }),
    }));
    const server = new ModelServer([
      [message('DISCOVERY_HISTORY_FOLLOWUP')],
      compact,
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });

    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({
        client: new OpenAI({
          baseURL: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-lineage',
          maxRetries: 0,
        }),
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

nativeIt.each([
  ['auto', false],
  ['auto', true],
  ['previous_response_id', false],
] as const)(
  'honors a compaction-only transform before lineage selection: mode=%s automatic=%s',
  async (mode, automatic) => {
    const compact = vi.fn(async (_body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'COMPACT_WINDOW' }],
      }),
    }));
    const server = new ModelServer([
      [message('PRIVATE_FOR_COMPACTION')],
      compact,
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });

    const policyModes: string[] = [];
    let compactionTransforms = 0;
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      transformContext: (context) => {
        if (context.purpose !== 'compaction') return undefined;
        compactionTransforms++;
        return context.items.filter(
          (item) => !JSON.stringify(item).includes('PRIVATE_FOR_COMPACTION'),
        );
      },
      compaction: responsesCompaction({
        client: new OpenAI({
          baseURL: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-lineage',
          maxRetries: 0,
        }),
        model: 'gpt-5.5',
        mode,
        shouldCompact: (context) => {
          policyModes.push(context.mode);
          return automatic;
        },
      }),
    });
    await using session = await agent.session();
    await (await session.submit('EXACT_NATIVE_INPUT')).wait();
    if (mode === 'previous_response_id') {
      await expect(session.compact()).rejects.toThrow('acknowledged');
      expect(compact).not.toHaveBeenCalled();
      expect(compactionTransforms).toBe(0);
      return;
    }
    if (!automatic) await session.compact();
    expect(compact).toHaveBeenCalledOnce();
    expect(policyModes).toEqual(['input']);
    expect(compactionTransforms).toBe(1);
    const body = compact.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.input).toBeInstanceOf(Array);
    expect(JSON.stringify(body.input)).toContain('EXACT_NATIVE_INPUT');
    expect(JSON.stringify(body.input)).not.toContain('PRIVATE_FOR_COMPACTION');
  },
);

nativeIt(
  'keeps explicit input for a different borrowed compaction endpoint',
  async () => {
    const native = new ModelServer([[message('ACKNOWLEDGED_NATIVE_ENDPOINT')]]);
    const compact = vi.fn(async (body: Record<string, unknown>) => ({
      status: 'previous_response_id' in body ? 400 : 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        'previous_response_id' in body
          ? {
              error: {
                message: 'Unknown response in this account',
                type: 'invalid_request_error',
              },
            }
          : {
              output: [
                {
                  type: 'compaction',
                  encrypted_content: 'OTHER_ENDPOINT_WINDOW',
                },
              ],
            },
      ),
    }));
    const borrowed = new ModelServer([compact]);
    const nativeConfig = await native.config();
    const borrowedConfig = await borrowed.config();
    await using provider = new NativeProvider({
      baseUrl: (nativeConfig['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-lineage',
      supportsWebsockets: false,
    });
    const client = new OpenAI({
      baseURL: (
        borrowedConfig['model_providers.fixture'] as { base_url: string }
      ).base_url,
      apiKey: 'synthetic-lineage',
      maxRetries: 0,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({ client, model: 'gpt-5.5' }),
    });
    await using session = await agent.session();
    await (await session.submit('INPUT_MUST_REACH_BORROWED_ENDPOINT')).wait();
    await session.compact();
    expect(compact).toHaveBeenCalledOnce();
    const body = compact.mock.calls[0]![0];
    expect(body).not.toHaveProperty('previous_response_id');
    expect(JSON.stringify(body.input)).toContain(
      'ACKNOWLEDGED_NATIVE_ENDPOINT',
    );
    expect(JSON.stringify(body.input)).toContain(
      'INPUT_MUST_REACH_BORROWED_ENDPOINT',
    );
  },
);

nativeIt.each(['auto', 'previous_response_id'] as const)(
  'withholds foreign borrowed account lineage in %s mode',
  async (mode) => {
    for (const options of [
      { apiKey: 'synthetic-other-key' },
      { project: 'other-project' },
      { organization: 'other-organization' },
      { defaultHeaders: { 'x-account-routing': 'other' } },
      { defaultQuery: { account: 'other' } },
    ]) {
      const compact = vi.fn(async (_body: unknown) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          output: [
            {
              type: 'compaction',
              encrypted_content: 'BORROWED_ACCOUNT_WINDOW',
            },
          ],
        }),
      }));
      const server = new ModelServer([
        [message('ACKNOWLEDGED_ACCOUNT_WINDOW')],
        compact,
      ]);
      const config = await server.config();
      const baseURL = (
        config['model_providers.fixture'] as { base_url: string }
      ).base_url;
      await using provider = new NativeProvider({
        baseUrl: baseURL,
        apiKey: 'synthetic-lineage',
        supportsWebsockets: false,
      });
      const client = new OpenAI({
        baseURL,
        apiKey: 'synthetic-lineage',
        maxRetries: 0,
        ...options,
      });
      const policyModes: string[] = [];
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        modelSettings: { store: true },
        instructions: 'Current application instructions.',
        compaction: responsesCompaction({
          client,
          model: 'gpt-5.5',
          mode,
          shouldCompact: (context) => {
            policyModes.push(context.mode);
            return false;
          },
        }),
      });
      await using session = await agent.session();
      await (await session.submit('EXACT_ACCOUNT_INPUT')).wait();
      if (mode === 'previous_response_id') {
        await expect(session.compact()).rejects.toThrow('acknowledged');
        expect(compact).not.toHaveBeenCalled();
        expect(policyModes).toEqual([]);
      } else {
        await session.compact();
        expect(policyModes).toEqual(['input']);
        expect(compact).toHaveBeenCalledOnce();
        const body = compact.mock.calls[0]![0] as Record<string, unknown>;
        expect(body).not.toHaveProperty('previous_response_id');
        expect(JSON.stringify(body.input)).toContain(
          'ACKNOWLEDGED_ACCOUNT_WINDOW',
        );
      }
    }
  },
);

nativeIt(
  'matches the native organization and project for explicit lineage',
  async () => {
    const compact = vi.fn(async (_body: unknown) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'SCOPED_WINDOW' }],
      }),
    }));
    const server = new ModelServer([
      [message('SCOPED_ACCOUNT_WINDOW')],
      compact,
    ]);
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    await using provider = new NativeProvider({
      baseUrl: baseURL,
      apiKey: 'synthetic-lineage',
      organization: 'native-org',
      project: 'native-project',
      supportsWebsockets: false,
    });
    const client = new OpenAI({
      baseURL,
      apiKey: 'synthetic-lineage',
      organization: 'native-org',
      project: 'native-project',
      maxRetries: 0,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Current application instructions.',
      compaction: responsesCompaction({
        client,
        model: 'gpt-5.5',
        mode: 'previous_response_id',
      }),
    });
    await using session = await agent.session();
    await (await session.submit('EXACT_SCOPED_INPUT')).wait();
    await session.compact();
    expect(compact).toHaveBeenCalledOnce();
    const body = compact.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.previous_response_id).toBe(
      JSON.parse(server.completedFrames[0]!).response.id,
    );
    expect(body).not.toHaveProperty('input');
  },
);

nativeIt('rechecks borrowed scope after the compaction predicate', async () => {
  const compact = vi.fn(async (_body: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'UNEXPECTED_WINDOW' }],
    }),
  }));
  const server = new ModelServer([
    [message('ORIGINAL_ANSWER_SURVIVES_CLIENT_CHANGE')],
    compact,
  ]);
  const config = await server.config();
  const baseURL = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  await using provider = new NativeProvider({
    baseUrl: baseURL,
    apiKey: 'synthetic-lineage',
    supportsWebsockets: false,
  });
  const client = new OpenAI({
    baseURL,
    apiKey: 'synthetic-lineage',
    maxRetries: 0,
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    modelSettings: { store: true },
    instructions: 'Current application instructions.',
    compaction: responsesCompaction({
      client,
      model: 'gpt-5.5',
      shouldCompact: (context) => {
        expect(context.mode).toBe('previous_response_id');
        client.project = 'changed-after-admission';
        return true;
      },
    }),
  });
  await using session = await agent.session();
  await (await session.submit('EXACT_NATIVE_INPUT')).wait();
  expect(JSON.stringify(await session.saveState())).toContain(
    'ORIGINAL_ANSWER_SURVIVES_CLIENT_CHANGE',
  );
  expect(compact).not.toHaveBeenCalled();
});

nativeIt('uses input when the SDK private scope shape is unknown', async () => {
  const compact = vi.fn(async (_body: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'INPUT_WINDOW' }],
    }),
  }));
  const server = new ModelServer([
    [message('UNKNOWN_SDK_SHAPE_WINDOW')],
    compact,
  ]);
  const config = await server.config();
  const baseURL = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  await using provider = new NativeProvider({
    baseUrl: baseURL,
    apiKey: 'synthetic-lineage',
    supportsWebsockets: false,
  });
  const client = new OpenAI({
    baseURL,
    apiKey: 'synthetic-lineage',
    maxRetries: 0,
  });
  const options = Reflect.get(client, '_options');
  Reflect.deleteProperty(client, '_options');
  const compaction = responsesCompaction({ client, model: 'gpt-5.5' });
  Reflect.set(client, '_options', options);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    modelSettings: { store: true },
    instructions: 'Current application instructions.',
    compaction,
  });
  await using session = await agent.session();
  await (await session.submit('EXACT_NATIVE_INPUT')).wait();
  await session.compact();
  const body = compact.mock.calls[0]![0] as Record<string, unknown>;
  expect(body).not.toHaveProperty('previous_response_id');
  expect(JSON.stringify(body.input)).toContain('UNKNOWN_SDK_SHAPE_WINDOW');
});
