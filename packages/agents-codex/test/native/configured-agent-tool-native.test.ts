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
  type Session,
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
) {
  const rootModel = new ModelServer([
    [
      call(
        'nested_child',
        { input: 'request child approval' },
        { callId: 'nested-parent-call' },
      ),
      call('accepted_sibling', {}, { callId: 'held-sibling-call' }),
    ],
    [message('parent complete')],
  ]);
  const childModel = new ModelServer([
    [call('child_effect', {}, { callId: 'child-approval-call' })],
    [message('child complete')],
  ]);
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
    await expect(session.suspend()).rejects.toThrow(
      'suspend requires a pending manual-tool boundary',
    );
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
