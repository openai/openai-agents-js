import { Agent, run, withTrace } from '@openai/agents';
import { z } from 'zod';

async function main() {
  withTrace('Input Guardrail Example', async () => {
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

    const inputs = [
      'What is the capital of California?',
      'Can you help me solve for x: 2x + 5 = 11?',
    ];
    for (const input of inputs) {
      try {
        const result = await run(agent, input);
        console.log(result.finalOutput);
      } catch (e: unknown) {
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
