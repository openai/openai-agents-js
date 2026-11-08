import { Agent, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';

const triage = z.strictObject({
  priority: z.enum(['low', 'normal', 'urgent']),
  needsReply: z.boolean(),
});

/**
 * Set OPENAI_API_KEY and OPENAI_SPECIALIST_MODEL.
 * Optionally set OPENAI_DECISION_MODEL; Decisions defaults to gpt-6-luna.
 * Optionally set OPENAI_DECISION_FALLBACK_MODEL to permit semantic fallback.
 * Model-based context compaction, explicit or automatic, requires that fallback.
 * Native handoffs and Realtime require a Responses opening. An eager function
 * tool can call a separate Responses Agent, as consultSpecialist does below.
 */
export async function runDecisionExample(
  request = 'Our production checkout stopped working. Please help now.',
): Promise<z.infer<typeof triage>> {
  const decisionModel = process.env.OPENAI_DECISION_MODEL;
  const specialistModel = process.env.OPENAI_SPECIALIST_MODEL;
  if (!specialistModel) throw new Error('Set OPENAI_SPECIALIST_MODEL');

  await using provider = new NativeProvider({
    baseUrl: process.env.OPENAI_BASE_URL,
    supportsWebsockets: false,
  });
  const consultSpecialist = tool({
    name: 'consult_specialist',
    description: 'Ask the selected specialist to review the support request.',
    parameters: z.strictObject({
      specialty: z.enum(['billing', 'technical']),
    }),
    execute: async ({ specialty }) => {
      const specialist = new Agent({
        instructions: `You are a ${specialty} support specialist. Recommend the next action.`,
        provider,
        model: specialistModel,
      });
      // The enum selects a specialist; the closure retains the full request.
      return (await specialist.run(request)).finalOutput;
    },
  });
  const coordinator = new Agent({
    instructions:
      'Select the matching specialist with consult_specialist. ' +
      "Use its answer to classify the request's priority and whether it needs a reply.",
    provider,
    model: decisionModel,
    api: 'decisions',
    fallbackModel: process.env.OPENAI_DECISION_FALLBACK_MODEL,
    tools: [consultSpecialist],
    outputType: triage,
  });
  return (await coordinator.run(request)).finalOutput;
}

if (typeof require !== 'undefined' && require.main === module) {
  runDecisionExample().then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
