import { Agent, handoff, tool } from '@openai/agents';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const LookupOrderParameters = toStandardJsonSchema(
  v.object({
    orderId: v.pipe(v.string(), v.minLength(1)),
    includeHistory: v.optional(v.boolean(), false),
  }),
);

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up an order by ID.',
  parameters: LookupOrderParameters,
  // The argument type is inferred after Valibot validation and defaults run.
  execute: async ({ orderId, includeHistory }) => ({
    orderId,
    status: 'shipped',
    history: includeHistory ? ['placed', 'shipped'] : undefined,
  }),
});

const Resolution = toStandardJsonSchema(
  v.object({
    orderId: v.string(),
    message: v.string(),
  }),
);

const supportAgent = new Agent({
  name: 'Order support',
  instructions: 'Resolve order questions and return a structured summary.',
  tools: [lookupOrder],
  // The final output is converted to JSON Schema, then validated by Valibot.
  outputType: Resolution,
});

const supportAgentTool = supportAgent.asTool({
  toolName: 'resolve_order',
  toolDescription: 'Resolve an order question with the support specialist.',
  parameters: LookupOrderParameters,
  // inputBuilder receives the same validated and inferred parameter type.
  inputBuilder: ({ params }) =>
    `Resolve order ${params.orderId}. Include history: ${params.includeHistory}.`,
});

const EscalationDetails = toStandardJsonSchema(
  v.object({
    reason: v.pipe(v.string(), v.minLength(1)),
    priority: v.optional(v.picklist(['normal', 'urgent']), 'normal'),
  }),
);

const billingAgent = new Agent({
  name: 'Billing specialist',
  instructions: 'Resolve billing questions.',
});

const billingHandoff = handoff(billingAgent, {
  inputType: EscalationDetails,
  // The callback receives the validated value, including Valibot defaults.
  onHandoff: async (_context, details) => {
    if (details) {
      await recordEscalation(details.reason, details.priority);
    }
  },
});

async function recordEscalation(_reason: string, _priority: string) {}

export { billingHandoff, supportAgent, supportAgentTool };
