import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeRole,
  InteractionRequired,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  toolRef,
  type Session,
  type Completed,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const catalog: {
  slug: string;
  supported_in_api?: boolean;
  use_responses_lite?: boolean;
  multi_agent_version?: string;
}[] =
  process.env.OPENAI_AGENTS_NATIVE_TESTS === '1'
    ? JSON.parse(
        readFileSync(
          process.env.OPENAI_AGENTS_NATIVE_TEST_MODELS_CATALOG ??
            new URL(
              '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
              import.meta.url,
            ),
          'utf8',
        ),
      ).models
    : [];
const model = catalog.find(
  (entry) => entry.supported_in_api && !entry.use_responses_lite,
)?.slug;
const descendantModel = catalog.find(
  (entry) => entry.supported_in_api && entry.multi_agent_version === 'v2',
)?.slug;
if (process.env.OPENAI_AGENTS_NATIVE_TESTS === '1' && !model)
  throw new Error('Expected a catalog model with standard Responses support');

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-configured-child',
    supportsWebsockets: false,
  });
}

async function approval(session: Session) {
  for await (const request of session.interactions())
    if (isFunctionApprovalRequest(request)) return request;
  throw new Error('Expected the managed child approval');
}

async function fixture(
  siblingApproval = false,
  observeChild?: (session: Session) => void,
  observeResult?: (result: Completed) => void,
  afterApproval: ConstructorParameters<typeof ModelServer>[0] = [
    [message('child complete')],
  ],
  parentFollowUp: ConstructorParameters<typeof ModelServer>[0] = [],
  scripts: {
    root?: ConstructorParameters<typeof ModelServer>[0];
    child?: ConstructorParameters<typeof ModelServer>[0];
  } = {},
) {
  const rootModel = new ModelServer(
    scripts.root ?? [
      [
        call(
          'nested_child',
          { input: 'request child approval' },
          { callId: 'nested-parent-call' },
        ),
        call('accepted_sibling', {}, { callId: 'held-sibling-call' }),
      ],
      [message('parent complete')],
      ...parentFollowUp,
    ],
  );
  const childModel = new ModelServer(
    scripts.child ?? [
      [call('child_effect', {}, { callId: 'child-approval-call' })],
      ...afterApproval,
    ],
  );
  const rootProvider = await provider(rootModel);
  const childProvider = await provider(childModel);
  const effects: string[] = [];
  const guards: { name: string; agent: Agent<any, any> }[] = [];
  const sibling = Promise.withResolvers<void>();
  const approvalEntered = Promise.withResolvers<void>();
  const child = new Agent({
    name: 'Nested guarded child',
    instructions: 'Request the child effect.',
    model,
    provider: childProvider,
    tools: [
      tool({
        name: 'child_effect',
        parameters: z.object({}),
        needsApproval() {
          approvalEntered.resolve();
          return true;
        },
        execute() {
          effects.push('child-effect');
          return 'child effect output';
        },
      }),
    ],
    inputGuardrails: [
      {
        name: 'child-input-owner',
        runInParallel: false,
        callback({ agent }) {
          guards.push({ name: 'child-input-owner', agent });
          return { tripwireTriggered: false };
        },
      },
    ],
    outputGuardrails: [
      {
        name: 'child-output-owner',
        callback(_context, agent) {
          guards.push({ name: 'child-output-owner', agent });
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  if (observeChild) {
    const open = child.session.bind(child);
    child.session = async (...args) => {
      const session = await open(...args);
      observeChild(session);
      return session;
    };
  }
  const parent = new Agent({
    name: 'Guarded parent',
    instructions: 'Run the child and sibling.',
    model,
    provider: rootProvider,
    tools: [
      child.asTool({
        toolName: 'nested_child',
        toolDescription: 'Run the configured child.',
        ...(observeResult
          ? {
              customOutputExtractor(result) {
                observeResult(result);
                return result.finalOutput;
              },
            }
          : {}),
      }),
      tool({
        name: 'accepted_sibling',
        parameters: z.object({}),
        needsApproval: siblingApproval,
        execute() {
          effects.push('accepted-sibling');
          sibling.resolve();
          return 'held sibling output';
        },
      }),
    ],
    inputGuardrails: [
      {
        name: 'parent-input-owner',
        runInParallel: false,
        callback({ agent }) {
          guards.push({ name: 'parent-input-owner', agent });
          return { tripwireTriggered: false };
        },
      },
    ],
    outputGuardrails: [
      {
        name: 'parent-output-owner',
        callback(_context, agent) {
          guards.push({ name: 'parent-output-owner', agent });
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  return {
    async [Symbol.asyncDispose]() {
      try {
        await childProvider.close();
      } finally {
        await rootProvider.close();
      }
    },
    rootModel,
    childModel,
    rootProvider,
    childProvider,
    effects,
    guards,
    sibling,
    approvalEntered,
    child,
    parent,
  };
}

nativeIt.each([true, false])(
  'retains configured child approval and sibling owners (approve=%s)',
  async (approve) => {
    await using f = await fixture();
    await using session = await f.parent.session();
    await using foreign = await f.parent.session();
    const root = await session.submit('begin joint witness');
    const boundary = await root.wait({ until: 'interaction' });
    if (!('requests' in boundary))
      throw new Error('Child approval was bypassed');
    const request = boundary.requests.find(isFunctionApprovalRequest);
    if (!request) throw new Error('Expected the child function approval');
    await f.sibling.promise;
    expect(request.sessionId).not.toBe(session.id);
    expect(request.callId).toBe('child-approval-call');
    expect(f.effects).toEqual(['accepted-sibling']);
    expect(f.rootModel.requests).toHaveLength(1);
    expect(f.childModel.requests).toHaveLength(1);
    const pendingHistory = await Array.fromAsync(session.items());
    expect(
      pendingHistory.some(
        (item) =>
          item.type === 'function_call_output' &&
          item.callId === 'held-sibling-call',
      ),
    ).toBe(false);
    const reply = approve
      ? request.approve()
      : request.reject('application denied child effect');
    await expect(foreign.respond(reply)).rejects.toThrow();
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    const result = await root.wait();
    expect(result.finalOutput).toBe('parent complete');
    expect(f.effects).toEqual(
      approve ? ['accepted-sibling', 'child-effect'] : ['accepted-sibling'],
    );
    expect(f.guards).toEqual([
      { name: 'parent-input-owner', agent: f.parent },
      { name: 'child-input-owner', agent: f.child },
      { name: 'child-output-owner', agent: f.child },
      { name: 'parent-output-owner', agent: f.parent },
    ]);
    expect(result.guardrailResults).toEqual([
      expect.objectContaining({ name: 'parent-input-owner', agent: f.parent }),
      expect.objectContaining({ name: 'parent-output-owner', agent: f.parent }),
    ]);
    const outputs = (
      f.rootModel.requests[1].input as Record<string, unknown>[]
    ).filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id)).toEqual([
      'nested-parent-call',
      'held-sibling-call',
    ]);
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  30000,
);

nativeIt.each(['close', 'cancel'] as const)(
  'joins the admitted configured child on parent %s',
  async (operation) => {
    await using f = await fixture();
    await using session = await f.parent.session();
    const root = await session.submit('begin joint witness');
    const completion = root.wait().catch((error: unknown) => error);
    const request = await approval(session);
    await f.sibling.promise;
    expect(f.effects).toEqual(['accepted-sibling']);
    if (operation === 'close') await session.close();
    else await root.cancel();
    expect(await completion).toBeInstanceOf(Error);
    expect(() => request.approve()).toThrow();
    expect(f.effects).toEqual(['accepted-sibling']);
    expect(f.rootModel.requests).toHaveLength(1);
    expect(f.childModel.requests).toHaveLength(1);
  },
  30000,
);

nativeIt(
  'delivers the configured child request through the parent interaction handler',
  async () => {
    await using f = await fixture();
    const calls: string[] = [];
    await using session = await f.parent.session({
      onInteraction(request) {
        if (!isFunctionApprovalRequest(request))
          throw new Error('Expected the child approval');
        calls.push(request.callId);
        return request.approve();
      },
    });
    const root = await session.submit('begin joint witness');
    expect((await root.wait()).finalOutput).toBe('parent complete');
    expect(calls).toEqual(['child-approval-call']);
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  30000,
);

nativeIt(
  'retains a relayed handler cleanup failure while closing its child',
  async () => {
    await using f = await fixture();
    const entered = Promise.withResolvers<unknown>();
    const cleanup = new Error('Relayed child handler cleanup failed');
    const session = await f.parent.session({
      async onInteraction(request, signal) {
        entered.resolve(request);
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
        throw cleanup;
      },
    });
    const root = await session.submit('begin joint witness');
    const completion = root.wait().catch((error: unknown) => error);
    const request = await entered.promise;
    await f.sibling.promise;
    await expect(session.close()).rejects.toMatchObject({ errors: [cleanup] });
    expect(await completion).toBeInstanceOf(Error);
    if (!isFunctionApprovalRequest(request))
      throw new Error('Expected the child approval');
    expect(() => request.approve()).toThrow();
    expect(f.effects).toEqual(['accepted-sibling']);
  },
  30000,
);

nativeIt.each(['selected', 'excluded', 'narrowed'] as const)(
  'restores configured child executor effects within the current parent ceiling (%s)',
  async (mode) => {
    const executor = await startPublicExecutor();
    try {
      const selected = mode === 'selected';
      await using f = await fixture(false, undefined, undefined, [
        (request) => {
          expect(JSON.stringify(request.tools).includes('"exec_command"')).toBe(
            selected,
          );
          return selected
            ? [
                call(
                  'exec_command',
                  {
                    cmd: 'printf configured-child-executor-effect',
                    yield_time_ms: 1000,
                    max_output_tokens: 100,
                  },
                  { callId: 'restored-child-exec', namespace: 'functions' },
                ),
              ]
            : [message('child complete')];
        },
        ...(selected ? [[message('child complete')]] : []),
      ]);
      const opening = {
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        writePolicy: 'legacy' as const,
      };
      const environment = new Environment({
        ...opening,
        tools: ['exec_command'],
      });
      let saved: Awaited<ReturnType<Session['suspend']>>;
      {
        await using source = await f.parent.session({ environment });
        const turn = await source.submit(
          'Capture the child with its issuing executor selection.',
          mode === 'excluded'
            ? { tools: [toolRef('nested_child'), toolRef('accepted_sibling')] }
            : {},
        );
        const pending = await turn.wait({ until: 'interaction' });
        if (!('requests' in pending))
          throw new Error('Expected child approval');
        await f.sibling.promise;
        expect(
          JSON.stringify(f.childModel.requests[0].tools).includes(
            '"exec_command"',
          ),
        ).toBe(mode !== 'excluded');
        saved = await source.suspend();
      }
      {
        await using restored = await f.parent.session({
          environment:
            mode === 'narrowed'
              ? new Environment({ ...opening, tools: [] })
              : environment,
          state: JSON.parse(JSON.stringify(saved)),
          ...(selected
            ? {
                verifyConfiguredChildExecutorTools: (checkpoint) =>
                  JSON.stringify(checkpoint) === JSON.stringify(saved),
              }
            : {}),
        });
        const restoredTurn = restored.restoredTurn;
        if (!restoredTurn) throw new Error('Expected restored parent turn');
        const pending = await restoredTurn.wait({ until: 'interaction' });
        if (!('requests' in pending))
          throw new Error('Expected restored child approval');
        const request = pending.requests.find(isFunctionApprovalRequest);
        if (!request) throw new Error('Expected restored child approval');
        await restored.respond(request.approve());
        expect((await restoredTurn.wait()).finalOutput).toBe('parent complete');
        expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
      }
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(selected ? 1 : 0);
      if (selected)
        expect(JSON.stringify(f.childModel.requests.at(-1)?.input)).toContain(
          'configured-child-executor-effect',
        );
      f.rootModel.assertExhausted();
      f.childModel.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'collects simultaneous parent and configured child approvals (graceful=%s)',
  async (graceful) => {
    await using f = await fixture(true);
    await using session = await f.parent.session();
    const root = await session.submit('begin joint witness');
    await vi.waitFor(async () => {
      const pending = await session.pendingInteractions();
      expect(
        pending
          .filter(isFunctionApprovalRequest)
          .map((request) => request.callId)
          .sort(),
      ).toEqual(['child-approval-call', 'held-sibling-call']);
    });
    const completion = root.wait().catch((error: unknown) => error);
    const stopping = graceful ? root.cancel({ mode: 'graceful' }) : undefined;
    void stopping?.catch(() => {});
    const boundary = await root.wait({ until: 'interaction' });
    if (!('requests' in boundary))
      throw new Error('Expected both current approvals');
    const requests = boundary.requests.filter(isFunctionApprovalRequest);
    expect(requests.map((request) => request.callId).sort()).toEqual([
      'child-approval-call',
      'held-sibling-call',
    ]);
    const sibling = requests.find(
      (request) => request.callId === 'held-sibling-call',
    )!;
    const child = requests.find(
      (request) => request.callId === 'child-approval-call',
    )!;
    expect(sibling.sessionId).toBe(session.id);
    expect(child.sessionId).not.toBe(session.id);
    expect(f.effects).toEqual([]);
    // The graceful fence has been retaining replies and refusing fresh parent body entry.
    await session.respond(
      graceful
        ? sibling.reject('stopping before parent body entry')
        : sibling.approve(),
    );
    if (!graceful) await f.sibling.promise;
    expect(f.effects).toEqual(graceful ? [] : ['accepted-sibling']);
    const held = await root.wait({ until: 'interaction' });
    if (!('requests' in held))
      throw new Error('Expected the held child approval');
    expect(
      held.requests
        .filter(isFunctionApprovalRequest)
        .map((request) => request.callId),
    ).toEqual(['child-approval-call']);
    await session.respond(child.approve());
    if (graceful) {
      await stopping;
      expect(await completion).toBeInstanceOf(Error);
      expect(f.rootModel.requests).toHaveLength(1);
    } else {
      expect((await root.wait()).finalOutput).toBe('parent complete');
      const outputs = (
        f.rootModel.requests[1].input as Record<string, unknown>[]
      ).filter((item) => item.type === 'function_call_output');
      expect(outputs.map((item) => item.call_id)).toEqual([
        'nested-parent-call',
        'held-sibling-call',
      ]);
      f.rootModel.assertExhausted();
    }
    expect(f.effects).toEqual(
      graceful ? ['child-effect'] : ['accepted-sibling', 'child-effect'],
    );
    f.childModel.assertExhausted();
  },
  30000,
);

nativeIt(
  'rejects an inaccessible configured child approval from parent.run',
  async () => {
    await using f = await fixture();
    const controller = new AbortController();
    const completed = f.parent
      .run('begin one-shot witness', { signal: controller.signal })
      .then(
        (result) => ({ kind: 'completed', value: result }),
        (error: unknown) => ({ kind: 'rejected', error }),
      );
    let observed: unknown;
    try {
      await f.approvalEntered.promise;
      await f.sibling.promise;
      observed = await Promise.race([
        completed,
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ kind: 'still-pending-at-inaccessible-approval' }),
            1500,
          ),
        ),
      ]);
    } finally {
      controller.abort(new Error('bounded one-shot witness cleanup'));
      await completed;
    }
    expect(f.effects).toEqual(['accepted-sibling']);
    expect(f.childModel.requests).toHaveLength(1);
    expect(observed).toEqual({
      kind: 'rejected',
      error: expect.any(InteractionRequired),
    });
  },
  15_000,
);

nativeIt(
  'answers a configured child approval through parent.run with a handler',
  async () => {
    await using f = await fixture();
    const result = await f.parent.run('begin one-shot witness', {
      onInteraction(request) {
        if (!isFunctionApprovalRequest(request))
          throw new Error('Expected child approval');
        return request.approve();
      },
    });
    expect(result.finalOutput).toBe('parent complete');
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  15000,
);

nativeIt.each(['poll', 'respond'] as const)(
  'ignores a retired child snapshot during parent %s',
  async (operation) => {
    let childSession: Session | undefined;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const snapshotScope = new AsyncLocalStorage<boolean>();
    let originalSnapshot: Session['pendingInteractions'];
    await using f = await fixture(operation === 'respond', (child) => {
      childSession = child;
      originalSnapshot = child.pendingInteractions.bind(child);
      child.pendingInteractions = async () => {
        if (hold && snapshotScope.getStore()) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return originalSnapshot();
      };
    });
    await using session = await f.parent.session();
    const root = await session.submit('begin retirement witness');
    const requests = await vi.waitFor(async () => {
      const pending = (await session.pendingInteractions()).filter(
        isFunctionApprovalRequest,
      );
      expect(pending).toHaveLength(operation === 'respond' ? 2 : 1);
      return pending;
    });
    const child = requests.find(
      (request) => request.callId === 'child-approval-call',
    )!;
    const sibling = requests.find(
      (request) => request.callId === 'held-sibling-call',
    );
    hold = true;
    const pending = snapshotScope.run(true, () =>
      operation === 'poll'
        ? session.pendingInteractions()
        : session.respond(sibling!.approve()),
    );
    // The snapshot has been crossing the real child's retirement boundary.
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      await childSession!.respond(child.approve());
      await vi.waitFor(async () => {
        await expect(originalSnapshot()).rejects.toThrow('Session is closed');
      });
    } finally {
      release.resolve();
    }
    const result = await settled;
    expect(result).toEqual(
      operation === 'poll' ? { value: [] } : { value: undefined },
    );
    expect((await root.wait()).finalOutput).toBe('parent complete');
    expect(await session.pendingInteractions()).toEqual([]);
    expect(f.effects).toEqual(
      operation === 'poll'
        ? ['accepted-sibling', 'child-effect']
        : ['child-effect', 'accepted-sibling'],
    );
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  15000,
);

nativeIt(
  'preserves a snapshot failure from an active configured child',
  async () => {
    let fail = false;
    const snapshotScope = new AsyncLocalStorage<boolean>();
    const failure = new Error('Active child snapshot failed');
    await using f = await fixture(false, (child) => {
      const snapshot = child.pendingInteractions.bind(child);
      child.pendingInteractions = async () => {
        if (fail && snapshotScope.getStore()) {
          fail = false;
          throw failure;
        }
        return snapshot();
      };
    });
    await using session = await f.parent.session();
    const root = await session.submit('begin active child witness');
    const request = await approval(session);
    fail = true;
    await expect(
      snapshotScope.run(true, () => session.pendingInteractions()),
    ).rejects.toBe(failure);
    await session.respond(request.approve());
    expect((await root.wait()).finalOutput).toBe('parent complete');
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  15000,
);

nativeIt.each(['close', 'cancel'] as const)(
  'cancels configured child opening on parent %s',
  async (operation) => {
    const started = Promise.withResolvers<void>();
    const credential = Promise.withResolvers<never>();
    const server = new ModelServer([
      [call('opening_child', { input: 'begin' }, { callId: 'opening-call' })],
    ]);
    await using rootProvider = await provider(server);
    await using childProvider = new NativeProvider({
      signInWithChatGPT: {
        getCredential() {
          started.resolve();
          return credential.promise;
        },
      },
    });
    const child = new Agent({
      instructions: 'Retain the current credential owner.',
      model,
      provider: childProvider,
    });
    const parent = new Agent({
      instructions: 'Call the configured child.',
      model,
      provider: rootProvider,
      tools: [child.asTool({ toolName: 'opening_child' })],
    });
    await using session = await parent.session();
    const root = await session.submit('begin opening witness');
    const completion = root.wait().catch((error: unknown) => error);
    await started.promise;
    const stopping = operation === 'close' ? session.close() : root.cancel();
    const settled = stopping.then(
      () => ({ kind: 'settled' }),
      (error: unknown) => ({ kind: 'rejected', error }),
    );
    let observed;
    try {
      observed = await Promise.race([
        settled,
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: 'still-opening' }), 1500),
        ),
      ]);
    } finally {
      credential.reject(new Error('bounded opening witness cleanup'));
      await settled;
      await completion;
    }
    expect(observed).toEqual({ kind: 'settled' });
    expect(await completion).toBeInstanceOf(Error);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
  15000,
);

nativeIt(
  'routes an inaccessible configured child approval from a native role to the one-shot root',
  async () => {
    if (!descendantModel)
      throw new Error('Expected a catalog model with V2 collaboration');
    const entered = Promise.withResolvers<void>();
    let effects = 0;
    const rootModel = new ModelServer([
      [
        call(
          'managed_parent',
          { input: 'Run the configured child.' },
          { namespace: 'collaboration', callId: 'managed-parent' },
        ),
      ],
      [
        call(
          'nested_child',
          { input: 'Request the child effect.' },
          { callId: 'role-configured-child' },
        ),
      ],
    ]);
    const childModel = new ModelServer([
      [call('child_effect', {}, { callId: 'role-child-approval' })],
    ]);
    const executor = await startPublicExecutor();
    try {
      await using rootProvider = await provider(rootModel);
      await using childProvider = await provider(childModel);
      const child = new Agent({
        instructions: 'Request the child effect.',
        model,
        provider: childProvider,
        tools: [
          tool({
            name: 'child_effect',
            parameters: z.object({}),
            needsApproval() {
              entered.resolve();
              return true;
            },
            execute() {
              effects++;
              return 'child effect';
            },
          }),
        ],
      });
      const parent = new Agent({
        instructions: 'Delegate to the managed role.',
        model: descendantModel,
        provider: rootProvider,
        tools: [
          new NativeAgents({
            additionalRoles: [
              new NativeRole({
                name: 'delegated',
                description: 'Delegate configured work.',
                instructions: 'Call nested_child.',
              }),
            ],
            managedTools: [
              {
                name: 'managed_parent',
                role: 'delegated',
                description:
                  'Run the configured child through the native role.',
              },
            ],
          }),
          child.asTool({ toolName: 'nested_child' }),
        ],
      });
      const controller = new AbortController();
      const completed = parent
        .run('begin managed one-shot witness', {
          signal: controller.signal,
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          }),
        })
        .then(
          (value) => ({ kind: 'completed', value }),
          (error: unknown) => ({ kind: 'rejected', error }),
        );
      let observed;
      try {
        const admission = await Promise.race([
          entered.promise.then(() => ({ kind: 'entered' })),
          completed,
          new Promise((resolve) =>
            setTimeout(() => resolve({ kind: 'no-admission' }), 2000),
          ),
        ]);
        expect(admission).toEqual({ kind: 'entered' });
        observed = await Promise.race([
          completed,
          new Promise((resolve) =>
            setTimeout(() => resolve({ kind: 'still-pending' }), 1500),
          ),
        ]);
      } finally {
        controller.abort(new Error('bounded managed one-shot cleanup'));
        await completed;
      }
      expect(observed).toEqual({
        kind: 'rejected',
        error: expect.any(InteractionRequired),
      });
      expect(effects).toBe(0);
      rootModel.assertExhausted();
      childModel.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  20000,
);

nativeIt.each([false, true])(
  'restores the portable configured parent without repeating its settled sibling, legacy=%s',
  async (legacyUsage) => {
    let childCompleted: Completed | undefined;
    let priorParent: readonly import('../../src/runtime/guardrails').GuardrailRecord[] =
      [];
    await using f = await fixture(false, undefined, (result) => {
      childCompleted = result;
    });
    const source = await f.parent.session();
    let saved: Awaited<ReturnType<Session['suspend']>>;
    try {
      const turn = await source.submit('begin portable parent');
      const pending = await turn.wait({ until: 'interaction' });
      if (!('requests' in pending)) throw new Error('Expected child approval');
      await f.sibling.promise;
      expect(f.effects).toEqual(['accepted-sibling']);
      priorParent = turn.guardrailResults;
      saved = await source.suspend();
    } finally {
      await source.close();
    }
    const frame = z
      .object({
        manual_continuation: z.object({
          pending_manual: z.array(
            z.object({
              name: z.string(),
              continuation: z
                .object({
                  state: z.object({
                    manual_context: z.object({
                      guardrail_results: z.array(
                        z.object({
                          name: z.string(),
                          session_id: z.string(),
                          turn_id: z.string(),
                        }),
                      ),
                    }),
                  }),
                })
                .optional(),
            }),
          ),
        }),
      })
      .parse(saved);
    const childInput = frame.manual_continuation.pending_manual
      .find((call) => call.name === 'nested_child')
      ?.continuation?.state.manual_context.guardrail_results.find(
        (record) => record.name === 'child-input-owner',
      );
    expect(childInput).toBeDefined();
    await expect(
      new Agent({ ...f.parent, tools: [] }).session({ state: saved }),
    ).rejects.toThrow();
    expect(f.effects).toEqual(['accepted-sibling']);
    const portable = JSON.parse(JSON.stringify(saved));
    if (legacyUsage) {
      const continuation = portable.manual_continuation.pending_manual.find(
        (entry: any) => entry.continuation,
      ).continuation;
      const childUsage =
        continuation.state.manual_context.model_usage_offset ??
        continuation.state.manual_context.usage;
      delete continuation.usage_in_parent;
      for (const name of ['usage', 'model_usage_offset']) {
        const usage = portable.manual_context[name];
        if (usage)
          for (const key of Object.keys(usage))
            usage[key] = Number(
              BigInt(usage[key] ?? 0) - BigInt(childUsage[key] ?? 0),
            );
      }
    }
    await using restored = await f.parent.session({ state: portable });
    if (!restored.restoredTurn)
      throw new Error('Expected restored parent turn');
    expect(restored.restoredTurn.runUsage).toMatchObject({
      requests: 2,
      missingUsageRequests: 2,
      totalTokens: 0,
    });
    const pending = await restored.restoredTurn.wait({ until: 'interaction' });
    if (!('requests' in pending))
      throw new Error('Expected restored child approval');
    const request = pending.requests.find(isFunctionApprovalRequest);
    if (!request) throw new Error('Expected restored function approval');
    expect(request.callId).toBe('child-approval-call');
    expect(f.effects).toEqual(['accepted-sibling']);
    const reply = request.approve();
    await restored.respond(reply);
    await expect(restored.respond(reply)).rejects.toThrow();
    const completed = await restored.restoredTurn.wait();
    expect(completed.runUsage).toMatchObject({
      requests: 4,
      missingUsageRequests: 4,
      totalTokens: 0,
    });
    expect(restored.restoredTurn.runUsage).toEqual(completed.runUsage);
    expect(completed.finalOutput).toBe('parent complete');
    expect(completed.guardrailResults?.map((record) => record.name)).toEqual([
      'parent-input-owner',
      'parent-output-owner',
    ]);
    expect(
      childCompleted?.guardrailResults?.map((record) => record.name),
    ).toEqual(['child-input-owner', 'child-output-owner']);
    expect(completed.guardrailResults?.[0]).toMatchObject({
      sessionId: priorParent[0].sessionId,
      turnId: priorParent[0].turnId,
    });
    expect(childCompleted?.guardrailResults?.[0]).toMatchObject({
      sessionId: childInput!.session_id,
      turnId: childInput!.turn_id,
    });
    expect(
      completed.guardrailResults?.every((record) => record.agent === f.parent),
    ).toBe(true);
    expect(
      childCompleted?.guardrailResults?.every(
        (record) => record.agent === f.child,
      ),
    ).toBe(true);
    expect(f.guards.map((record) => record.name).sort()).toEqual([
      'child-input-owner',
      'child-output-owner',
      'parent-input-owner',
      'parent-output-owner',
    ]);
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    expect(f.rootModel.requests).toHaveLength(2);
    expect(f.childModel.requests).toHaveLength(2);
  },
  20_000,
);

nativeIt(
  'rolls back a pre-seal parent refusal without repeating accepted siblings',
  async () => {
    await using f = await fixture(
      false,
      undefined,
      undefined,
      [
        [message('child complete')],
        [call('child_effect', {}, { callId: 'second-child-approval' })],
      ],
      [
        [
          call(
            'nested_child',
            { input: 'second child' },
            { callId: 'second-parent-call' },
          ),
        ],
      ],
    );
    await using source = await f.parent.session();
    const turn = await source.submit('begin configured rollback');
    const original = await turn.wait({ until: 'interaction' });
    if (!('requests' in original))
      throw new Error('Expected original child approval');
    await f.sibling.promise;
    const stale = original.requests.find(isFunctionApprovalRequest);
    if (!stale) throw new Error('Expected original child approval');
    const staleReply = stale.approve();
    const capture = source as unknown as {
      captureConfiguredParent(beforeSeal: () => void): Promise<unknown>;
    };
    await expect(
      capture.captureConfiguredParent(() => {
        throw new Error('injected parent refusal');
      }),
    ).rejects.toThrow('injected parent refusal');
    expect(turn.runUsage).toMatchObject({
      requests: 2,
      missingUsageRequests: 2,
      totalTokens: 0,
    });
    const pending = await turn.wait({ until: 'interaction' });
    if (!('requests' in pending))
      throw new Error('Expected recovered child approval');
    const request = pending.requests.find(isFunctionApprovalRequest);
    if (!request) throw new Error('Expected current and stale child approvals');
    expect(request.callId).toBe(stale.callId);
    await expect(source.respond(staleReply)).rejects.toThrow();
    expect(f.effects).toEqual(['accepted-sibling']);
    const reply = request.approve();
    await source.respond(reply);
    await expect(source.respond(reply)).rejects.toThrow();
    const completed = await turn.wait();
    expect(completed.finalOutput).toBe('parent complete');
    expect(completed.runUsage).toMatchObject({
      requests: 4,
      missingUsageRequests: 4,
      totalTokens: 0,
    });
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    expect(f.rootModel.requests).toHaveLength(2);
    expect(f.childModel.requests).toHaveLength(2);

    const next = await source.submit('begin another configured child');
    const nextPending = await next.wait({ until: 'interaction' });
    if (!('requests' in nextPending))
      throw new Error('Expected the next child approval');
    expect(nextPending.requests.some(isFunctionApprovalRequest)).toBe(true);
    const nextCheckpoint = await source.suspend();
    expect(nextCheckpoint).toHaveProperty('manual_continuation');
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
  },
  20_000,
);

nativeIt(
  'settles a fresh restored configured batch through its current callback',
  async () => {
    await using f = await fixture(true);
    let batches = 0;
    const agent = new Agent({
      ...f.parent,
      toolBatchCompletion(context) {
        batches += 1;
        expect(context.results).toHaveLength(2);
      },
    });
    const source = await agent.session();
    const turn = await source.submit('begin fresh restored batch');
    await vi.waitFor(async () => {
      const boundary = await turn.wait({ until: 'interaction' });
      if (!('requests' in boundary))
        throw new Error('Expected both current approvals');
      expect(
        boundary.requests
          .filter(isFunctionApprovalRequest)
          .map((request) => request.callId)
          .sort(),
      ).toEqual(['child-approval-call', 'held-sibling-call']);
    });
    const state = await source.suspend();
    await source.close();
    expect(batches).toBe(0);
    expect(f.effects).toEqual([]);
    await using restored = await agent.session({ state });
    if (!restored.restoredTurn) throw new Error('Expected restored batch');
    let current: Awaited<ReturnType<typeof approval>>[] = [];
    await vi.waitFor(async () => {
      const boundary = await restored.restoredTurn!.wait({
        until: 'interaction',
      });
      if (!('requests' in boundary))
        throw new Error('Expected current approvals');
      current = boundary.requests.filter(isFunctionApprovalRequest);
      expect(current.map((request) => request.callId).sort()).toEqual([
        'child-approval-call',
        'held-sibling-call',
      ]);
    });
    for (const callId of ['held-sibling-call', 'child-approval-call']) {
      const request = current.find((request) => request.callId === callId)!;
      await restored.respond(request.approve());
    }
    expect((await restored.restoredTurn.wait()).finalOutput).toBe(
      'parent complete',
    );
    expect(batches).toBe(1);
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  20_000,
);

nativeIt(
  'keeps admitted configured child usage after denial',
  async () => {
    await using f = await fixture();
    await using source = await f.parent.session();
    const turn = await source.submit('deny configured leaf');
    const pending = await turn.wait({ until: 'interaction' });
    if (!('requests' in pending)) throw new Error('Expected child approval');
    await f.sibling.promise;
    const request = pending.requests.find(isFunctionApprovalRequest);
    if (!request) throw new Error('Expected function approval');
    await source.respond(request.reject());
    const completed = await turn.wait();
    expect(completed.finalOutput).toBe('parent complete');
    expect(completed.runUsage).toMatchObject({
      requests: 4,
      missingUsageRequests: 4,
      totalTokens: 0,
    });
    expect(f.effects).toEqual(['accepted-sibling']);
    expect(f.rootModel.requests).toHaveLength(2);
    expect(f.childModel.requests).toHaveLength(2);
  },
  20_000,
);

nativeIt(
  'reseals the current restored child approval without replaying its first effect',
  async () => {
    await using f = await fixture(false, undefined, undefined, [
      [call('child_effect', {}, { callId: 'child-second-approval' })],
      [message('child complete')],
    ]);
    let saved: Awaited<ReturnType<Session['suspend']>>;
    {
      await using source = await f.parent.session();
      const turn = await source.submit('begin twice-restored configured child');
      await turn.wait({ until: 'interaction' });
      await f.sibling.promise;
      saved = await source.suspend();
    }
    {
      await using restored = await f.parent.session({ state: saved });
      const first = await approval(restored);
      expect(first.callId).toBe('child-approval-call');
      await restored.respond(first.approve());
      const second = await approval(restored);
      expect(second.callId).toBe('child-second-approval');
      saved = await restored.suspend();
    }
    expect(f.effects).toEqual(['accepted-sibling', 'child-effect']);
    {
      await using restored = await f.parent.session({
        state: JSON.parse(JSON.stringify(saved)),
      });
      const current = await approval(restored);
      expect(current.callId).toBe('child-second-approval');
      await restored.respond(current.approve());
      if (!restored.restoredTurn) throw new Error('Expected restored parent');
      expect((await restored.restoredTurn.wait()).finalOutput).toBe(
        'parent complete',
      );
    }
    expect(f.effects).toEqual([
      'accepted-sibling',
      'child-effect',
      'child-effect',
    ]);
    f.rootModel.assertExhausted();
    f.childModel.assertExhausted();
  },
  30000,
);

nativeIt(
  'refuses a configured continuation excluded by the saved operation selection',
  async () => {
    await using f = await fixture();
    let saved: Awaited<ReturnType<Session['suspend']>>;
    {
      await using source = await f.parent.session();
      const turn = await source.submit('begin excluded configured slot', {
        tools: [toolRef('nested_child'), toolRef('accepted_sibling')],
      });
      await turn.wait({ until: 'interaction' });
      await f.sibling.promise;
      saved = await source.suspend();
    }
    const portable = JSON.parse(JSON.stringify(saved));
    expect(portable.format_version).toBeGreaterThanOrEqual(8);
    expect(portable.format_version).toBeLessThanOrEqual(20);
    expect(portable.operation_tools).toEqual([
      { name: 'nested_child', namespace: 'functions' },
      { name: 'accepted_sibling', namespace: 'functions' },
    ]);
    portable.operation_tools = [
      { name: 'accepted_sibling', namespace: 'functions' },
    ];
    let opened: Session | undefined;
    try {
      await expect(
        (async () => {
          opened = await f.parent.session({ state: portable });
        })(),
      ).rejects.toThrow(
        /Checkpoint selection does not admit its pending manual tools/,
      );
    } finally {
      await opened?.close();
    }
    expect(f.effects).toEqual(['accepted-sibling']);
    expect(f.childModel.requests).toHaveLength(1);
    expect(f.rootModel.requests).toHaveLength(1);
  },
  30000,
);

nativeIt.each(['inject', 'omit', 'reject'] as const)(
  'requires current checkpoint authentication before restored executor admission (%s)',
  async (change) => {
    const executor = await startPublicExecutor();
    try {
      await using f = await fixture();
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        writePolicy: 'legacy',
      });
      let saved: Awaited<ReturnType<Session['suspend']>>;
      {
        await using source = await f.parent.session({ environment });
        const turn = await source.submit(
          'capture excluded executor authority',
          {
            tools: [toolRef('nested_child'), toolRef('accepted_sibling')],
          },
        );
        const pending = await turn.wait({ until: 'interaction' });
        if (!('requests' in pending))
          throw new Error('Expected child approval');
        await f.sibling.promise;
        expect(JSON.stringify(f.childModel.requests[0].tools)).not.toContain(
          '"exec_command"',
        );
        saved = await source.suspend();
      }
      const portable = JSON.parse(JSON.stringify(saved));
      expect(portable.operation_tools).toEqual([
        { name: 'nested_child', namespace: 'functions' },
        { name: 'accepted_sibling', namespace: 'functions' },
      ]);
      if (change === 'omit') {
        if (portable.format_version === 9) portable.format_version = 5;
        else if (portable.format_version === 11) portable.format_version = 7;
        else throw new Error('Expected a selected portable checkpoint format');
        delete portable.operation_tools;
        delete portable.default_tools;
        delete portable.default_resource_servers;
      } else {
        portable.operation_tools.push({
          name: 'exec_command',
          namespace: 'functions',
        });
      }
      let opened: Session | undefined;
      try {
        await expect(
          (async () => {
            opened = await f.parent.session({
              environment,
              state: portable,
              ...(change === 'reject'
                ? {
                    verifyConfiguredChildExecutorTools: (checkpoint) =>
                      JSON.stringify(checkpoint) === JSON.stringify(saved),
                  }
                : {}),
            });
          })(),
        ).rejects.toThrow(/verifyConfiguredChildExecutorTools/);
      } finally {
        await opened?.close();
      }
      expect(f.effects).toEqual(['accepted-sibling']);
      expect(f.childModel.requests).toHaveLength(1);
      expect(f.rootModel.requests).toHaveLength(1);
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
    } finally {
      await executor.close();
    }
  },
  30000,
);

nativeIt.each(['untouched', 'inject'] as const)(
  'checks executor authority for a later configured callback in the restored operation (%s)',
  async (change) => {
    const executor = await startPublicExecutor();
    try {
      await using f = await fixture(true, undefined, undefined, undefined, [], {
        root: [
          [call('accepted_sibling', {}, { callId: 'first-parent-approval' })],
          [
            call(
              'nested_child',
              { input: 'later child' },
              { callId: 'later-child' },
            ),
          ],
          [message('parent complete')],
          [
            call(
              'nested_child',
              { input: 'fresh child' },
              { callId: 'fresh-child' },
            ),
          ],
          [message('parent complete')],
        ],
        child: [
          [call('child_effect', {}, { callId: 'later-child-approval' })],
          [message('child complete')],
          [call('child_effect', {}, { callId: 'fresh-child-approval' })],
          [message('child complete')],
        ],
      });
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        writePolicy: 'legacy',
      });
      let saved: Awaited<ReturnType<Session['suspend']>>;
      {
        await using source = await f.parent.session({ environment });
        const turn = await source.submit('pause before the configured child', {
          tools: [toolRef('nested_child'), toolRef('accepted_sibling')],
        });
        const pending = await turn.wait({ until: 'interaction' });
        if (!('requests' in pending))
          throw new Error('Expected parent approval');
        expect(
          pending.requests
            .filter(isFunctionApprovalRequest)
            .map((request) => request.callId),
        ).toEqual(['first-parent-approval']);
        saved = await source.suspend();
      }
      const portable = JSON.parse(JSON.stringify(saved));
      if (change === 'inject')
        portable.operation_tools.push({
          name: 'exec_command',
          namespace: 'functions',
        });
      let restored: Session | undefined;
      try {
        if (change === 'inject') {
          restored = await f.parent.session({ environment, state: portable });
          const completion = restored.restoredTurn?.wait();
          if (!completion) throw new Error('Expected restored operation');
          void completion.catch(() => {});
          await restored.respond((await approval(restored)).approve());
          await expect(completion).rejects.toThrow(
            /verifyConfiguredChildExecutorTools/,
          );
          expect(f.effects).toEqual(['accepted-sibling']);
          expect(f.rootModel.requests).toHaveLength(2);
          expect(f.childModel.requests).toHaveLength(0);
        } else {
          restored = await f.parent.session({ environment, state: portable });
          await restored.respond((await approval(restored)).approve());
          const child = await approval(restored);
          expect(child.callId).toBe('later-child-approval');
          expect(JSON.stringify(f.childModel.requests[0].tools)).not.toContain(
            '"exec_command"',
          );
          await restored.respond(child.approve());
          if (!restored.restoredTurn)
            throw new Error('Expected restored operation');
          expect((await restored.restoredTurn.wait()).finalOutput).toBe(
            'parent complete',
          );
          const fresh = await restored.submit(
            'begin an explicitly new operation',
          );
          const pending = await fresh.wait({ until: 'interaction' });
          if (!('requests' in pending))
            throw new Error('Expected fresh child approval');
          expect(JSON.stringify(f.childModel.requests[2].tools)).toContain(
            '"exec_command"',
          );
          await restored.respond((await approval(restored)).approve());
          expect((await fresh.wait()).finalOutput).toBe('parent complete');
          expect(f.effects).toEqual([
            'accepted-sibling',
            'child-effect',
            'child-effect',
          ]);
          f.rootModel.assertExhausted();
          f.childModel.assertExhausted();
        }
      } finally {
        await restored?.close();
      }
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
    } finally {
      await executor.close();
    }
  },
  30000,
);

nativeIt(
  'carries exact authenticated checkpoint authority through nested configured restores',
  async () => {
    const executor = await startPublicExecutor();
    try {
      await using f = await fixture(
        false,
        undefined,
        undefined,
        undefined,
        [],
        {
          child: [
            [
              call(
                'grandchild',
                { input: 'nested restore' },
                { callId: 'grandchild-call' },
              ),
            ],
            [message('child complete')],
          ],
        },
      );
      const leafModel = new ModelServer([
        [call('leaf_effect', {}, { callId: 'leaf-approval' })],
        [
          call(
            'exec_command',
            {
              cmd: 'printf nested-restored-executor',
              yield_time_ms: 1000,
              max_output_tokens: 100,
            },
            { callId: 'nested-exec', namespace: 'functions' },
          ),
        ],
        [message('leaf complete')],
      ]);
      await using leafProvider = await provider(leafModel);
      const leaf = new Agent({
        model,
        instructions: 'Request the leaf effect.',
        provider: leafProvider,
        tools: [
          tool({
            name: 'leaf_effect',
            parameters: z.object({}),
            needsApproval: true,
            execute() {
              f.effects.push('leaf-effect');
              return 'leaf effect output';
            },
          }),
        ],
      });
      const child = new Agent({
        ...f.child,
        tools: [leaf.asTool({ toolName: 'grandchild' })],
      });
      const sibling = f.parent.tools.find(
        (tool) => 'name' in tool && tool.name === 'accepted_sibling',
      );
      if (!sibling) throw new Error('Expected current sibling declaration');
      const parent = new Agent({
        ...f.parent,
        tools: [child.asTool({ toolName: 'nested_child' }), sibling],
      });
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        writePolicy: 'legacy',
      });
      let saved: Awaited<ReturnType<Session['suspend']>>;
      {
        await using source = await parent.session({ environment });
        const turn = await source.submit(
          'capture the nested configured approval',
        );
        const pending = await turn.wait({ until: 'interaction' });
        if (!('requests' in pending)) throw new Error('Expected leaf approval');
        await f.sibling.promise;
        saved = await source.suspend();
      }
      {
        await using restored = await parent.session({
          environment,
          state: JSON.parse(JSON.stringify(saved)),
          verifyConfiguredChildExecutorTools: (checkpoint) =>
            JSON.stringify(checkpoint) === JSON.stringify(saved),
        });
        const current = await approval(restored);
        expect(current.callId).toBe('leaf-approval');
        await restored.respond(current.approve());
        if (!restored.restoredTurn) throw new Error('Expected restored parent');
        expect((await restored.restoredTurn.wait()).finalOutput).toBe(
          'parent complete',
        );
      }
      expect(f.effects).toEqual(['accepted-sibling', 'leaf-effect']);
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(leafModel.requests.at(-1)?.input)).toContain(
        'nested-restored-executor',
      );
      f.rootModel.assertExhausted();
      f.childModel.assertExhausted();
      leafModel.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30000,
);

nativeIt.each(['denied', 'verifier-throws'] as const)(
  'releases an unsuccessful authenticated executor restore (%s)',
  async (failure) => {
    const executor = await startPublicExecutor();
    try {
      await using f = await fixture();
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        writePolicy: 'legacy',
      });
      let saved: Awaited<ReturnType<Session['suspend']>>;
      {
        await using source = await f.parent.session({ environment });
        const turn = await source.submit('capture a denied opening', {
          tools: [toolRef('nested_child'), toolRef('accepted_sibling')],
        });
        await turn.wait({ until: 'interaction' });
        await f.sibling.promise;
        saved = await source.suspend();
      }
      const portable = JSON.parse(JSON.stringify(saved));
      portable.operation_tools.push({
        name: 'exec_command',
        namespace: 'functions',
      });
      const marker = new Error(
        'checkpoint verifier refused before native opening',
      );
      const opening = f.parent.session({
        environment,
        state: portable,
        ...(failure === 'verifier-throws'
          ? {
              verifyConfiguredChildExecutorTools() {
                throw marker;
              },
            }
          : {}),
      });
      if (failure === 'verifier-throws')
        await expect(opening).rejects.toBe(marker);
      else
        await expect(opening).rejects.toThrow(
          /verifyConfiguredChildExecutorTools/,
        );
      await expect(f.rootProvider.close()).resolves.toBeUndefined();
      await expect(f.childProvider.close()).resolves.toBeUndefined();
      expect(f.effects).toEqual(['accepted-sibling']);
      expect(f.rootModel.requests).toHaveLength(1);
      expect(f.childModel.requests).toHaveLength(1);
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
    } finally {
      await executor.close();
    }
  },
  30000,
);
