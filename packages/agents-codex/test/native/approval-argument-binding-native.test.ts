import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type FunctionApprovalRequest,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
async function nextApproval(
  session: Session,
): Promise<FunctionApprovalRequest> {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw Error('Approval missing');
}
const iso = '2026-11-01T12:00:00.000Z';
const raw = (value: number | boolean) => ({
  payload: { value },
  order: { a: 1, b: 2 },
  when: iso,
});
it('reuses captured validation after approval while retaining the execution input guard', async () => {
  let validations = 0;
  let validationClosed = false;
  let rechecks = 0;
  const effects: number[] = [];
  const selected = tool({
    name: 'one_time_validation',
    parameters: z
      .object({ value: z.number() })
      .superRefine((_value, context) => {
        validations++;
        if (validationClosed)
          context.addIssue({
            code: 'custom',
            message: 'Synthetic one-time input validation already consumed',
          });
      }),
    needsApproval: true,
    before(context) {
      rechecks++;
      expect(context.effectiveArguments.value).toBe(7);
      return { action: 'allow' };
    },
    execute({ value }, context) {
      expect(context.effectiveArguments.value).toBe(value);
      effects.push(value);
      return 'accepted';
    },
  });
  const server = new ModelServer([
    [
      call(
        'one_time_validation',
        { value: 7 },
        { callId: 'one-time-validation' },
      ),
    ],
    [message('done')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-approved-validation',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Use one_time_validation.',
    model: 'gpt-5',
    provider,
    tools: [selected],
  }).session();
  const turn = await session.submit('begin');
  const request = await nextApproval(session);
  const capturedValidations = validations;
  expect(capturedValidations).toBeGreaterThan(0);
  expect(rechecks).toBe(0);
  expect(effects).toEqual([]);
  validationClosed = true;
  const done = turn.wait();
  await session.respond(request.approve());
  expect((await done).finalOutput).toBe('done');
  expect(validations).toBe(capturedValidations);
  expect(rechecks).toBe(1);
  expect(effects).toEqual([7]);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});
it.each([false, true])(
  'binds approved values across all execution input guards (restored=%s)',
  async (restored) => {
    for (const mode of [
      'replace',
      'mutate',
      'date',
      'boolean',
      'reorder',
      'allow',
      'retained-view',
    ] as const) {
      const effects: unknown[] = [];
      let guards = 0;
      let policyView: { payload: { value: number }; when: Date } | undefined;
      const selected = tool({
        name: 'risky',
        parameters: z.object({
          payload: z.object({ value: z.union([z.number(), z.boolean()]) }),
          order: z.object({ a: z.number(), b: z.number() }),
          when: z.string().transform((value) => new Date(value)),
        }),
        needsApproval: true,
        runBeforeApproval: true,
        before(context) {
          if (++guards === 1)
            return { action: 'replaceArguments', arguments: raw(1) };
          if (mode === 'replace')
            return { action: 'replaceArguments', arguments: raw(2) };
          if (mode === 'boolean')
            return { action: 'replaceArguments', arguments: raw(true) };
          if (mode === 'reorder')
            return {
              action: 'replaceArguments',
              arguments: { ...raw(1), order: { b: 2, a: 1 } },
            };
          if (mode === 'retained-view')
            policyView = context.effectiveArguments as {
              payload: { value: number };
              when: Date;
            };
          if (mode === 'mutate')
            (context.effectiveArguments.payload as { value: number }).value = 2;
          if (mode === 'date')
            (context.effectiveArguments.when as Date).setUTCFullYear(2000);
          return { action: 'allow' };
        },
        execute(args, context) {
          if (policyView) {
            policyView.payload.value = 3;
            policyView.when.setUTCFullYear(2000);
            expect(args.payload.value).toBe(1);
            expect(args.when.toISOString()).toBe(iso);
            expect(context.effectiveArguments.payload).toEqual({ value: 1 });
            expect(
              (context.effectiveArguments.when as Date).toISOString(),
            ).toBe(iso);
          }
          effects.push(args);
          return 'accepted';
        },
      });
      const server = new ModelServer([
        [call('risky', raw(0), { callId: 'bound-input' })],
        [message('done')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-approval-binding',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Use risky.',
        model: 'gpt-5',
        provider,
        tools: [selected],
      });
      let state: Awaited<ReturnType<Session['suspend']>> | undefined;
      if (restored) {
        await using source = await agent.session();
        const sourceTurn = await source.submit('begin');
        const original = await nextApproval(source);
        expect(original.turnId).toBe(sourceTurn.turnId);
        expect(
          (original.effectiveArguments as ReturnType<typeof raw>).payload.value,
        ).toBe(1);
        state = await source.suspend();
      }
      await using session = await agent.session({ state });
      const turn = restored
        ? session.restoredTurn!
        : await session.submit('begin');
      const request = await nextApproval(session);
      expect(
        (request.effectiveArguments as ReturnType<typeof raw>).payload.value,
      ).toBe(1);
      expect(guards).toBe(1);
      const done = turn.wait();
      await session.respond(request.approve());
      expect((await done).finalOutput).toBe('done');
      expect(guards).toBe(2);
      const allowed =
        mode === 'reorder' || mode === 'allow' || mode === 'retained-view';
      expect(effects).toHaveLength(allowed ? 1 : 0);
      if (allowed)
        expect((effects[0] as ReturnType<typeof raw>).payload.value).toBe(1);
      else
        expect(JSON.stringify(server.requests[1].input)).toContain(
          'Tool input policy changed approved arguments',
        );
      server.assertExhausted();
    }
  },
  30000,
);
