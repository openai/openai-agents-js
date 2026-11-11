import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type FunctionApprovalRequest,
  type Interaction,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${phase}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

nativeIt.each(['inputErrorFunction', 'needsApproval'] as const)(
  'exposes an issued sibling approval while %s is pending',
  async (hook) => {
    const lookupEntered = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();
    const reviewEntered = Promise.withResolvers<void>();
    const issueReview = Promise.withResolvers<void>();
    const issued = Promise.withResolvers<FunctionApprovalRequest>();
    const approveReview = Promise.withResolvers<void>();
    const executeLookup = vi.fn(() => 'lookup executed');
    const executeReview = vi.fn(() => 'review executed');
    const holdLookup = async () => {
      lookupEntered.resolve();
      await releaseLookup.promise;
    };
    const server = new ModelServer([
      [
        call('review', {}, { callId: 'review-sibling' }),
        call(
          'lookup',
          { key: hook === 'needsApproval' ? 'valid' : 7 },
          {
            callId: 'lookup-held',
          },
        ),
      ],
      [message('completed')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-pending-interactions-siblings',
      supportsWebsockets: false,
    });
    const onInteraction = vi.fn(async (request: Interaction) => {
      if (!isFunctionApprovalRequest(request))
        throw new Error('Expected approval');
      expect(request.callId).toBe('review-sibling');
      issued.resolve(request);
      await approveReview.promise;
      return request.approve();
    });
    await using session = await new Agent({
      instructions: 'Use both functions.',
      model: 'gpt-5',
      modelSettings: { parallelToolCalls: true },
      provider,
      tools: [
        tool({
          name: 'review',
          parameters: z.object({}),
          async needsApproval() {
            reviewEntered.resolve();
            await issueReview.promise;
            return true;
          },
          execute: executeReview,
        }),
        tool({
          name: 'lookup',
          parameters: z.object({ key: z.string() }),
          needsApproval:
            hook === 'needsApproval'
              ? async () => {
                  await holdLookup();
                  return false;
                }
              : true,
          inputErrorFunction:
            hook === 'inputErrorFunction'
              ? async () => {
                  await holdLookup();
                  return 'lookup recovered';
                }
              : undefined,
          execute: executeLookup,
        }),
      ],
    }).session({ onInteraction });
    const reader = session.interactions();
    try {
      const turn = await session.submit('start');
      await bounded(
        Promise.all([reviewEntered.promise, lookupEntered.promise]),
        'both hooks entering',
      );
      const next = reader.next();
      void next.catch(() => {});
      expect(
        await bounded(session.pendingInteractions(), 'empty snapshot'),
      ).toEqual([]);
      expect(onInteraction).not.toHaveBeenCalled();

      issueReview.resolve();
      const approval = await bounded(
        issued.promise,
        'sibling approval issuing',
      );
      const [first, second, observed] = await bounded(
        Promise.all([
          session.pendingInteractions(),
          session.pendingInteractions(),
          next,
        ]),
        'readers seeing the issued approval',
      );
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]).toBe(approval);
      expect(second[0]).toBe(approval);
      expect(observed.done).toBe(false);
      expect(observed.value).toBe(approval);
      expect(approval.turnId).toBe(turn.turnId);
      expect(onInteraction).toHaveBeenCalledTimes(1);
      expect(executeReview).not.toHaveBeenCalled();
      expect(executeLookup).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(1);

      approveReview.resolve();
      releaseLookup.resolve();
      expect((await bounded(turn.wait(), 'turn completion')).finalOutput).toBe(
        'completed',
      );
      expect(executeReview).toHaveBeenCalledTimes(1);
      expect(executeLookup).toHaveBeenCalledTimes(
        hook === 'needsApproval' ? 1 : 0,
      );
      expect(onInteraction).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
      const continuation = JSON.stringify(server.requests[1]?.input);
      expect(continuation).toContain('review executed');
      expect(continuation).toContain(
        hook === 'needsApproval' ? 'lookup executed' : 'lookup recovered',
      );
      expect(await session.pendingInteractions()).toEqual([]);
      server.assertExhausted();
    } finally {
      issueReview.resolve();
      approveReview.resolve();
      releaseLookup.resolve();
      await reader.return?.();
    }
  },
  30_000,
);
