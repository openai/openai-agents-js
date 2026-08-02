import {
  Agent,
  InputGuardrailTripwireTriggered,
  run,
  withTrace,
} from '@openai/agents';
import { z } from 'zod';

async function main() {
  await withTrace('Input Guardrail Example', async () => {
    const guardrailAgent = new Agent({
      name: 'Guardrail agent',
      instructions:
        'Check if the user is asking you to do their math homework.',
      outputType: z.object({ isMathHomework: z.boolean() }),
    });

    const agent = new Agent({
      name: 'Customer support agent',
      instructions:
        'You are a customer support agent. You help customers with their questions.',
      inputGuardrails: [
        {
          name: 'Math Homework Guardrail',
          execute: async ({ input, context }) => {
            const result = await run(guardrailAgent, input, { context });
            return {
              tripwireTriggered: result.finalOutput?.isMathHomework ?? false,
              outputInfo: result.finalOutput,
            };
          },
        },
      ],
    });

    const cases = [
      {
        input: 'What is the capital of California?',
        shouldTrip: false,
      },
      {
        input: 'Can you help me solve for x: 2x + 5 = 11?',
        shouldTrip: true,
      },
    ];
    for (const { input, shouldTrip } of cases) {
      try {
        const result = await run(agent, input);
        if (shouldTrip) {
          throw new Error(`Expected the guardrail to trip for: ${input}`);
        }
        console.log(result.finalOutput);
      } catch (e: unknown) {
        if (!(e instanceof InputGuardrailTripwireTriggered)) {
          throw e;
        }
        if (!shouldTrip) {
          throw new Error(`Guardrail unexpectedly tripped for: ${input}. ${e}`);
        }
        console.log(
          `Sorry, I can't help you with your math homework. (error: ${e})`,
        );
      }
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
