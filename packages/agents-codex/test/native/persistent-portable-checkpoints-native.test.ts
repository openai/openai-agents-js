import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  checklist,
  localStorage,
  nativeGoals,
  parseSessionState,
  tool,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it.each(['live-root', 'cold-reference', 'retired-reference'])(
  'exports complete independent LocalStorage checkpoints (%s)',
  async (mode) => {
    const referenced = mode !== 'live-root';
    const home = await mkdtemp(join(tmpdir(), 'native-portable-local-'));
    const directory = join(home, 'source');
    const effects: string[] = [];
    const output = `complete-tool-result-${'x'.repeat(131072)}`;
    const read = tool({
      name: 'read',
      parameters: z.object({}),
      execute: () => {
        effects.push('source');
        return output;
      },
    });
    const server = new ModelServer([
      [call('read', {}, { callId: 'original-read' })],
      [message('original complete')],
      [message('source later')],
      [message('portable later')],
    ]);
    try {
      const config = await server.config();
      const baseUrl = (
        config['model_providers.fixture'] as { base_url: string }
      ).base_url;
      await using provider = new NativeProvider({
        baseUrl,
        apiKey: 'synthetic-source',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Keep the conversation.',
        tools: [read],
        provider,
      });
      const storage = localStorage(directory);
      let source = await agent.session({ storage });
      let saved: Awaited<ReturnType<typeof source.saveState>>;
      let before: Awaited<ReturnType<typeof source.historySnapshot>>;
      let selectedId: string;
      try {
        await (await source.submit('original input')).wait();
        const current = await source.historySnapshot();
        await source.transactHistory({
          expectedRevision: current.revision,
          keep: current.total,
          items: [
            {
              type: 'application-audit',
              payload: { '$serde_json::private::Number': '7', kept: '😀' },
            },
          ],
        });
        selectedId = referenced ? await source.forkStored() : source.id;
        if (referenced) {
          const ancestorId = source.id;
          await source.close();
          if (mode === 'retired-reference') {
            await using ancestor = await agent.session({
              storage,
              resume: ancestorId,
            });
            await ancestor.deleteStored({ preserveDescendants: true });
          }
          source = await agent.session({ storage, resume: selectedId });
        }
        before = await source.historySnapshot();
        saved = parseSessionState(JSON.stringify(await source.saveState()));
        expect(source.id).toBe(selectedId);
        expect(saved.source_session_id).toBe(selectedId);
        expect(await source.historySnapshot()).toEqual(before);
        expect((await source.checkpointStatus({ kind: 'idle' })).status).toBe(
          'ready',
        );
        await (await source.submit('source-only later input')).wait();
      } finally {
        await source.close();
      }
      expect(server.requests).toHaveLength(3);
      expect(effects).toEqual(['source']);
      await rename(directory, join(home, 'unavailable-source'));
      const currentRead = tool({
        name: 'read',
        parameters: z.object({}),
        execute: () => {
          effects.push('current');
          return 'current authority';
        },
      });
      await using current = new NativeProvider({
        baseUrl,
        apiKey: 'synthetic-current',
        supportsWebsockets: false,
      });
      const target = new Agent({
        instructions: 'Keep the conversation.',
        tools: [currentRead],
        provider: current,
      });
      await using restored = await target.session({ state: saved! });
      expect(restored.id).toBe(selectedId!);
      const actual = await restored.historySnapshot();
      expect(actual.items.slice(0, before!.total)).toEqual(before!.items);
      expect(JSON.stringify(actual.items)).toContain(output);
      expect(JSON.stringify(actual.items)).not.toContain(
        'source-only later input',
      );
      expect(restored.restoredTurn).toBeNull();
      expect(server.requests).toHaveLength(3);
      await (await restored.submit('portable later input')).wait();
      const outputs = (request: JsonObject) =>
        (request.input as JsonObject[]).filter(
          (item) => item.type === 'function_call_output',
        );
      expect(outputs(server.requests[3]!)).toEqual(
        outputs(server.requests[1]!),
      );
      expect(server.requestHeaders[3]!.authorization).toBe(
        'Bearer synthetic-current',
      );
      expect(JSON.stringify(server.requests[3]!.input)).not.toContain(
        'application-audit',
      );
      expect(effects).toEqual(['source']);
      server.assertExhausted();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it('keeps accepted goal and checklist state without granting new mutation authority', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-portable-sidecars-'));
  const server = new ModelServer([
    [
      call(
        'update_plan',
        { plan: [{ step: 'accepted plan', status: 'completed' }] },
        { callId: 'plan' },
      ),
    ],
    [message('planned')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-sidecars',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Plan once.',
      tools: [checklist(), nativeGoals()],
      provider,
    });
    const source = await agent.session({ storage: localStorage(home) });
    let state: Awaited<ReturnType<typeof source.saveState>>;
    let goal: Awaited<ReturnType<typeof source.goal>>;
    let plan: Awaited<ReturnType<typeof source.checklist>>;
    try {
      await source.setPausedGoal('Preserve this goal', { tokenBudget: 4000 });
      await (await source.submit('make the plan')).wait();
      goal = await source.goal();
      plan = await source.checklist();
      state = parseSessionState(JSON.stringify(await source.saveState()));
    } finally {
      await source.close();
    }
    const target = new Agent({ instructions: 'Plan once.', provider });
    await using restored = await target.session({ state: state! });
    expect(goal!).not.toBeNull();
    expect(state!.root_goal).not.toBeNull();
    expect((await restored.saveState()).root_goal).toEqual(state!.root_goal);
    await expect(restored.goal()).rejects.toThrow('current NativeGoals');
    expect(await restored.checklist()).toEqual(plan!);
    await expect(
      restored.setPausedGoal('ungranted replacement'),
    ).rejects.toThrow();
    expect((await restored.saveState()).root_goal).toEqual(state!.root_goal);
    expect(server.requests).toHaveLength(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('captures a cold child and its accepted checklist without restarting it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-portable-graph-'));
  const executor = await startPublicExecutor();
  let rootRequests = 0,
    childRequests = 0,
    childId: string | undefined;
  const reply = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const { agent_name: name } = JSON.parse(metadata['x-codex-turn-metadata']);
    if (name === '/root') {
      rootRequests++;
      if (rootRequests === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'alpha', message: 'Make a plan.', fork_turns: 'all' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      return [message('root complete')];
    }
    return ++childRequests === 1
      ? [
          call(
            'update_plan',
            { plan: [{ step: 'child accepted plan', status: 'completed' }] },
            { callId: 'child-plan' },
          ),
        ]
      : [message('child complete')];
  };
  const server = new ModelServer(Array.from({ length: 6 }, () => reply));
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-graph',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Delegate once.',
      model: 'gpt-5.5',
      tools: [new NativeAgents(), checklist()],
      provider,
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    const storage = localStorage(home);
    const source = await agent.session({ storage, environment });
    const identity = source.id;
    let state: Awaited<ReturnType<typeof source.saveState>>;
    let plan: Awaited<ReturnType<typeof source.checklist>>;
    let count: number;
    let childTurnIds: string[];
    try {
      await (await source.submit('delegate once')).wait();
      const child = await vi.waitUntil(
        async () => (await Array.fromAsync(source.subagents()))[0],
        { timeout: 5000 },
      );
      if (!child.turn) throw new Error('Missing child turn');
      await child.turn.wait();
      childId = child.id;
      plan = await source.checklist({ subagentId: child.id });
      expect(plan).not.toBeNull();
      childTurnIds = (
        await Array.fromAsync(source.turns({ subagentId: child.id }))
      ).map((turn) => turn.id);
      count = server.requests.length;
    } finally {
      await source.close();
    }
    // Ordinary close unloads runtimes; this makes no logical close_agent claim.
    {
      await using coldSource = await agent.session({
        storage,
        resume: identity,
        environment,
      });
      const cold = (await Array.fromAsync(coldSource.subagents()))[0]!;
      expect(cold.id).toBe(childId);
      expect(cold.isLive).toBe(false);
      expect(cold.closedAt).toBeNull();
      const foreign = await agent.session({ storage, environment });
      const foreignId = foreign.id;
      try {
        await foreign.historySnapshot({ limit: 0 });
      } finally {
        await foreign.close();
      }
      await expect(
        coldSource.checklist({ subagentId: foreignId }),
      ).rejects.toThrow('Thread is not part of this session');
      expect(server.requests).toHaveLength(count!);
      state = parseSessionState(JSON.stringify(await coldSource.saveState()));
      expect(server.requests).toHaveLength(count!);
    }
    await using restored = await agent.session({ state: state!, environment });
    const children = await Array.fromAsync(restored.subagents());
    expect(children).toHaveLength(1);
    expect(children[0]!.id).toBe(childId);
    expect(children[0]!.closedAt).toBeNull();
    expect(children[0]!.isLive).toBe(false);
    expect(await restored.checklist({ subagentId: childId! })).toEqual(plan!);
    expect(
      (await Array.fromAsync(restored.turns({ subagentId: childId! }))).map(
        (turn) => turn.id,
      ),
    ).toEqual(childTurnIds!);
    expect(server.requests).toHaveLength(count!);
  } finally {
    await executor.close();
    await rm(home, { recursive: true, force: true });
  }
});

it('keeps settled VM values in a portable memory checkpoint without replaying effects', async () => {
  const effects: string[] = [];
  const effect = tool({
    name: 'effect',
    parameters: z.object({}),
    execute: () => {
      effects.push('once');
      return 'captured once';
    },
  });
  const cell = (callId: string, input: string): JsonObject => ({
    type: 'custom_tool_call',
    name: 'exec',
    call_id: callId,
    input,
  });
  const server = new ModelServer([
    [
      cell(
        'store-cell',
        "store('receipt', await tools.effect({})); store('value', {n:7});",
      ),
    ],
    [message('stored')],
    [cell('read-cell', "text([load('receipt'), load('value').n]);")],
    [message('read')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-vm',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Preserve stored values.',
      tools: [effect],
      provider,
      model: 'gpt-5.5',
      programmaticToolCalling: true,
    });
    const source = await agent.session();
    let saved: Awaited<ReturnType<typeof source.saveState>>;
    try {
      await (await source.submit('store once')).wait();
      saved = parseSessionState(JSON.stringify(await source.saveState()));
      expect(saved.root_code_mode?.stored_values.receipt).toBe('captured once');
    } finally {
      await source.close();
    }
    await using restored = await agent.session({ state: saved! });
    expect(effects).toEqual(['once']);
    expect(server.requests).toHaveLength(2);
    await (await restored.submit('read the saved values')).wait();
    const output = (server.requests[3]!.input as JsonObject[]).find(
      (item) =>
        item.type === 'custom_tool_call_output' && item.call_id === 'read-cell',
    );
    expect(JSON.stringify(output)).toContain('captured once');
    expect(effects).toEqual(['once']);
  } finally {
    await ModelServer.closeAll();
  }
});

it('captures a fresh LocalStorage session without a model request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-portable-empty-'));
  const server = new ModelServer([]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-empty',
      supportsWebsockets: false,
    });
    const agent = new Agent({ instructions: 'No request needed.', provider });
    const source = await agent.session({ storage: localStorage(home) });
    let saved: Awaited<ReturnType<typeof source.saveState>>;
    try {
      saved = parseSessionState(JSON.stringify(await source.saveState()));
      expect(saved.source_session_id).toBe(source.id);
      expect((await source.checkpointStatus({ kind: 'idle' })).status).toBe(
        'ready',
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      await source.close();
    }
    await using restored = await agent.session({ state: saved! });
    expect(restored.id).toBe(saved!.source_session_id);
    expect(restored.restoredTurn).toBeNull();
    expect(server.requests).toHaveLength(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
