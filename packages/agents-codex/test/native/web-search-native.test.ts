import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeRole,
  NativeProvider,
  localStorage,
  webSearch,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { searchPeer } from './fixtures/web-search-peer';
import { startPublicExecutor } from './fixtures/public-executor';
import { binding, type JsonObject } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());
const providerAt = (url: string, key = 'synthetic-web-current') =>
  new NativeProvider({ baseUrl: url, apiKey: key, supportsWebsockets: false });
const searchCall = (
  code: boolean,
  callId = code ? 'web-code' : 'web-direct',
) =>
  code
    ? {
        type: 'custom_tool_call',
        call_id: callId,
        name: 'exec',
        input:
          'text(await tools.web__run({search_query:[{q:"selected-search"}]}))',
      }
    : call(
        'run',
        { search_query: [{ q: 'selected-search' }] },
        { namespace: 'web', callId },
      );
const variants = (['disabled', 'cached', 'live'] as const).flatMap((mode) =>
  (['standalone', 'hosted'] as const).flatMap((route) =>
    [false, true].map((code) => ({ mode, route, code })),
  ),
);
it.each(variants)(
  'native search mode=$mode route=$route code=$code uses only its captured route',
  async ({ mode, route, code }) => {
    await using peer = await searchPeer([
      [searchCall(code)],
      [message('done')],
    ]);
    await using provider = providerAt(peer.url);
    await using session = await new Agent({
      instructions: 'Use admitted search only.',
      model: 'gpt-5.5',
      provider,
      tools: mode === 'disabled' ? [] : [webSearch({ mode, route })],
      programmaticToolCalling: code,
    }).session();
    expect(
      (await (await session.submit('Research selected-search')).wait())
        .finalOutput,
    ).toBe('done');
    const standalone = mode !== 'disabled' && route === 'standalone';
    expect(peer.searches).toHaveLength(standalone ? 1 : 0);
    if (standalone) {
      expect(peer.searches[0].authorization).toBe(
        'Bearer synthetic-web-current',
      );
      expect(JSON.stringify(peer.searches[0].body)).toContain(
        'selected-search',
      );
      expect(
        (peer.searches[0].body.settings as JsonObject).external_web_access,
      ).toBe(mode === 'live');
      expect(JSON.stringify(peer.model.requests.at(-1)?.input)).toContain(
        'native-search-fixture-result',
      );
    } else
      expect(JSON.stringify(peer.model.requests.at(-1)?.input)).not.toContain(
        'native-search-fixture-result',
      );
    const tools = peer.model.requests[0].tools as JsonObject[];
    if (mode === 'disabled') {
      expect(JSON.stringify(tools)).not.toContain('web_search');
      expect(JSON.stringify(tools)).not.toContain('web__run');
      expect(tools.some((tool) => tool.name === 'web')).toBe(false);
    } else if (route === 'hosted') {
      const hosted = tools.filter((tool) =>
        String(tool.type).startsWith('web_search'),
      );
      expect(hosted).toHaveLength(1);
      expect(hosted[0].external_web_access).toBe(mode === 'live');
    }
    expect(
      peer.model.requests.every((request) => request.model === 'gpt-5.5'),
    ).toBe(true);
    peer.model.assertExhausted();
  },
  30000,
);

it('keeps a hosted grant after a refused Lite model update and allows the original model', async () => {
  await using peer = await searchPeer([[message('original')]]);
  await using provider = providerAt(peer.url);
  const search = webSearch({ route: 'hosted' });
  await using session = await new Agent({
    instructions: 'Act',
    model: 'gpt-5.5',
    provider,
    tools: [search],
  }).session();
  await expect(session.update({ model: 'gpt-5.6-sol' })).rejects.toThrow(
    /hosted/i,
  );
  await expect(session.update({ tools: [] })).rejects.toThrow('retain');
  await expect(session.update({ tools: [webSearch()] })).rejects.toThrow(
    'retain',
  );
  expect(peer.model.requests).toHaveLength(0);
  expect(peer.searches).toHaveLength(0);
  expect(
    (await (await session.submit('Use original settings')).wait()).finalOutput,
  ).toBe('original');
  expect(peer.model.requests[0].model).toBe('gpt-5.5');
  peer.model.assertExhausted();
}, 30000);

it('captures hosted controls and retains search evidence through events, history, restore, and model input', async () => {
  const url = 'https://reports.example.test/annual';
  const sources = [
    { type: 'url', url },
    { type: 'url', url: 'https://reports.example.test/data' },
  ];
  const action = { type: 'search', query: 'annual report', sources };
  const markup =
    '<oai-mem-citation><citation_entries>MEMORY.md:1-2|note=[fixture]</citation_entries></oai-mem-citation>';
  const content: JsonObject[] = [
    {
      type: 'output_text',
      text: markup + 'Annual report.',
      annotations: [
        {
          type: 'url_citation',
          url,
          title: 'Annual report',
          start_index: markup.length,
          end_index: markup.length + 'Annual report'.length,
        },
      ],
    },
    {
      type: 'output_text',
      text: ' Appendix.',
      annotations: [
        {
          type: 'url_citation',
          url,
          title: 'Appendix',
          start_index: 1,
          end_index: 9,
        },
        {
          type: 'file_citation',
          file_id: 'file_fixture',
          filename: 'appendix.txt',
          index: 1,
        },
        { type: 'future_annotation', detail: { reference: 'fixture' } },
      ],
    },
    {
      type: 'output_text',
      text: ' Notes.',
      annotations: { type: 'future_container', reference: 'fixture' },
    },
  ];
  const usage = {
    input_tokens: 11,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    total_tokens: 13,
  };
  await using peer = await searchPeer(
    [
      [
        {
          type: 'web_search_call',
          id: 'ws_fixture',
          status: 'completed',
          action,
        },
        { ...message('unused'), content },
      ],
      [
        {
          type: 'web_search_call',
          id: 'ws_missing_sources',
          status: 'completed',
          action: { type: 'search', query: 'supplement' },
        },
        message('No extra evidence.'),
      ],
    ],
    [JSON.stringify(usage)],
  );
  await using provider = providerAt(peer.url);
  const allowedDomains = ['example.test'];
  const blockedDomains = ['excluded.example.test'];
  const location = {
    country: 'US',
    region: 'Illinois',
    city: 'Chicago',
    timezone: 'America/Chicago',
  };
  const grant = webSearch({
    route: 'hosted',
    allowedDomains,
    blockedDomains,
    location,
  });
  const agent = new Agent({
    instructions: 'Research the user question.',
    model: 'gpt-5.5',
    provider,
    tools: [grant],
  });
  const expectedPolicy = {
    type: 'web_search',
    filters: {
      allowed_domains: ['example.test'],
      blocked_domains: ['excluded.example.test'],
    },
    user_location: { type: 'approximate', ...location },
    external_web_access: false,
  };
  allowedDomains.push('other.test');
  blockedDomains[0] = 'other.test';
  location.timezone = 'Etc/UTC';

  await using session = await agent.session({
    modelSettings: { toolChoice: 'required' },
  });
  await expect(
    session.update({ tools: [webSearch({ route: 'hosted', allowedDomains })] }),
  ).rejects.toThrow('retain');
  expect(peer.model.requests).toHaveLength(0);
  const turn = await session.submit('Find the annual report.');
  const events = Array.fromAsync(turn.events());
  const result = await turn.wait();
  const displayText = 'Annual report. Appendix. Notes.';
  expect(result.finalOutput).toBe(displayText);
  const evidence = [
    expect.objectContaining({
      type: 'web_search_call',
      action: { ...action, queries: null },
    }),
    expect.objectContaining({
      type: 'message',
      role: 'assistant',
      content,
    }),
  ];
  const originalHistory = await Array.fromAsync(session.items());
  const historyEvidence = originalHistory.filter(
    (item) =>
      item.type === 'web_search_call' ||
      (item.type === 'message' && item.role === 'assistant'),
  );
  expect(historyEvidence).toEqual(evidence);
  const sequence = (await events).filter(
    (event) =>
      event.type === 'turn_started' ||
      event.type === 'search_item_completed' ||
      event.type === 'turn_finished',
  );
  expect(sequence).toEqual([
    expect.objectContaining({ type: 'turn_started', turnId: turn.turnId }),
    expect.objectContaining({
      type: 'search_item_completed',
      turnId: turn.turnId,
      item: historyEvidence[0],
    }),
    expect.objectContaining({
      type: 'search_item_completed',
      turnId: turn.turnId,
      // In-memory history retains the original provider message. The live
      // native item also carries the display text computed at finalization.
      item: { ...historyEvidence[1], displayText },
    }),
    expect.objectContaining({
      type: 'turn_finished',
      turnId: turn.turnId,
      status: 'completed',
    }),
  ]);
  const [recorded] = await Array.fromAsync(session.turns());
  expect(recorded.responses).toEqual([
    expect.objectContaining({
      usageSource: 'received',
      usage: {
        inputTokens: 11,
        inputTokensDetails: { cachedTokens: 0 },
        outputTokens: 2,
        totalTokens: 13,
      },
    }),
  ]);
  expect(peer.model.requests[0]).toMatchObject({
    tools: expect.arrayContaining([expect.objectContaining(expectedPolicy)]),
    tool_choice: 'required',
    include: expect.arrayContaining(['web_search_call.action.sources']),
  });

  await using restored = await agent.session({
    state: await session.saveState(),
  });
  expect(await Array.fromAsync(restored.items())).toEqual(originalHistory);
  const next = await restored.submit('Find any supplement.');
  const nextEvents = Array.fromAsync(next.events());
  expect((await next.wait()).finalOutput).toBe('No extra evidence.');
  const restoredHistory = await Array.fromAsync(restored.items());
  const nextHistory = restoredHistory.filter(
    (item) =>
      item.turnId === next.turnId &&
      (item.type === 'web_search_call' ||
        (item.type === 'message' && item.role === 'assistant')),
  );
  expect(nextHistory).toEqual([
    expect.objectContaining({
      type: 'web_search_call',
      action: { type: 'search', query: 'supplement', queries: null },
    }),
    expect.objectContaining({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'No extra evidence.' }],
    }),
  ]);
  expect(
    (await nextEvents).flatMap((event) =>
      event.type === 'search_item_completed' ? [event.item] : [],
    ),
  ).toEqual([nextHistory[0]]);
  expect(peer.model.requests[1]).toMatchObject({
    tool_choice: 'required',
    input: expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Find the annual report.' }],
      }),
      expect.objectContaining({ type: 'web_search_call', action }),
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [
          content[0],
          {
            ...content[1],
            annotations: (content[1]!.annotations as JsonObject[]).slice(0, 2),
          },
          { type: 'output_text', text: ' Notes.' },
        ],
      }),
    ]),
  });
  const last = (await Array.fromAsync(restored.turns())).at(-1);
  expect(last?.responses).toEqual([
    expect.objectContaining({ usageSource: 'received', usage: null }),
  ]);
  expect(peer.searches).toHaveLength(0);
  peer.model.assertExhausted();
}, 30000);

it('allows an auto response without search and honors idle tool choice and per-step omission', async () => {
  await using peer = await searchPeer([
    [message('No search needed.')],
    [message('No tools selected.')],
  ]);
  await using provider = providerAt(peer.url);
  await expect(
    new Agent({
      instructions: 'Act',
      provider,
      tools: [{ ...webSearch(), blockedDomains: ['example.test'] }],
    }).session(),
  ).rejects.toThrow(/standalone.*hosted/);
  expect(peer.model.requests).toHaveLength(0);
  expect(peer.searches).toHaveLength(0);

  await using session = await new Agent({
    instructions: 'Act',
    model: 'gpt-5.5',
    provider,
    tools: [webSearch({ route: 'hosted', blockedDomains: ['example.test'] })],
  }).session();
  const turn = await session.submit('Answer directly.');
  const events = Array.fromAsync(turn.events());
  const first = await turn.wait();
  expect(first.finalOutput).toBe('No search needed.');
  expect(
    (await events).some((event) => event.type === 'search_item_completed'),
  ).toBe(false);
  expect(
    (await Array.fromAsync(session.items())).some(
      (item) => item.type === 'web_search_call',
    ),
  ).toBe(false);
  expect(first.threadUsage).toBeNull();
  expect(peer.model.requests[0]).toMatchObject({
    tool_choice: 'auto',
    tools: expect.arrayContaining([
      expect.objectContaining({ type: 'web_search' }),
    ]),
  });
  await session.update({ modelSettings: { toolChoice: 'none' } });
  await (await session.submit('Continue.', { beforeStep: () => [] })).wait();
  expect(peer.model.requests[1]).toMatchObject({ tool_choice: 'none' });
  expect(peer.model.requests[1].tools ?? []).toEqual([]);
  expect(peer.searches).toHaveLength(0);
  peer.model.assertExhausted();
}, 30000);

/** Refusal witness only: any attempted executor connection is observable and rejected. */
async function forbiddenExecutor(writePolicy: 'strict' | 'legacy' = 'strict') {
  let attempts = 0;
  const server = createServer((_request, response) =>
    response.writeHead(503).end(),
  );
  server.on('connection', () => {
    attempts++;
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');
  return {
    environment: new Environment({
      url: `wss://127.0.0.1:${address.port}`,
      cwd: tmpdir(),
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
      writePolicy,
    }),
    get attempts() {
      return attempts;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it.each(['root', 'default', 'child'] as const)(
  'refuses incompatible hosted %s model before executor connection or provider work',
  async (kind) => {
    await using peer = await searchPeer([]);
    await using provider = providerAt(peer.url);
    await using executor = await forbiddenExecutor();
    const agent = new Agent({
      instructions: 'Act',
      provider,
      model:
        kind === 'default'
          ? undefined
          : kind === 'root'
            ? 'gpt-5.6-sol'
            : 'gpt-5.5',
      tools: [
        webSearch({ route: 'hosted' }),
        ...(kind === 'child'
          ? [
              new NativeAgents({
                additionalRoles: [
                  new NativeRole({
                    name: 'research',
                    description: 'Research',
                    instructions: 'Research',
                    model: 'gpt-5.6-sol',
                  }),
                ],
              }),
            ]
          : []),
      ],
    });
    await expect(
      agent.session({ environment: executor.environment }),
    ).rejects.toThrow(/hosted/i);
    expect(executor.attempts).toBe(0);
    expect(peer.model.requests).toHaveLength(0);
    expect(peer.searches).toHaveLength(0);
    peer.model.assertExhausted();
  },
  30000,
);

it.each(['gpt-5.5', 'gpt-5.6-sol'])(
  'portable hosted restore uses saved %s model rather than the opening default',
  async (model) => {
    await using peer = await searchPeer([[message('saved')]]);
    await using provider = providerAt(peer.url);
    let state: SessionState;
    {
      await using original = await new Agent({
        instructions: 'Act',
        model,
        provider,
      }).session();
      await (await original.submit('Save a settled model')).wait();
      state = await original.saveState();
    }
    if (model === 'gpt-5.6-sol') {
      // Retain the source policy so this checks saved-model admission.
      await using executor = await forbiddenExecutor('legacy');
      await expect(
        new Agent({
          instructions: 'Act',
          model: 'gpt-5.5',
          provider,
          programmaticToolCalling: true,
          tools: [webSearch({ route: 'hosted' })],
        }).session({ state, environment: executor.environment }),
      ).rejects.toThrow(/hosted/i);
      expect(executor.attempts).toBe(0);
    } else {
      await using restored = await new Agent({
        instructions: 'Act',
        model: 'gpt-5.6-sol',
        provider,
        tools: [webSearch({ route: 'hosted' })],
      }).session({ state });
      expect(restored.id).toBe(state.source_session_id);
    }
    expect(peer.model.requests).toHaveLength(1);
    expect(peer.searches).toHaveLength(0);
    peer.model.assertExhausted();
  },
  30000,
);

it.each(['managed-specs', 'root-identity'] as const)(
  'refuses corrupted portable %s before executor connection',
  async (corruption) => {
    await using peer = await searchPeer([[message('saved')]]);
    await using provider = providerAt(peer.url);
    let state: SessionState;
    {
      await using original = await new Agent({
        instructions: 'Act',
        model: 'gpt-5.5',
        provider,
      }).session();
      await (await original.submit('Save')).wait();
      state = await original.saveState();
    }
    const raw = JSON.parse(JSON.stringify(state));
    if (corruption === 'root-identity')
      raw.root_metadata.thread_id = '00000000-0000-4000-8000-000000000123';
    else raw.managed_tool_specs = [{ name: 'ungranted' }];
    // Retain the source policy so malformed state reaches its own validation.
    await using executor = await forbiddenExecutor('legacy');
    await expect(
      new Agent({
        instructions: 'Act',
        model: 'gpt-5.5',
        provider,
        tools: [webSearch({ route: 'hosted' })],
      }).session({ state: raw, environment: executor.environment }),
    ).rejects.toThrow();
    expect(executor.attempts).toBe(0);
    expect(peer.searches).toHaveLength(0);
    expect(peer.model.requests).toHaveLength(1);
    peer.model.assertExhausted();
  },
  30000,
);

it('restores completed search history without replay or authority and uses destination credentials for a new grant', async () => {
  await using peer = await searchPeer([
    [searchCall(false, 'source-search')],
    [message('{"response":1}')],
    [searchCall(false, 'denied-search')],
    [message('{"response":2}')],
    [searchCall(false, 'destination-search')],
    [message('{"response":3}')],
  ]);
  await using sourceProvider = providerAt(peer.url, 'synthetic-source');
  let state: SessionState;
  {
    await using original = await new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider: sourceProvider,
      tools: [webSearch()],
      outputType: z.number(),
    }).session();
    expect(
      (await (await original.submit('Search once')).wait()).finalOutput,
    ).toBe(1);
    state = await original.saveState();
  }
  expect(peer.searches).toHaveLength(1);
  await using destination = providerAt(peer.url, 'synthetic-destination');
  const acquire = vi.spyOn(destination, '_acquire');
  await expect(
    new Agent({
      instructions: 'Act',
      provider: destination,
      outputType: z.object({ response: z.number() }),
    }).session({ state }),
  ).rejects.toThrow('matching current output contract');
  expect(acquire).not.toHaveBeenCalled();
  expect(peer.model.requests).toHaveLength(2);
  expect(peer.searches).toHaveLength(1);
  acquire.mockRestore();
  {
    await using denied = await new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider: destination,
      outputType: z.number(),
    }).session({ state });
    expect(peer.searches).toHaveLength(1);
    expect(
      (await (await denied.submit('Try without a grant')).wait()).finalOutput,
    ).toBe(2);
  }
  expect(peer.searches).toHaveLength(1);
  {
    await using admitted = await new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider: destination,
      tools: [webSearch()],
      outputType: z.number(),
    }).session({ state });
    expect(peer.searches).toHaveLength(1);
    expect(
      (await (await admitted.submit('New admitted search')).wait()).finalOutput,
    ).toBe(3);
  }
  expect(peer.searches).toHaveLength(2);
  expect(peer.searches[1].authorization).toBe('Bearer synthetic-destination');
  peer.model.assertExhausted();
}, 30000);

it('reopens local storage with current search authority and preserves accepted instructions after refused hosted admission', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agents-web-local-'));
  try {
    await using peer = await searchPeer([
      [message('saved local')],
      [message('current local')],
    ]);
    await using provider = providerAt(peer.url);
    const storage = localStorage(join(home, 'profile'));
    let id: string;
    {
      await using original = await new Agent({
        instructions: 'Original accepted instructions',
        model: 'gpt-5.6-sol',
        provider,
      }).session({ storage });
      id = original.id;
      await (await original.submit('Save')).wait();
    }
    const accepted = async () => {
      const rollouts: string[] = [];
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (entry.name.endsWith(`${id!}.jsonl`)) rollouts.push(path);
        }
      };
      await visit(join(storage.path, 'sessions'));
      expect(rollouts).toHaveLength(1);
      return (await readFile(rollouts[0], 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter(
          (row) =>
            row.type === 'response_item' &&
            row.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes(
              'sdk_application.accepted',
            ),
        )
        .map((row) => row.payload);
    };
    const originalAccepted = await accepted();
    expect(originalAccepted.length).toBeGreaterThan(0);
    expect(JSON.stringify(originalAccepted)).toContain(
      'Original accepted instructions',
    );
    await expect(
      new Agent({
        instructions: 'Rejected instructions',
        provider,
        tools: [webSearch({ route: 'hosted' })],
      }).session({ storage, resume: id! }),
    ).rejects.toThrow(/hosted/i);
    expect(await accepted()).toEqual(originalAccepted);
    expect(peer.model.requests).toHaveLength(1);
    {
      await using restored = await new Agent({
        instructions: 'Original accepted instructions',
        provider,
        tools: [webSearch()],
      }).session({ storage, resume: id! });
      expect(restored.id).toBe(id!);
      expect(peer.model.requests).toHaveLength(1);
      expect(peer.searches).toHaveLength(0);
      await (await restored.submit('Continue')).wait();
    }
    const input = peer.model.requests[1].input as JsonObject[];
    expect(Array.isArray(input)).toBe(true);
    const developerMessages = input.filter(
      (item) => item.type === 'message' && item.role === 'developer',
    );
    expect(JSON.stringify(developerMessages)).toContain(
      'Original accepted instructions',
    );
    expect(JSON.stringify(input)).not.toContain('Rejected instructions');
    peer.model.assertExhausted();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it('joins normal provider/session cleanup and permits a fresh search session afterward', async () => {
  await using peer = await searchPeer([
    [message('first')],
    [message('second')],
  ]);
  const provider = providerAt(peer.url);
  try {
    const agent = new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider,
      tools: [webSearch()],
    });
    const first = await agent.session();
    await (await first.submit('First')).wait();
    await first.close();
    await first.close();
    await using second = await agent.session();
    await (await second.submit('Second')).wait();
  } finally {
    await provider.close();
  }
  expect(peer.searches).toHaveLength(0);
  peer.model.assertExhausted();
}, 30000);

it('inherits the captured standalone grant into a current admitted child', async () => {
  const executor = await startPublicExecutor();
  try {
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId)
        return count === 1
          ? [
              call(
                'spawn_agent',
                {
                  task_name: 'research',
                  message: 'Search selected-search',
                  agent_type: 'research',
                },
                { namespace: 'collaboration', callId: 'child-search' },
              ),
            ]
          : [message('root done')];
      return count === 1 ? [searchCall(false)] : [message('child done')];
    };
    await using peer = await searchPeer(
      Array.from({ length: 4 }, () => respond),
    );
    await using provider = providerAt(peer.url);
    await using session = await new Agent({
      instructions: 'Delegate',
      model: 'gpt-5.5',
      provider,
      tools: [
        webSearch(),
        new NativeAgents({
          additionalRoles: [
            new NativeRole({
              name: 'research',
              description: 'Research',
              instructions: 'Search',
            }),
          ],
        }),
      ],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    await (await session.submit('Delegate')).wait();
    const children = await vi.waitFor(
      async () => {
        const children = await Array.fromAsync(session.subagents());
        expect(children[0]?.turn).toBeTruthy();
        return children;
      },
      { timeout: 5_000 },
    );
    expect(children).toHaveLength(1);
    expect((await children[0].turn!.wait()).finalOutput).toBe('child done');
    expect(peer.searches).toHaveLength(1);
    expect(peer.searches[0].authorization).toBe('Bearer synthetic-web-current');
    peer.model.assertExhausted();
  } finally {
    await executor.close();
  }
}, 45000);

it('closes an active WebSearch session through the existing reader/carrier owner', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using peer = await searchPeer([
    async () => {
      started.resolve();
      await release.promise;
      return [message('released fixture')];
    },
  ]);
  const provider = providerAt(peer.url);
  const session = await new Agent({
    instructions: 'Act',
    model: 'gpt-5.5',
    provider,
    tools: [webSearch()],
  }).session();
  try {
    const turn = await session.submit('Hold this provider request');
    const settled = turn.wait().then(
      () => 'completed',
      () => 'cancelled',
    );
    await started.promise;
    await session.close();
    release.resolve();
    expect(await settled).toBe('cancelled');
    expect(peer.searches).toHaveLength(0);
  } finally {
    release.resolve();
    await session.close();
    await provider.close();
  }
  peer.model.assertExhausted();
}, 45000);

it('local reopen neither replays a completed search nor restores its grant', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agents-web-local-grants-'));
  try {
    await using peer = await searchPeer([
      [searchCall(false, 'local-source')],
      [message('source')],
      [searchCall(false, 'local-denied')],
      [message('denied')],
      [searchCall(false, 'local-current')],
      [message('current')],
    ]);
    const storage = localStorage(join(home, 'profile'));
    let id: string;
    {
      await using source = providerAt(peer.url, 'synthetic-local-source');
      await using session = await new Agent({
        instructions: 'Act',
        model: 'gpt-5.5',
        provider: source,
        tools: [webSearch()],
      }).session({ storage });
      id = session.id;
      await (await session.submit('Search')).wait();
    }
    expect(peer.searches).toHaveLength(1);
    await using destination = providerAt(
      peer.url,
      'synthetic-local-destination',
    );
    {
      await using denied = await new Agent({
        instructions: 'Act',
        provider: destination,
      }).session({ storage, resume: id! });
      expect(denied.id).toBe(id!);
      expect(peer.searches).toHaveLength(1);
      await (
        await denied.submit('Try search without current authority')
      ).wait();
    }
    expect(peer.searches).toHaveLength(1);
    {
      await using granted = await new Agent({
        instructions: 'Act',
        provider: destination,
        tools: [webSearch()],
      }).session({ storage, resume: id! });
      expect(granted.id).toBe(id!);
      expect(peer.searches).toHaveLength(1);
      await (await granted.submit('Use current authority')).wait();
    }
    expect(peer.searches).toHaveLength(2);
    expect(peer.searches[1].authorization).toBe(
      'Bearer synthetic-local-destination',
    );
    peer.model.assertExhausted();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

/** Real source-side graph with legacy policy for restore into fresh workspaces. */
async function savedAgentModels(
  rootModel: string,
  childModel?: string,
  search = false,
): Promise<SessionState> {
  const executor = await startPublicExecutor();
  try {
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    let compactionThreadId: string | undefined;
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const turnMetadata = JSON.parse(
        metadata['x-codex-turn-metadata'],
      ) as JsonObject;
      const id = String(turnMetadata.thread_id);
      rootId ??= id;
      if (turnMetadata.request_kind === 'compaction') {
        expect(childModel).toBeDefined();
        expect(id).not.toBe(rootId);
        expect(compactionThreadId).toBeUndefined();
        expect(request.model).toBe(rootModel);
        expect(turnMetadata.compaction).toMatchObject({
          trigger: 'auto',
          reason: 'comp_hash_changed',
          implementation: 'responses',
          phase: 'pre_turn',
          strategy: 'memento',
        });
        compactionThreadId = id;
        return [
          message('Summary: the research child must finish without tools.'),
        ];
      }
      expect(turnMetadata.request_kind).toBe('turn');
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (childModel && id === rootId && count === 1)
        return [
          call(
            'spawn_agent',
            {
              task_name: 'saved_research',
              message: 'Finish without tools',
              agent_type: 'research',
            },
            { namespace: 'collaboration', callId: 'saved-model-child' },
          ),
        ];
      if (id !== rootId) {
        expect(id).toBe(compactionThreadId);
        expect(request.model).toBe(childModel);
        expect(count).toBe(1);
      }
      return [message(id === rootId ? 'root done' : 'child done')];
    };
    await using peer = await searchPeer(
      Array.from({ length: childModel ? 4 : 1 }, () => respond),
    );
    await using provider = providerAt(peer.url, 'synthetic-saved-model-source');
    await using session = await new Agent({
      instructions: 'Act',
      model: rootModel,
      provider,
      tools: [
        new NativeAgents({
          additionalRoles: childModel
            ? [
                new NativeRole({
                  name: 'research',
                  description: 'Research',
                  instructions: 'Research',
                  model: childModel,
                }),
              ]
            : [],
        }),
        ...(search ? [webSearch()] : []),
      ],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        writePolicy: 'legacy',
      }),
    });
    await (await session.submit('Finish')).wait();
    if (childModel) {
      const turn = await vi.waitFor(
        async () => {
          const children = await Array.fromAsync(session.subagents());
          expect(children).toHaveLength(1);
          const [child] = children;
          const turn = child?.turn;
          if (!turn) throw new Error('Expected the saved child turn');
          return turn;
        },
        { timeout: 5_000 },
      );
      expect((await turn.wait()).finalOutput).toBe('child done');
    }
    const state = await session.saveState();
    if (childModel) {
      expect(state.descendants).toHaveLength(1);
      expect(state.descendants[0].status).toBe('active');
      expect(state.descendants[0].metadata.model).toBe(childModel);
    }
    expect(peer.searches).toHaveLength(0);
    peer.model.assertExhausted();
    return state;
  } finally {
    await executor.close();
  }
}

it.each([false, true])(
  'rejects saved Lite child before destination effects (source standalone=%s)',
  async (search) => {
    const state = await savedAgentModels('gpt-5.5', 'gpt-5.6-sol', search);
    await using peer = await searchPeer([]);
    await using provider = providerAt(
      peer.url,
      'synthetic-saved-model-destination',
    );
    await using executor = await forbiddenExecutor('legacy');
    await expect(
      new Agent({
        instructions: 'Act',
        model: 'gpt-5.5',
        provider,
        tools: [
          webSearch({ route: 'hosted' }),
          new NativeAgents({
            additionalRoles: [
              new NativeRole({
                name: 'research',
                description: 'Research',
                instructions: 'Research',
              }),
            ],
          }),
        ],
      }).session({ state, environment: executor.environment }),
    ).rejects.toThrow(/hosted/i);
    expect(executor.attempts).toBe(0);
    expect(peer.model.requests).toHaveLength(0);
    expect(peer.searches).toHaveLength(0);
    peer.model.assertExhausted();
  },
  60000,
);

it('admits a closed saved Lite child as inert history without widening current catalog authority', async () => {
  const captured = await savedAgentModels('gpt-5.5', 'gpt-5.6-sol');
  // The portable schema accepts an individually closed edge, independent of a
  // completed child turn. This checks imported data, not a new child-close API.
  const state = JSON.parse(JSON.stringify(captured));
  state.descendants[0].status = 'closed';
  state.descendants[0].closed_at = 1;
  const executor = await startPublicExecutor();
  try {
    await using peer = await searchPeer([]);
    await using provider = providerAt(peer.url);
    await using session = await new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider,
      tools: [
        webSearch({ route: 'hosted' }),
        new NativeAgents({
          additionalRoles: [
            new NativeRole({
              name: 'research',
              description: 'Research',
              instructions: 'Research',
            }),
          ],
        }),
      ],
    }).session({
      state,
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        writePolicy: 'legacy',
      }),
    });
    const children = [];
    for await (const child of session.subagents()) children.push(child);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('closed');
    expect(children[0].isLive).toBe(false);
    expect(peer.model.requests).toHaveLength(0);
    expect(peer.searches).toHaveLength(0);
    peer.model.assertExhausted();
  } finally {
    await executor.close();
  }
}, 60000);

it('checks a saved NativeAgents root model before current compatible roles can hide it', async () => {
  const state = await savedAgentModels('gpt-5.6-sol', undefined, true);
  await using peer = await searchPeer([]);
  await using provider = providerAt(peer.url);
  await using executor = await forbiddenExecutor('legacy');
  await expect(
    new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider,
      tools: [webSearch({ route: 'hosted' }), new NativeAgents()],
    }).session({ state, environment: executor.environment }),
  ).rejects.toThrow(/hosted/i);
  expect(executor.attempts).toBe(0);
  expect(peer.model.requests).toHaveLength(0);
  expect(peer.searches).toHaveLength(0);
  peer.model.assertExhausted();
}, 60000);

async function ordinarySavedModel(): Promise<SessionState> {
  await using peer = await searchPeer([[message('saved')]]);
  await using provider = providerAt(peer.url);
  await using session = await new Agent({
    instructions: 'Act',
    model: 'gpt-5.5',
    provider,
  }).session();
  await (await session.submit('Save')).wait();
  const state = await session.saveState();
  peer.model.assertExhausted();
  return state;
}

it('retains explicit compatible config for the old three-argument checkpoint engine caller', async () => {
  const state = await ordinarySavedModel();
  await using peer = await searchPeer([]);
  await using provider = providerAt(peer.url);
  const native = await binding();
  const create = native.create_checkpoint_engine.bind(native);
  let legacyCalls = 0;
  const spy = vi
    .spyOn(native, 'create_checkpoint_engine')
    .mockImplementation((config, runtime, key) => {
      legacyCalls++;
      // Deliberately exercise the real native factory with exactly its old args.
      return create(config, runtime, key);
    });
  try {
    await using session = await new Agent({
      instructions: 'Act',
      model: 'gpt-5.5',
      provider,
      tools: [webSearch({ route: 'hosted' })],
    }).session({ state });
    expect(session.id).toBe(state.source_session_id);
    expect(legacyCalls).toBe(1);
    expect(peer.model.requests).toHaveLength(0);
    expect(peer.searches).toHaveLength(0);
    peer.model.assertExhausted();
  } finally {
    spy.mockRestore();
  }
}, 30000);

it('uses explicit compatible config for a valid managed checkpoint without settings history', async () => {
  const saved = await ordinarySavedModel();
  const history = saved.history.filter((item) => {
    const payload = item.payload;
    return !(
      item.type === 'event_msg' &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      payload.type === 'thread_settings_applied'
    );
  });
  expect(history.length).toBeLessThan(saved.history.length);
  const state: SessionState = { ...saved, history };
  await using peer = await searchPeer([]);
  await using provider = providerAt(peer.url);
  await using session = await new Agent({
    instructions: 'Act',
    model: 'gpt-5.5',
    provider,
    tools: [webSearch({ route: 'hosted' })],
  }).session({ state });
  expect(session.id).toBe(saved.source_session_id);
  expect(peer.model.requests).toHaveLength(0);
  expect(peer.searches).toHaveLength(0);
  peer.model.assertExhausted();
}, 30000);

const wireUsageCases = [
  { container: 'root', compacted: false },
  { container: 'root', compacted: true },
  { container: 'descendant', compacted: false },
  { container: 'descendant', compacted: true },
] as const;

function usageHistory(state: SessionState, container: 'root' | 'descendant') {
  if (container === 'root')
    return { history: state.history, threadId: state.source_session_id };
  const child = state.descendants[0];
  if (!child) throw new Error('Missing saved descendant');
  return { history: child.history, threadId: child.thread_id };
}

function wireUsageItem(
  threadId: string,
  counter: string | number,
  compacted: boolean,
  replacementHistory: JsonObject[],
): JsonObject {
  const usage = {
    input_tokens: counter,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: counter,
  };
  const record = {
    thread_id: threadId,
    session_id: threadId,
    turn_id: 'wire-usage-turn',
    root_turn_id: 'wire-usage-turn',
    response_id: 'web-search-wire-usage',
    usage,
    turn_token_usage: usage,
    thread_token_usage: usage,
  };
  return compacted
    ? {
        type: 'compacted',
        payload: {
          message: 'Retained exact usage',
          replacement_history: replacementHistory,
          latest_token_usage_record: record,
        },
      }
    : { type: 'token_usage_record', payload: record };
}

it.each(wireUsageCases)(
  'portable opening and restore preserve exact counters in $container history (compacted=$compacted)',
  async ({ container, compacted }) => {
    const saved =
      container === 'descendant'
        ? await savedAgentModels('gpt-5.5', 'gpt-5.6-sol')
        : await ordinarySavedModel();
    const state = structuredClone(saved);
    const { history, threadId } = usageHistory(state, container);
    const large = '9007199254740993';
    const replacementHistory = history
      .filter((item) => item.type === 'response_item')
      .map((item) => item.payload as JsonObject);
    history.push(wireUsageItem(threadId, large, compacted, replacementHistory));
    const unsafe = structuredClone(state);
    const unsafeHistory = usageHistory(unsafe, container).history;
    unsafeHistory[unsafeHistory.length - 1] = wireUsageItem(
      threadId,
      Number.MAX_SAFE_INTEGER + 1,
      compacted,
      replacementHistory,
    );
    const executor = await startPublicExecutor();
    try {
      await using peer = await searchPeer([]);
      await using provider = providerAt(peer.url);
      const agent = new Agent({
        instructions: 'Act',
        model: 'gpt-5.5',
        provider,
        tools:
          container === 'descendant'
            ? [
                new NativeAgents({
                  additionalRoles: [
                    new NativeRole({
                      name: 'research',
                      description: 'Research',
                      instructions: 'Research',
                      model: 'gpt-5.6-sol',
                    }),
                  ],
                }),
              ]
            : [],
      });
      {
        await using forbidden = await forbiddenExecutor('legacy');
        await expect(
          agent.session({ state: unsafe, environment: forbidden.environment }),
        ).rejects.toThrow(/Unsafe numeric checkpoint usage counter/i);
        expect(forbidden.attempts).toBe(0);
      }
      // No WebSearch declaration: the new constructor preflight also handles
      // ordinary portable openings and must preserve their wire-counter contract.
      await using restored = await agent.session({
        state,
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
          writePolicy: 'legacy',
        }),
      });
      expect(restored.id).toBe(state.source_session_id);
      const reopened = await restored.saveState();
      const retained = usageHistory(reopened, container).history.find(
        (item) => {
          if (item.type !== (compacted ? 'compacted' : 'token_usage_record'))
            return false;
          const payload = item.payload as JsonObject;
          const record = compacted
            ? (payload.latest_token_usage_record as JsonObject)
            : payload;
          return record?.response_id === 'web-search-wire-usage';
        },
      );
      expect(retained).toBeDefined();
      const payload = retained!.payload as JsonObject;
      const record = compacted
        ? (payload.latest_token_usage_record as JsonObject)
        : payload;
      for (const group of ['usage', 'turn_token_usage', 'thread_token_usage'])
        expect(record[group]).toMatchObject({
          input_tokens: large,
          total_tokens: large,
        });
      expect(peer.model.requests).toHaveLength(0);
      expect(peer.searches).toHaveLength(0);
      peer.model.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  60000,
);
