import {
  Agent,
  run,
  InputGuardrailTripwireTriggered,
  InputGuardrail,
} from '@openai/agents';
import { z } from 'zod';

const guardrailAgent = new Agent({
  name: 'Guardrail check',
  instructions: 'Check if the user is asking you to do their math homework.',
  outputType: z.object({
    isMathHomework: z.boolean(),
    reasoning: z.string(),
  }),
});

const mathGuardrail: InputGuardrail = {
  name: 'Math Homework Guardrail',
  // Set runInParallel to false to block the model until the guardrail completes.
  runInParallel: false,
  execute: async ({ input, context }) => {
    const result = await run(guardrailAgent, input, { context });
    return {
      outputInfo: result.finalOutput,
      tripwireTriggered: result.finalOutput?.isMathHomework === false,
    };
  },
};

const agent = new Agent({
  name: 'Customer support agent',
  instructions:
    'You are a customer support agent. You help customers with their questions.',
  inputGuardrails: [mathGuardrail],
});

async function main() {
  try {
    await run(agent, 'Hello, can you help me solve for x: 2x + 3 = 11?');
    console.log("Guardrail didn't trip - this is unexpected");
  } catch (e) {
    if (e instanceof InputGuardrailTripwireTriggered) {
      console.log('Math homework guardrail tripped');
    }
  }
}

main().catch(console.error);
