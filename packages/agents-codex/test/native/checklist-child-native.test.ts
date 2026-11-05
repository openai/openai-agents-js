import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  checklist,
  type ChecklistState,
  type Session,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

function threadId(request: JsonObject): string {
  const metadata = request.client_metadata as Record<string, string>;
  return String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
}

function planOutput(request: JsonObject, callId: string): string {
  const items = request.input as Array<{
    type: string;
    call_id?: string;
    output?: string | Array<{ text?: string }>;
  }>;
  const output = items.find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  )?.output;
  expect(output).toBeDefined();
  return typeof output === 'string'
    ? output
    : output!.map((part) => part.text ?? '').join('');
}

async function finishChildren(
  session: Session,
  rootSubmissionId: string,
  count: number,
  status: 'completed' | 'failed',
): Promise<ReadonlySet<string>> {
  const finished = new Set<string>();
  const turnIds = new Set<string>();
  for await (const event of session.events()) {
    if (
      event.type === 'turn_finished' &&
      event.submissionId !== rootSubmissionId
    ) {
      expect(event.status).toBe(status);
      finished.add(event.submissionId);
      turnIds.add(event.turnId);
      if (finished.size === count) return turnIds;
    }
  }
  throw new Error('Session closed before the children finished');
}

it('keeps accepted root and child checklists distinct and reads inert restored descendants without a grant', async () => {
  const executor = await startPublicExecutor();
  try {
    let rootId: string | undefined;
    let readonly = false;
    const requests = new Map<string, number>();
    const labels = new Map<string, string>();
    const reply = (request: JsonObject) => {
      const id = threadId(request);
      rootId ??= id;
      if (readonly) {
        expect(JSON.stringify(request.tools)).not.toContain('update_plan');
        return [
          call(
            'update_plan',
            { plan: [{ step: 'forbidden replacement', status: 'completed' }] },
            { callId: 'restored-denied-plan' },
          ),
        ];
      }
      const count = (requests.get(id) ?? 0) + 1;
      requests.set(id, count);
      if (!labels.has(id))
        labels.set(id, id === rootId ? 'root' : `child-${labels.size}`);
      const label = labels.get(id)!;
      expect(request.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'function', name: 'update_plan' }),
        ]),
      );
      if (count === 1)
        return [
          call(
            'update_plan',
            {
              explanation: `plan for ${label}`,
              plan: [
                { step: `${label} first`, status: 'completed' },
                { step: `${label} next`, status: 'in_progress' },
                { step: `${label} last`, status: 'pending' },
              ],
            },
            { callId: `plan-${label}` },
          ),
        ];
      expect(planOutput(request, `plan-${label}`)).toContain('Plan updated');
      if (id === rootId && count === 2)
        return ['alpha', 'beta'].map((name) =>
          call(
            'spawn_agent',
            {
              task_name: name,
              message: 'Write your own checklist and finish.',
            },
            { namespace: 'collaboration', callId: `spawn-${name}` },
          ),
        );
      return [message(`${label} complete`)];
    };
    const server = new ModelServer(Array.from({ length: 8 }, () => reply));
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Plan, then delegate to two workers.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents(), checklist()],
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    let state;
    let rootPlan: ChecklistState;
    const childPlans = new Map<string, ChecklistState>();
    {
      await using source = await agent.session({ environment });
      expect(await source.checklist()).toBeNull();
      expect(server.requests).toHaveLength(0);
      const root = await source.submit('Begin.');
      expect((await root.wait()).finalOutput).toBe('root complete');
      const childTurnIds = await finishChildren(
        source,
        root.submissionId,
        2,
        'completed',
      );
      const modelCount = server.requests.length;
      const executorCount = executor.requests.length;
      rootPlan = (await source.checklist())!;
      expect(rootPlan).toEqual({
        threadId: source.id,
        turnId: root.turnId,
        explanation: 'plan for root',
        plan: [
          { step: 'root first', status: 'completed' },
          { step: 'root next', status: 'in_progress' },
          { step: 'root last', status: 'pending' },
        ],
      });
      expect(await source.checklist({ subagentId: source.id })).toEqual(
        rootPlan,
      );
      const children = [];
      for await (const child of source.subagents()) children.push(child);
      expect(children).toHaveLength(2);
      for (const child of children) {
        const label = labels.get(child.id)!;
        expect(label).toMatch(/^child-[12]$/);
        const turns = [];
        for await (const turn of source.turns({ subagentId: child.id }))
          turns.push(turn);
        const plan = (await source.checklist({ subagentId: child.id }))!;
        expect(turns.map((turn) => turn.id)).toContain(plan.turnId);
        expect(childTurnIds.has(plan.turnId)).toBe(true);
        expect(plan.turnId).not.toBe(root.turnId);
        expect(plan).toEqual({
          threadId: child.id,
          turnId: plan.turnId,
          explanation: `plan for ${label}`,
          plan: [
            { step: `${label} first`, status: 'completed' },
            { step: `${label} next`, status: 'in_progress' },
            { step: `${label} last`, status: 'pending' },
          ],
        });
        childPlans.set(child.id, plan);
      }
      await expect(
        source.checklist({ subagentId: 'not-a-thread-id' }),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(modelCount);
      expect(executor.requests).toHaveLength(executorCount);
      await using foreign = await agent.session({ environment });
      const foreignModelCount = server.requests.length;
      const foreignExecutorCount = executor.requests.length;
      await expect(
        source.checklist({ subagentId: foreign.id }),
      ).rejects.toThrow();
      await expect(
        foreign.checklist({ subagentId: children[0].id }),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(foreignModelCount);
      expect(executor.requests).toHaveLength(foreignExecutorCount);
      state = await source.saveState();
    }
    readonly = true;
    await using restored = await agent.session({
      environment,
      state,
      tools: [new NativeAgents()],
    });
    const modelCount = server.requests.length;
    const executorCount = executor.requests.length;
    const restoredRoot = { ...rootPlan, threadId: restored.id };
    expect(await restored.checklist()).toEqual(restoredRoot);
    const restoredChildren = [];
    for await (const child of restored.subagents())
      restoredChildren.push(child);
    expect(restoredChildren.map((child) => child.id).sort()).toEqual(
      [...childPlans.keys()].sort(),
    );
    for (const child of restoredChildren) {
      expect(child.isLive).toBe(false);
      expect(child.turn).toBeNull();
      expect(await restored.checklist({ subagentId: child.id })).toEqual(
        childPlans.get(child.id),
      );
    }
    expect(server.requests).toHaveLength(modelCount);
    expect(executor.requests).toHaveLength(executorCount);
    const denied = await restored.submit('Attempt a new plan.');
    await expect(denied.wait()).rejects.toBeInstanceOf(NativeError);
    expect(await restored.checklist()).toEqual(restoredRoot);
    for (const [id, plan] of childPlans)
      expect(await restored.checklist({ subagentId: id })).toEqual(plan);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 20_000);

it('does not give a child update_plan authority when its parent has no checklist grant', async () => {
  const executor = await startPublicExecutor();
  try {
    let rootId: string | undefined;
    let rootRequests = 0;
    let childId: string | undefined;
    const reply = (request: JsonObject) => {
      const id = threadId(request);
      rootId ??= id;
      expect(JSON.stringify(request.tools)).not.toContain('update_plan');
      if (id === rootId) {
        rootRequests++;
        return rootRequests === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'worker', message: 'Attempt a checklist update.' },
                { namespace: 'collaboration', callId: 'spawn-worker' },
              ),
            ]
          : [message('root complete')];
      }
      childId = id;
      return [
        call(
          'update_plan',
          { plan: [{ step: 'ungranted child plan', status: 'completed' }] },
          { callId: 'child-denied-plan' },
        ),
      ];
    };
    const server = new ModelServer(Array.from({ length: 3 }, () => reply));
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Delegate once.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents()],
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    await using session = await agent.session({ environment });
    const root = await session.submit('Begin.');
    expect((await root.wait()).finalOutput).toBe('root complete');
    await finishChildren(session, root.submissionId, 1, 'failed');
    expect(childId).toBeDefined();
    const modelCount = server.requests.length;
    const executorCount = executor.requests.length;
    expect(await session.checklist()).toBeNull();
    expect(await session.checklist({ subagentId: childId! })).toBeNull();
    expect(server.requests).toHaveLength(modelCount);
    expect(executor.requests).toHaveLength(executorCount);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 20_000);
