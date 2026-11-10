import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type BoundDecide,
  type DecisionProvider,
  type FunctionApprovalRequest,
  type Session,
  type ToolContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-managed-approval-decisions',
    supportsWebsockets: false,
  });
}

async function nextApproval(
  session: Session,
): Promise<FunctionApprovalRequest> {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw new Error('The native turn ended before its approval arrived');
}

nativeIt.each([
  { policy: 'predicate', restored: false },
  { policy: 'predicate', restored: true },
  { policy: 'before', restored: false },
  { policy: 'before', restored: true },
] as const)(
  'binds live decisions for managed $policy policy and approved execution (restored=$restored)',
  async ({ policy, restored }) => {
    const appContext = { marker: 'application context' };
    const effects: string[] = [];
    const policyContexts: ToolContext[] = [];
    let retainedPolicy: BoundDecide | undefined;
    let retainedExecution: BoundDecide | undefined;
    let issuingThread = '';
    let issuingTurn = '';
    const decisions: DecisionProvider = {
      getDecision: vi.fn(async (request, options) => {
        expect(request.input).toBe('explicit input');
        expect(options.signal?.aborted).toBe(false);
        return { value: true };
      }),
    };
    const checkPolicy = async (context: ToolContext) => {
      expect(context.context).toBe(appContext);
      expect(context.originalArguments).toEqual({ value: 'explicit input' });
      expect(context.effectiveArguments).toEqual({ value: 'explicit input' });
      expect(context.threadId).toBe(issuingThread);
      expect(context.callId).toBe('managed-decision');
      expect(context.call?.callId).toBe('managed-decision');
      expect(context.signal.aborted).toBe(false);
      issuingTurn = context.turnId;
      retainedPolicy = context.decide;
      policyContexts.push(context);
      return context.decide('Allow this policy?', { input: 'explicit input' });
    };
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: policy === 'predicate' ? checkPolicy : true,
      runBeforeApproval: policy === 'before',
      before:
        policy === 'before'
          ? async (context) => {
              expect(await checkPolicy(context)).toBe(true);
              return { action: 'allow' as const };
            }
          : undefined,
      async execute({ value }, context) {
        expect(context.context).toBe(appContext);
        expect(context.threadId).toBe(issuingThread);
        expect(context.turnId).toBe(issuingTurn);
        expect(context.callId).toBe('managed-decision');
        retainedExecution = context.decide;
        expect(await context.decide('Execute?', { input: value })).toBe(true);
        effects.push(value);
        return 'approved result';
      },
    });
    const server = new ModelServer([
      [
        call(
          'risky',
          { value: 'explicit input' },
          { callId: 'managed-decision' },
        ),
      ],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use risky once.',
      model: 'gpt-5.5',
      provider,
      decisions,
      tools: [risky],
    });
    let state: Awaited<ReturnType<Session['suspend']>> | undefined;
    if (restored) {
      await using source = await agent.session({ context: appContext });
      issuingThread = source.id;
      const turn = await source.submit('begin');
      const request = await nextApproval(source);
      expect(request.turnId).toBe(turn.turnId);
      expect(issuingTurn).toBe(turn.turnId);
      expect(effects).toEqual([]);
      expect(decisions.getDecision).toHaveBeenCalledTimes(1);
      state = await source.suspend();
    }
    await using session = await agent.session({ context: appContext, state });
    issuingThread = session.id;
    const turn = restored
      ? session.restoredTurn!
      : await session.submit('begin');
    const request = await nextApproval(session);
    expect(request.turnId).toBe(turn.turnId);
    expect(issuingTurn).toBe(turn.turnId);
    expect(policyContexts).toHaveLength(1);
    expect(effects).toEqual([]);
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
    await expect(
      retainedPolicy!('Expired policy?', { input: 'explicit input' }),
    ).rejects.toThrow(/no longer|abort/i);
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    const completion = turn.wait();
    await session.respond(request.approve());
    expect((await completion).finalOutput).toBe('done');
    expect(effects).toEqual(['explicit input']);
    expect(decisions.getDecision).toHaveBeenCalledTimes(2);
    await expect(
      retainedExecution!('Expired callback?', { input: 'explicit input' }),
    ).rejects.toThrow(/no longer|abort/i);
    expect(decisions.getDecision).toHaveBeenCalledTimes(2);
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  },
  30_000,
);
