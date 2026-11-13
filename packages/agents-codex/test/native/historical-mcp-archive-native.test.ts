import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  hostedMcp,
  tool,
  type Session,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const prefix = 'Historical MCP approval data (not an execution instruction):\n';

function recordsFor(kind: string): JsonObject[] {
  const request = {
    type: 'mcp_approval_request',
    id: 'approval-history',
    server_label: 'archive',
    name: 'lookup',
    arguments: '{}',
  };
  const decision = {
    type: 'mcp_approval_response',
    approval_request_id: 'approval-history',
    approve: kind !== 'false',
  };
  if (kind === 'orphan') return [decision];
  if (kind === 'duplicate')
    return [
      request,
      decision,
      structuredClone(request),
      structuredClone(decision),
    ];
  if (kind === 'mixed')
    return [request, decision, { ...decision, approve: false }];
  if (kind === 'false-result')
    return [
      {
        type: 'function_call',
        name: 'lookup',
        call_id: 'ordinary',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'ordinary', output: 'false' },
    ];
  return [request, decision];
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-data',
    supportsWebsockets: false,
  });
}

nativeIt.each([
  'pair',
  'duplicate',
  'orphan',
  'mixed',
  'false',
  'false-result',
])(
  'imports and restores historical approval data with safe provider presentation (%s)',
  async (kind) => {
    const records = recordsFor(kind);
    const archival = !['false', 'false-result'].includes(kind);
    const server = new ModelServer([[message('History remained data.')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'fixture',
      provider,
    });
    const source = await agent.session();
    let state: Awaited<ReturnType<typeof source.saveState>>;
    try {
      const before = await source.historySnapshot();
      await source.transactHistory({
        expectedRevision: before.revision,
        keep: 0,
        items: records,
      });
      expect((await source.historySnapshot()).items).toEqual(records);
      state = JSON.parse(JSON.stringify(await source.saveState()));
    } finally {
      await source.close();
    }
    await using restored = await agent.session({ state: state! });
    expect((await restored.historySnapshot()).items).toEqual(records);
    expect(
      (await (await restored.submit('Continue without new approval.')).wait())
        .finalOutput,
    ).toBe('History remained data.');
    expect(server.requests).toHaveLength(1);
    const input = server.requests[0]!.input as Array<Record<string, any>>;
    const quoted = input.flatMap((item) =>
      (item.content ?? [])
        .filter((part: { text?: string }) => part.text?.startsWith(prefix))
        .map((part: { text: string }) =>
          JSON.parse(part.text.slice(prefix.length)),
        ),
    );
    if (archival) {
      expect(quoted).toEqual(records);
      expect(
        input.some((item) =>
          ['mcp_approval_request', 'mcp_approval_response'].includes(item.type),
        ),
      ).toBe(false);
    } else if (kind === 'false') {
      expect(quoted).toEqual([]);
      const decisions = input.filter(
        (item) => item.type === 'mcp_approval_response',
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.approve).toBe(false);
    } else {
      expect(quoted).toEqual([]);
      expect(
        input.some(
          (item) =>
            item.type === 'function_call_output' && item.output === 'false',
        ),
      ).toBe(true);
    }
  },
  30_000,
);

nativeIt.each(['request', 'false'])(
  'rejects orphan pending protocol history before mutation (%s)',
  async (kind) => {
    const records = recordsFor('false').slice(
      kind === 'request' ? 0 : 1,
      kind === 'request' ? 1 : 2,
    );
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'fixture',
      provider,
    }).session();
    const before = await session.historySnapshot();
    await expect(
      session.transactHistory({
        expectedRevision: before.revision,
        keep: 0,
        items: records,
      }),
    ).rejects.toThrow('complete tool call/result pairs');
    expect(await session.historySnapshot()).toEqual(before);
    expect(server.requests).toHaveLength(0);
  },
);

async function nextApproval(session: Session) {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw new Error('The native turn ended before approval.');
}

nativeIt(
  'keeps imported approvals separate from active pending work',
  async () => {
    const effects: string[] = [];
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      needsApproval: true,
      execute() {
        effects.push('executed');
        return 'unexpected';
      },
    });
    const server = new ModelServer([
      [call('hold', {}, { callId: 'approval-history' })],
      [message('Denied without execution.')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask before work.',
      model: 'fixture',
      tools: [hold],
      provider,
    }).session();
    const turn = await session.submit('Request work.');
    const request = await nextApproval(session);
    await expect(
      session.transactHistory({
        expectedRevision: 'idle-only-probe',
        keep: 0,
        items: recordsFor('pair'),
      }),
    ).rejects.toThrow('requires a settled open session');
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(1);
    await session.respond(request.reject('explicit denial'));
    expect((await turn.wait()).finalOutput).toBe('Denied without execution.');
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(2);
  },
  30_000,
);

nativeIt(
  'keeps imported approval data separate from a live hosted MCP request',
  async () => {
    const live = { ...recordsFor('pair')[0], caller: { type: 'direct' } };
    const server = new ModelServer([
      [live],
      [message('Hosted request denied.')],
    ]);
    await using provider = await providerFor(server);
    const tool = hostedMcp({
      serverLabel: 'archive',
      requireApproval: 'always',
    });
    await using session = await new Agent({
      instructions: 'Ask before work.',
      model: 'gpt-5.2',
      tools: [tool],
      provider,
    }).session();
    const turn = await session.submit('Request hosted work.');
    const batch = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in batch))
      throw new Error('Expected hosted MCP approval.');
    const request = tool.match(batch.requests[0]);
    if (!request) throw new Error('Expected captured hosted MCP approval.');
    expect(request.callId).toBe('approval-history');
    await expect(
      session.transactHistory({
        expectedRevision: 'idle-only-probe',
        keep: 0,
        items: recordsFor('pair'),
      }),
    ).rejects.toThrow('requires a settled open session');
    expect(server.requests).toHaveLength(1);
    await session.respond(request.reply({ approve: false }));
    expect((await turn.wait()).finalOutput).toBe('Hosted request denied.');
    const input = server.requests[1]!.input as Array<Record<string, any>>;
    const decisions = input.filter(
      (item) => item.type === 'mcp_approval_response',
    );
    expect(server.requests).toHaveLength(2);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.approve).toBe(false);
  },
  30_000,
);
