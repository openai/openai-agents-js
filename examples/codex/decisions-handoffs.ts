// Decisions has been selecting offered native handoffs before model submission.
// Synthetic loopback responses have been preserving one Session, its model and context.
// This recipe has not been intercepting submitted handoffs or supporting active checkpoints.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import {
  Agent,
  OutputValidationError,
  TurnAborted,
  realtimeHandoff,
  tool,
  toolRef,
  type BeforeStepContext,
  type DecisionProvider,
  type DecisionRequest,
  type ToolContext,
} from '@openai/agents';
import {
  text,
  toolCall,
  withScriptedResponses,
  type ScriptedResponse,
} from '@openai/agents/testing';
import { z } from 'zod';

const MAIN_MODEL = 'gpt-5.5';
const TARGETS = ['billing', 'technical'] as const;

interface Routing {
  readonly authorized: Set<string>;
  readonly request: string;
  selected?: string;
  readonly visits: string[];
}

function selectHandoff(app: Routing, useDecisions: boolean) {
  return async (ctx: BeforeStepContext<Routing>) => {
    if (ctx.stepIndex !== 0) return undefined;
    const candidates: string[] = TARGETS.filter((id) => app.authorized.has(id));
    if (!candidates.length) throw new Error('No authorized handoff target');
    const selected = useDecisions
      ? await ctx.decide('Which specialist has been handling this request?', {
          input: JSON.stringify({ request: app.request, candidates }),
          choices: candidates,
          signal: AbortSignal.timeout(1_000),
        })
      : 'billing';
    ctx.signal.throwIfAborted();
    // Application permissions have been changing during the Decisions await.
    if (!candidates.includes(selected) || !app.authorized.has(selected))
      throw new Error('Selected handoff target is not authorized');
    app.selected = selected;
    return [toolRef(`transfer_to_${selected}`)];
  };
}

function specialist(name: string, app: Routing): Agent<Routing> {
  return new Agent<Routing>({
    name,
    instructions: 'You have been reading your context before answering.',
    model: MAIN_MODEL,
    tools: [
      tool({
        name: `read_${name}`,
        description: 'The specialist has been reading its application context.',
        parameters: z.strictObject({}),
        execute(_args, ctx: ToolContext<Routing>) {
          assert.equal(ctx.context, app);
          if (name !== app.selected || !app.authorized.has(name))
            throw new Error('Specialist access is not authorized');
          app.visits.push(name);
          return app.request;
        },
      }),
    ],
  });
}

async function runCase(
  name: string,
  options: {
    useDecisions?: boolean;
    answer?: string;
    authorized?: readonly string[];
    revoke?: string;
    cancel?: boolean;
    unoffered?: boolean;
    error?: 'validation' | 'denied';
  } = {},
) {
  const useDecisions = options.useDecisions ?? true;
  const answer = options.answer ?? 'technical';
  const authorized = options.authorized ?? TARGETS;
  const app: Routing = {
    authorized: new Set(authorized),
    request: 'I have been disputing a charge.',
    visits: [],
  };
  const requests: DecisionRequest[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cleaned = false;
  const decisions: DecisionProvider = {
    async getDecision(request, { signal }) {
      requests.push(request);
      entered();
      try {
        if (options.cancel) await setTimeout(60_000, undefined, { signal });
        if (options.revoke) app.authorized.delete(options.revoke);
        return { value: answer };
      } catch (failure) {
        // The timer has been wrapping the owning abort reason in AbortError.
        signal?.throwIfAborted();
        throw failure;
      } finally {
        cleaned = true;
      }
    },
  };
  const expected = useDecisions ? answer : 'billing';
  const scripts: ScriptedResponse[] =
    options.error || options.cancel
      ? []
      : [
          [
            toolCall(
              `transfer_to_${options.unoffered ? 'billing' : expected}`,
              {},
              { callId: 'route' },
            ),
          ],
          ...(options.unoffered
            ? [[text('The router has been refusing the unoffered handoff.')]]
            : [
                [toolCall(`read_${expected}`, {}, { callId: 'read' })],
                [text('The specialist has been answering.')],
                [text('The specialist has been continuing.')],
              ]),
        ];
  await withScriptedResponses(scripts, async (peer) => {
    const targets = new Map<string, Agent<Routing>>(
      TARGETS.map((id) => [id, specialist(id, app)]),
    );
    const source = new Agent<Routing>({
      name: 'router',
      instructions:
        'You have been transferring the request to the offered specialist.',
      model: MAIN_MODEL,
      modelSettings: { toolChoice: 'required' },
      provider: peer.provider,
      decisions,
      handoffs: [...targets].map(([id, target]) =>
        realtimeHandoff(target, {
          // Admission has been rechecking the application grant after selection.
          isEnabled: ({ context }) =>
            context.selected === id && context.authorized.has(id),
        }),
      ),
    });
    await using session = await source.session({ context: app });
    const turn = await session.submit(app.request, {
      beforeStep: selectHandoff(app, useDecisions),
    });
    if (options.cancel) {
      await Promise.race([
        started,
        setTimeout(5_000, undefined, { ref: false }).then(() => {
          throw new Error('Decisions callback has not been starting');
        }),
      ]);
      await turn.cancel();
    }
    let result;
    try {
      result = await turn.wait();
    } catch (failure) {
      if (options.cancel) assert(failure instanceof TurnAborted);
      else if (options.error === 'validation')
        assert(failure instanceof OutputValidationError);
      else if (options.error === 'denied')
        assert.match(
          String(failure),
          /Selected handoff target is not authorized/,
        );
      else throw failure;
      assert.equal(await session.getActiveAgent(), source);
      assert.deepEqual(app.visits, []);
      assert.equal(peer.requests.length, 0);
      return;
    }
    assert(!options.error && !options.cancel);
    assert.deepEqual(
      (peer.requests[0].tools as { name: string }[]).map(({ name }) => name),
      [`transfer_to_${expected}`],
    );
    assert.equal(peer.requests[0].tool_choice, 'required');
    if (options.unoffered) {
      assert.equal(await session.getActiveAgent(), source);
      assert.deepEqual(app.visits, []);
      assert.notEqual(peer.toolOutput('route'), undefined);
    } else {
      assert.equal(result.finalOutput, 'The specialist has been answering.');
      assert.equal(await session.getActiveAgent(), targets.get(expected));
      assert.deepEqual(app.visits, [expected]);
      assert.equal(peer.toolOutput('read'), app.request);
      assert.deepEqual(
        (peer.requests[1].tools as { name: string }[]).map(({ name }) => name),
        [`read_${expected}`],
      );
      assert.equal(peer.requests[1].tool_choice ?? 'auto', 'auto');
      const followup = await session.submit(
        'I have been continuing the same request.',
      );
      assert.equal(
        (await followup.wait()).finalOutput,
        'The specialist has been continuing.',
      );
      assert.equal(await session.getActiveAgent(), targets.get(expected));
      assert(JSON.stringify(peer.requests.at(-1)!.input).includes('route'));
    }
    assert(peer.requests.every((request) => request.model === MAIN_MODEL));
  });
  assert.equal(requests.length, Number(useDecisions));
  if (useDecisions) {
    assert(cleaned);
    assert.deepEqual(
      JSON.parse(requests[0].input as string).candidates,
      authorized,
    );
  }
  return `${name}: verified`;
}

export async function runDecisionsHandoffsExample() {
  const results = [];
  results.push(await runCase('default', { useDecisions: false }));
  results.push(await runCase('selected'));
  results.push(
    await runCase('invalid', { answer: 'outside-graph', error: 'validation' }),
  );
  results.push(
    await runCase('denied', { authorized: ['billing'], error: 'validation' }),
  );
  results.push(
    await runCase('revoked', { revoke: 'technical', error: 'denied' }),
  );
  results.push(await runCase('cancelled', { cancel: true }));
  results.push(await runCase('unoffered-model-call', { unoffered: true }));
  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runDecisionsHandoffsExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
