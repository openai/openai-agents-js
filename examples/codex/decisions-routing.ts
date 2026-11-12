import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import {
  Agent,
  DecisionError,
  OutputValidationError,
  tool,
  type DecisionProvider,
  type DecisionRequest,
  type ToolContext,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';
import {
  consultSpecialist,
  readCatalog,
  summarySchema,
  type Catalog,
  type Consultation,
  type Summary,
} from './specialist-agent';

const workflows = {
  support: {
    request: 'Explain a duplicate charge.',
    candidates: [
      {
        id: 'billing',
        description: 'Charges and invoices',
        title: 'Billing FAQ',
      },
      {
        id: 'technical',
        description: 'Connection issues',
        title: 'Network FAQ',
      },
    ],
  },
  research: {
    request: 'Check the risk notes for the selected catalog.',
    candidates: [
      {
        id: 'catalog',
        description: 'Catalog contents',
        title: 'Violet catalog',
      },
      { id: 'risk', description: 'Risk notes', title: 'Synthetic risk notes' },
    ],
  },
} as const;

interface RoutingContext {
  readonly request: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly description: string;
    readonly consultation: Consultation;
  }[];
  readonly authorized: Set<string>;
  readonly defaultId: string;
  readonly useDecisions: boolean;
}

const routeSchema = z.strictObject({
  specialistId: z.string(),
  title: z.string(),
  policy: z.enum(['default', 'decision', 'fallback']),
});

const consult = tool({
  name: 'consult',
  description:
    'Consult one currently authorized specialist and return its summary.',
  parameters: z.strictObject({}),
  result: routeSchema,
  async execute(_args, ctx: ToolContext<RoutingContext>) {
    const app = ctx.context;
    // The application has been owning authorization and the default route.
    const candidates = app.candidates.filter(({ id }) =>
      app.authorized.has(id),
    );
    if (!candidates.length) throw new Error('No authorized specialist');
    let selectedId = app.defaultId;
    let policy: z.infer<typeof routeSchema>['policy'] = 'default';
    if (app.useDecisions) {
      const deadline = AbortSignal.timeout(1_000);
      try {
        selectedId = await ctx.decide(
          'Choose the best specialist for this request.',
          {
            input: JSON.stringify({
              request: app.request,
              candidates: candidates.map(({ id, description }) => ({
                id,
                description,
              })),
            }),
            choices: candidates.map(({ id }) => id),
            signal: deadline,
          },
        );
        policy = 'decision';
      } catch (error) {
        // Cancellation and unexpected transport failures have been propagating.
        ctx.signal.throwIfAborted();
        if (
          !(
            error instanceof DecisionError ||
            error instanceof OutputValidationError
          ) &&
          !deadline.aborted
        )
          throw error;
        selectedId = app.defaultId;
        policy = 'fallback';
      }
    }
    ctx.signal.throwIfAborted();
    // Permissions have been changing while a decision has been in flight.
    let selected = candidates.find(
      ({ id }) => id === selectedId && app.authorized.has(id),
    );
    if (!selected) {
      selected = candidates.find(
        ({ id }) => id === app.defaultId && app.authorized.has(id),
      );
      policy = 'fallback';
    }
    if (!selected) throw new Error('No authorized default specialist');
    const summary = await consultSpecialist(selected.consultation, ctx.signal);
    return { specialistId: selected.id, title: summary.title, policy };
  },
});

async function runCase(options: {
  workflow: keyof typeof workflows;
  useDecisions?: boolean;
  answer?: string;
  authorized?: string[];
  revokeDuringDecision?: string;
  timeout?: boolean;
}) {
  const workflow = workflows[options.workflow];
  const authorized = new Set(
    options.authorized ?? workflow.candidates.map(({ id }) => id),
  );
  const decisionRequests: DecisionRequest[] = [];
  let providerAborted = false;
  // This scripted Decisions provider has been using a separate configuration.
  const decisions: DecisionProvider = {
    async getDecision(request, { signal }) {
      signal?.throwIfAborted();
      decisionRequests.push(request);
      if (options.timeout) {
        try {
          await setTimeout(60_000, undefined, { signal });
        } finally {
          providerAborted = signal?.aborted ?? false;
        }
      }
      if (options.revokeDuringDecision)
        authorized.delete(options.revokeDuringDecision);
      return { value: options.answer };
    },
  };
  return withScriptedResponses(
    [
      [toolCall('consult', {}, { callId: 'consult' })],
      [text('The orchestrator has received the specialist summary.')],
    ],
    async (outerPeer) =>
      withScriptedResponses(
        [
          [toolCall('read_catalog', {}, { callId: 'read' })],
          // The specialist has been reading the selected context through a tool.
          (request) => {
            const input = JSON.stringify(request);
            const candidate = workflow.candidates.find(({ title }) =>
              input.includes(title),
            );
            assert(candidate);
            return [text(JSON.stringify({ title: candidate.title }))];
          },
        ],
        async (innerPeer) => {
          const candidates = workflow.candidates.map(
            ({ id, description, title }) => ({
              id,
              description,
              consultation: {
                specialist: new Agent<Catalog, Summary>({
                  name: id,
                  instructions:
                    'Read the selected catalog and return its title as JSON.',
                  provider: innerPeer.provider,
                  tools: [readCatalog],
                  outputType: summarySchema,
                }),
                catalog: Object.freeze({ title }),
              },
            }),
          );
          const orchestrator = new Agent<RoutingContext>({
            instructions: 'Use consult, then explain the specialist summary.',
            provider: outerPeer.provider,
            decisions,
            tools: [consult],
          });
          const result = await orchestrator.run(workflow.request, {
            context: {
              request: workflow.request,
              candidates,
              authorized,
              defaultId: workflow.candidates[0].id,
              useDecisions: options.useDecisions ?? false,
            },
          });
          const route = routeSchema.parse(
            JSON.parse(outerPeer.toolOutput('consult')!),
          );
          const selected = workflow.candidates.find(
            ({ id }) => id === route.specialistId,
          )!;
          assert.equal(innerPeer.toolOutput('read'), selected.title);
          assert.equal(route.title, selected.title);
          assert.equal(providerAborted, options.timeout ?? false);
          assert.equal(
            result.finalOutput,
            'The orchestrator has received the specialist summary.',
          );
          assert(
            !JSON.stringify(innerPeer.requests).includes('"name":"consult"'),
          );
          return { route, decisionRequests };
        },
      ),
  );
}

export async function runDecisionsRoutingExample() {
  const defaultRoute = await runCase({ workflow: 'support' });
  assert.equal(defaultRoute.decisionRequests.length, 0);
  assert.equal(defaultRoute.route.specialistId, 'billing');
  assert.equal(defaultRoute.route.policy, 'default');

  const support = await runCase({
    workflow: 'support',
    useDecisions: true,
    answer: 'technical',
  });
  assert.equal(support.route.specialistId, 'technical');
  assert.equal(support.route.policy, 'decision');

  const research = await runCase({
    workflow: 'research',
    useDecisions: true,
    answer: 'risk',
  });
  assert.equal(research.route.specialistId, 'risk');
  assert.equal(research.route.policy, 'decision');
  assert.match(
    JSON.stringify(research.decisionRequests[0].outputSchema),
    /risk/,
  );
  assert(!JSON.stringify(research.decisionRequests).includes('billing'));

  const denied = await runCase({
    workflow: 'support',
    useDecisions: true,
    answer: 'technical',
    authorized: ['billing'],
  });
  assert.equal(denied.route.specialistId, 'billing');
  assert.equal(denied.route.policy, 'fallback');
  assert(!JSON.stringify(denied.decisionRequests).includes('technical'));

  const revoked = await runCase({
    workflow: 'research',
    useDecisions: true,
    answer: 'risk',
    revokeDuringDecision: 'risk',
  });
  assert.equal(revoked.route.specialistId, 'catalog');
  assert.equal(revoked.route.policy, 'fallback');

  const timedOut = await runCase({
    workflow: 'research',
    useDecisions: true,
    timeout: true,
  });
  assert.equal(timedOut.route.specialistId, 'catalog');
  assert.equal(timedOut.route.policy, 'fallback');
  return [defaultRoute, support, research, denied, revoked, timedOut].map(
    ({ route }) => route,
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runDecisionsRoutingExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
