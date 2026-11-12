import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const model =
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
      ).models.find(
        (entry: { supported_in_api?: boolean; use_responses_lite?: boolean }) =>
          entry.supported_in_api && !entry.use_responses_lite,
      )?.slug
    : undefined;
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

async function fixture(siblingApproval = false) {
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
  const child = new Agent({
    name: 'Nested guarded child',
    instructions: 'Request the child effect.',
    model,
    provider: childProvider,
    tools: [
      tool({
        name: 'child_effect',
        parameters: z.object({}),
        needsApproval: true,
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
