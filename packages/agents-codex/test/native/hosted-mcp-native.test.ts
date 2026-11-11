import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  InteractionRequired,
  NativeError,
  Handoff,
  NativeProvider,
  hostedMcp,
  localStorage,
  fileSessionStore,
  type SessionStore,
  tool,
  type HostedMCPApprovalRequest,
} from '../../src';
import { jsonObject, type JsonObject } from '../../src/runtime/binding';
import { z } from 'zod';
import { ModelServer, message, call } from './fixtures/model-server';

const storageHomes: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    storageHomes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  );
});

const responsesModel = z
  .object({
    models: z.array(
      z.object({ slug: z.string(), use_responses_lite: z.boolean() }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  )
  .models.find((entry) => !entry.use_responses_lite)?.slug;
if (!responsesModel)
  throw new Error(
    'Native hosted-tool fixtures require a Responses-capable catalog entry',
  );

const caller = { type: 'direct', fixture: { retained: false } };
function approval(id: string | null = 'mcpr_fixture'): JsonObject {
  return {
    type: 'mcp_approval_request',
    ...(id === null ? {} : { id }),
    server_label: 'docs',
    name: 'lookup',
    arguments: '{"key":"fixture"}',
    caller,
  };
}

async function providerFor(server: ModelServer): Promise<NativeProvider> {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: jsonObject.parse(config['model_providers.fixture'])
      .base_url as string,
    apiKey: 'synthetic-mcp-fixture',
    supportsWebsockets: false,
  });
}

it('selects only the qualified server and preserves the omitted never default', async () => {
  const server = new ModelServer([[message('done')]]);
  await using provider = await providerFor(server);
  const docs = hostedMcp({
    serverLabel: 'docs',
    serverUrl: 'https://docs.invalid/mcp',
  });
  const other = hostedMcp({
    serverLabel: 'other',
    serverUrl: 'https://other.invalid/mcp',
  });
  await using session = await new Agent({
    model: responsesModel,
    instructions: 'Use the configured server.',
    provider,
    tools: [docs, other],
  }).session();
  await session.update({ tools: [docs] });
  expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
    'done',
  );
  const tools = server.requests[0].tools as JsonObject[];
  expect(tools.filter((item) => item.type === 'mcp')).toEqual([
    {
      type: 'mcp',
      server_label: 'docs',
      server_url: 'https://docs.invalid/mcp',
      require_approval: 'never',
    },
  ]);
  expect(
    tools.some((item) => item.type === 'function' && item.name === 'docs'),
  ).toBe(false);
  server.assertExhausted();
});

it.each([true, false])(
  'replies through the captured approval and caller: %s',
  async (approve) => {
    const server = new ModelServer([[approval()], [message('done')]]);
    await using provider = await providerFor(server);
    const callback = vi.fn(
      ({
        requestId,
        serverLabel,
        name,
        arguments: raw,
        caller: observed,
      }: HostedMCPApprovalRequest) => {
        expect({ requestId, serverLabel, name, raw, observed }).toEqual({
          requestId: 'mcpr_fixture',
          serverLabel: 'docs',
          name: 'lookup',
          raw: '{"key":"fixture"}',
          observed: caller,
        });
        return { approve, reason: 'fixture decision' };
      },
    );
    const docs = hostedMcp({
      serverLabel: 'docs',
      serverUrl: 'https://docs.invalid/mcp',
      ...(approve ? { requireApproval: 'always' as const } : {}),
      onApprovalRequest: callback,
    });
    expect(
      (
        await new Agent({
          model: responsesModel,
          instructions: 'Use the configured server.',
          provider,
          tools: [docs],
        }).run('lookup')
      ).finalOutput,
    ).toBe('done');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(server.requests[0].tools).toContainEqual(
      expect.objectContaining({ type: 'mcp', require_approval: 'always' }),
    );
    const input = server.requests[1].input as JsonObject[];
    expect(
      input.find((item) => item.type === 'mcp_approval_response'),
    ).toMatchObject({
      approval_request_id: 'mcpr_fixture',
      approve,
      reason: 'fixture decision',
      caller,
    });
    server.assertExhausted();
  },
);

it('leaves a live manual grant usable after unsupported suspension', async () => {
  const server = new ModelServer([[approval()], [message('done')]]);
  await using provider = await providerFor(server);
  const docs = hostedMcp({ serverLabel: 'docs', requireApproval: 'always' });
  await using session = await new Agent({
    model: responsesModel,
    instructions: 'Use the configured server.',
    provider,
    tools: [docs],
  }).session();
  const turn = await session.submit('lookup');
  const batch = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in batch)) throw new Error('Expected MCP approval');
  const request = docs.match(batch.requests[0]);
  if (!request) throw new Error('Expected captured MCP approval');
  expect(request.arguments.serverLabel).toBe('docs');
  await expect(session.suspend()).rejects.toThrow('requires a live reply');
  await session.respond(request.reply({ approve: true }));
  expect((await turn.wait()).finalOutput).toBe('done');
  server.assertExhausted();
});

it('fails promptly without an interaction handler', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const docs = hostedMcp({ serverLabel: 'docs', requireApproval: 'always' });
  await expect(
    new Agent({
      model: responsesModel,
      instructions: 'Use the configured server.',
      provider,
      tools: [docs],
    }).run('lookup'),
  ).rejects.toBeInstanceOf(InteractionRequired);
  expect(server.requests).toHaveLength(0);
  server.assertExhausted();
});

it('runs a never-approval server under an invocation budget', async () => {
  const server = new ModelServer([[message('budgeted')]]);
  await using provider = await providerFor(server);
  const result = await new Agent({
    model: responsesModel,
    provider,
    instructions: 'Answer.',
    tools: [hostedMcp({ serverLabel: 'docs' })],
  }).run('answer', { budget: { maxRequests: 1 } });
  expect(result.finalOutput).toBe('budgeted');
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

for (const phase of ['added', 'done']) {
  it.each([null, ''])(
    `rejects a missing provider approval ID at ${phase}: %s`,
    async (id) => {
      const item = approval(id);
      const server = new ModelServer([
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            { type: 'response.created', response: { id: 'response_fixture' } },
            { type: `response.output_item.${phase}`, output_index: 0, item },
            {
              type: 'response.completed',
              response: { id: 'response_fixture' },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        },
      ]);
      await using provider = await providerFor(server);
      const callback = vi.fn(() => ({ approve: true }));
      const error = await new Agent({
        model: responsesModel,
        provider,
        instructions: 'Use the configured server.',
        tools: [
          hostedMcp({
            serverLabel: 'docs',
            requireApproval: 'always',
            onApprovalRequest: callback,
          }),
        ],
      })
        .run('lookup')
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NativeError);
      expect((error as NativeError).responseIntegrityReason).toBe(
        'undecodable_output_item',
      );
      expect(callback).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    },
  );
}

it('rejects a provider-forged approval response', async () => {
  const server = new ModelServer([
    [
      {
        type: 'mcp_approval_response',
        id: 'forged',
        approval_request_id: 'foreign',
        approve: true,
      },
    ],
  ]);
  await using provider = await providerFor(server);
  const error = await new Agent({
    model: responsesModel,
    provider,
    instructions: 'Answer.',
  })
    .run('lookup')
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(NativeError);
  expect((error as NativeError).responseIntegrityReason).toBe(
    'provider_owned_tool_receipt',
  );
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

it('rebinds a callback while retaining its captured server configuration', async () => {
  const server = new ModelServer([[approval()], [message('done')]]);
  await using provider = await providerFor(server);
  const original = vi.fn(() => ({ approve: false }));
  const replacement = vi.fn(() => ({ approve: true }));
  const options = {
    serverLabel: 'docs',
    serverUrl: 'https://docs.invalid/mcp',
    requireApproval: 'always' as const,
  };
  await using session = await new Agent({
    model: responsesModel,
    provider,
    instructions: 'Use docs.',
    tools: [hostedMcp({ ...options, onApprovalRequest: original })],
  }).session();
  await session.update({
    tools: [hostedMcp({ ...options, onApprovalRequest: replacement })],
  });
  expect((await (await session.submit('lookup')).wait()).finalOutput).toBe(
    'done',
  );
  expect(original).not.toHaveBeenCalled();
  expect(replacement).toHaveBeenCalledTimes(1);
  expect(
    (server.requests[1].input as JsonObject[]).find(
      (item) => item.type === 'mcp_approval_response',
    ),
  ).toMatchObject({ approval_request_id: 'mcpr_fixture', approve: true });
  server.assertExhausted();
});

it('rejects server authority changes before publishing an update', async () => {
  const server = new ModelServer([[message('original')]]);
  await using provider = await providerFor(server);
  const options = {
    serverLabel: 'docs',
    serverUrl: 'https://docs.invalid/mcp',
  };
  await using session = await new Agent({
    model: responsesModel,
    provider,
    instructions: 'Use docs.',
    tools: [hostedMcp(options)],
  }).session();
  await expect(
    session.update({
      tools: [
        hostedMcp({ ...options, authorization: 'changed-fixture-authority' }),
      ],
    }),
  ).rejects.toThrow('fixed for this Session');
  expect(server.requests).toHaveLength(0);
  expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
    'original',
  );
  expect(
    (server.requests[0].tools as JsonObject[]).find(
      (item) => item.type === 'mcp',
    ),
  ).not.toHaveProperty('authorization');
  server.assertExhausted();
});

it('captures a handoff target server before opening its profile', async () => {
  const server = new ModelServer([
    [call('route_docs', {}, { callId: 'route_fixture' })],
    [approval()],
    [message('target done')],
  ]);
  await using provider = await providerFor(server);
  const callback = vi.fn(() => ({ approve: true }));
  const target = new Agent({
    model: responsesModel,
    instructions: 'Use docs.',
    tools: [
      hostedMcp({
        serverLabel: 'docs',
        serverUrl: 'https://docs.invalid/mcp',
        requireApproval: 'always',
        onApprovalRequest: callback,
      }),
    ],
  });
  const route = tool({
    name: 'route_docs',
    description: 'Route to docs.',
    parameters: z.object({}),
    execute: () => 'routed',
  });
  expect(
    (
      await new Agent({
        model: responsesModel,
        provider,
        instructions: 'Route.',
        handoffs: [new Handoff(target, route)],
      }).run('lookup')
    ).finalOutput,
  ).toBe('target done');
  expect(
    (server.requests[0].tools as JsonObject[]).some(
      (item) => item.type === 'mcp',
    ),
  ).toBe(false);
  expect(
    (server.requests[1].tools as JsonObject[]).find(
      (item) => item.type === 'mcp',
    ),
  ).toMatchObject({
    server_label: 'docs',
    server_url: 'https://docs.invalid/mcp',
  });
  expect(callback).toHaveBeenCalledTimes(1);
  server.assertExhausted();
});

it('rejects a caller outside the captured server policy before application approval', async () => {
  const request = {
    ...approval(),
    caller: { type: 'code_interpreter', tool_id: 'ci_fixture' },
  };
  const server = new ModelServer([[request]]);
  await using provider = await providerFor(server);
  const callback = vi.fn(() => ({ approve: true }));
  await expect(
    new Agent({
      model: responsesModel,
      provider,
      instructions: 'Use docs.',
      tools: [
        hostedMcp({
          serverLabel: 'docs',
          serverUrl: 'https://docs.invalid/mcp',
          requireApproval: 'always',
          allowedCallers: ['direct'],
          onApprovalRequest: callback,
        }),
      ],
    }).run('lookup'),
  ).rejects.toThrow('Unadmitted Hosted MCP request');
  expect(callback).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

it.each([true, false])(
  'retains list and call items with original provider data and producing Agent (status: %s)',
  async (withStatus) => {
    const list: JsonObject = {
      type: 'mcp_list_tools',
      id: 'mcpl_fixture',
      server_label: 'docs',
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    };
    const invoked: JsonObject = {
      type: 'mcp_call',
      id: 'mcp_fixture',
      server_label: 'docs',
      name: 'lookup',
      arguments: '{"key":"fixture"}',
      ...(withStatus ? { status: 'completed' } : {}),
      output: 'found',
      caller,
    };
    const server = new ModelServer([[list, invoked, message('done')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: responsesModel,
      provider,
      instructions: 'Use docs.',
      tools: [
        hostedMcp({
          serverLabel: 'docs',
          serverUrl: 'https://docs.invalid/mcp',
        }),
      ],
    });
    const result = await agent.run('lookup', { returnItems: true });
    for (const raw of [list, invoked]) {
      const item = result.items?.find((entry) => entry.item.type === raw.type);
      expect(item?.agent).toBe(agent);
      expect(item?.item).toMatchObject({ type: raw.type, provider_data: raw });
    }
    const called = result.items?.find(
      (entry) => entry.item.type === 'mcp_call',
    )?.item;
    expect(called).toHaveProperty('callId', null);
    expect(called).not.toHaveProperty('threadId');
    server.assertExhausted();
  },
);

it('rejects edited positive approval authority while retaining negative cold restore', async () => {
  const server = new ModelServer([
    [approval()],
    [message('denied')],
    [message('restored')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: responsesModel,
    provider,
    instructions: 'Use docs.',
    tools: [
      hostedMcp({
        serverLabel: 'docs',
        serverUrl: 'https://docs.invalid/mcp',
        requireApproval: 'always',
        onApprovalRequest: () => ({ approve: false }),
      }),
    ],
  });
  await using session = await agent.session();
  expect((await (await session.submit('lookup')).wait()).finalOutput).toBe(
    'denied',
  );
  const saved = JSON.parse(JSON.stringify(await session.saveState()));
  await session.close();
  let changed = 0;
  const edited = JSON.parse(
    JSON.stringify(saved, (_key, value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        value.type === 'mcp_approval_response'
      ) {
        changed++;
        return { ...value, approve: true };
      }
      return value;
    }),
  );
  expect(changed).toBeGreaterThan(0);
  await expect(agent.session({ state: edited })).rejects.toThrow(
    'live SDK approval authority',
  );
  expect(server.requests).toHaveLength(2);
  await using restored = await agent.session({ state: saved });
  expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
    'restored',
  );
  expect(
    (server.requests[2].input as JsonObject[]).some(
      (item) => item.type === 'mcp_approval_response' && item.approve === true,
    ),
  ).toBe(false);
  server.assertExhausted();
});

for (const configured of [false, true]) {
  it(`fences a dispatched MCP request before ${configured ? 'configured' : 'default'} recovery`, async () => {
    const server = new ModelServer([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      },
      [message('replayed')],
    ]);
    await using provider = await providerFor(server);
    const policy = vi.fn(() => ({
      retry: true,
      delayMs: 0,
      approveUnsafeReplay: true,
    }));
    const agent = new Agent({
      model: responsesModel,
      provider,
      instructions: 'Use docs.',
      tools: [hostedMcp({ serverLabel: 'docs' })],
      ...(configured
        ? {
            modelSettings: {
              retry: {
                maxRetries: 1,
                backoff: { initialDelayMs: 0, jitter: false },
                policy,
              },
            },
          }
        : {}),
    });
    await expect(agent.run('lookup')).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
    if (configured) expect(policy).toHaveBeenCalledTimes(1);
    else expect(policy).not.toHaveBeenCalled();
  });
  it(`retains ${configured ? 'configured' : 'default'} recovery after explicitly omitting MCP`, async () => {
    const server = new ModelServer([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      },
      [message('recovered')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: responsesModel,
      provider,
      instructions: 'Answer.',
      tools: [hostedMcp({ serverLabel: 'docs' })],
      ...(configured
        ? {
            modelSettings: {
              retry: {
                maxRetries: 1,
                backoff: { initialDelayMs: 0, jitter: false },
              },
            },
          }
        : {}),
    });
    await using session = await agent.session();
    await session.update({ tools: [] });
    expect((await (await session.submit('answer')).wait()).finalOutput).toBe(
      'recovered',
    );
    expect(server.requests).toHaveLength(2);
    expect(
      (server.requests[0].tools as JsonObject[]).some(
        (item) => item.type === 'mcp',
      ),
    ).toBe(false);
    server.assertExhausted();
  });
}

for (const kind of ['local', 'canonical'] as const) {
  for (const approve of [false, true]) {
    it(`commits ${approve ? 'approved' : 'denied'} Hosted MCP receipts through ${kind} storage without replaying authority`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'native-hosted-mcp-'));
      storageHomes.push(home);
      const storage =
        kind === 'local'
          ? localStorage(join(home, 'profile'))
          : fileSessionStore(join(home, 'canonical'));
      const completed = {
        type: 'mcp_call',
        id: 'mcp_done',
        server_label: 'docs',
        name: 'lookup',
        arguments: '{"key":"A"}',
        output: 'retained result',
        status: 'completed',
      };
      const server = new ModelServer([
        [approval()],
        [completed, message('accepted')],
        [message('reopened')],
      ]);
      await using provider = await providerFor(server);
      const callback = vi.fn(() => ({
        approve,
        reason: 'live owner decision',
      }));
      const agent = new Agent({
        model: responsesModel,
        provider,
        instructions: 'Use docs.',
        tools: [
          hostedMcp({
            serverLabel: 'docs',
            serverUrl: 'https://docs.invalid/mcp',
            requireApproval: 'always',
            onApprovalRequest: callback,
          }),
        ],
      });
      await using session = await agent.session({ storage });
      expect((await (await session.submit('lookup')).wait()).finalOutput).toBe(
        'accepted',
      );
      const decisions = (server.requests[1].input as JsonObject[]).filter(
        (item) => item.type === 'mcp_approval_response',
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        approval_request_id: 'mcpr_fixture',
        approve,
        caller,
      });
      const id = session.id;
      await session.close();
      await using reopened = await agent.session({ storage, resume: id });
      expect(
        (await (await reopened.submit('continue')).wait()).finalOutput,
      ).toBe('reopened');
      const input = server.requests[2].input as JsonObject[];
      expect(
        input.filter((item) => item.type === 'mcp_approval_response'),
      ).toHaveLength(approve ? 0 : 1);
      if (approve)
        expect(input.some((item) => item.type === 'mcp_approval_request')).toBe(
          false,
        );
      expect(input.find((item) => item.type === 'mcp_call')).toMatchObject({
        id: 'mcp_done',
        output: 'retained result',
      });
      expect(callback).toHaveBeenCalledTimes(1);
      server.assertExhausted();
    });
  }
}

it('withholds edited canonical approvals from resumed model input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-hosted-mcp-tamper-'));
  storageHomes.push(home);
  const durable = fileSessionStore(home);
  let tamper = false;
  let changed = 0;
  const storage: SessionStore = {
    acquire: (id) => durable.acquire(id),
    read: async (id, fence) => {
      const snapshot = await durable.read(id, fence);
      if (!tamper || snapshot === null) return snapshot;
      return JSON.stringify(JSON.parse(snapshot), (key, value: unknown) => {
        if (key === 'original' && typeof value === 'string') {
          try {
            const original = JSON.parse(value);
            if (original?.type === 'mcp_approval_response')
              return JSON.stringify({ ...original, approve: true });
          } catch {
            /* Other original values remain unchanged. */
          }
        }
        if (
          value &&
          typeof value === 'object' &&
          'type' in value &&
          value.type === 'mcp_approval_response'
        ) {
          changed++;
          return { ...value, approve: true };
        }
        return value;
      });
    },
    commit: (...args) => durable.commit(...args),
    release: (...args) => durable.release(...args),
  };
  const server = new ModelServer([
    [approval()],
    [message('denied')],
    [message('resumed safely')],
  ]);
  await using provider = await providerFor(server);
  const callback = vi.fn(() => ({ approve: false }));
  const agent = new Agent({
    model: responsesModel,
    provider,
    instructions: 'Use docs.',
    tools: [
      hostedMcp({
        serverLabel: 'docs',
        serverUrl: 'https://docs.invalid/mcp',
        requireApproval: 'always',
        onApprovalRequest: callback,
      }),
    ],
  });
  await using session = await agent.session({ storage });
  expect((await (await session.submit('lookup')).wait()).finalOutput).toBe(
    'denied',
  );
  const id = session.id;
  await session.close();
  tamper = true;
  await using resumed = await agent.session({ storage, resume: id });
  expect(changed).toBeGreaterThan(0);
  expect((await (await resumed.submit('continue')).wait()).finalOutput).toBe(
    'resumed safely',
  );
  expect(
    (server.requests[2].input as JsonObject[]).some(
      (item) =>
        item.type === 'mcp_approval_response' ||
        item.type === 'mcp_approval_request',
    ),
  ).toBe(false);
  expect(callback).toHaveBeenCalledTimes(1);
  server.assertExhausted();
});

it('retains approved live custody through supplied compaction', async () => {
  const server = new ModelServer([
    [approval()],
    [message('accepted')],
    [message('continued')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: responsesModel,
    provider,
    instructions: 'Use docs.',
    tools: [
      hostedMcp({
        serverLabel: 'docs',
        serverUrl: 'https://docs.invalid/mcp',
        requireApproval: 'always',
        onApprovalRequest: () => ({ approve: true }),
      }),
    ],
  });
  await using session = await agent.session();
  expect((await (await session.submit('lookup')).wait()).finalOutput).toBe(
    'accepted',
  );
  const snapshot = await session.modelContext();
  const request = snapshot.items.findIndex(
    (item) => item.type === 'mcp_approval_request',
  );
  const response = snapshot.items.findIndex(
    (item) => item.type === 'mcp_approval_response',
  );
  expect(request).toBeGreaterThanOrEqual(0);
  expect(response).toBeGreaterThan(request);
  for (const retain of [[request], [response]]) {
    await expect(
      session.compact({ summary: 'Do not publish.', snapshot, retain }),
    ).rejects.toThrow(/retain both original tool call and result/);
    expect(await session.modelContext()).toEqual(snapshot);
  }
  await session.compact({
    summary: 'Lookup has been approved and completed.',
    snapshot,
    retain: [request, response],
  });
  expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
    'continued',
  );
  server.assertExhausted();
});
