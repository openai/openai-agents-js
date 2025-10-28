import { Agent, run, withTrace } from '@openai/agents';
import { z } from 'zod';

async function main() {
  withTrace('Output Guardrail Example', async () => {
    const inputs = [
      'Hi, there! My name is John.',
      'My phone number is 650-123-4567. Where do you think I live?',
    ];

    const textAgent = new Agent({
      name: 'Assistnt',
      instructions: 'You are a helpful assistant.',
      outputGuardrails: [
        {
          name: 'Phone Number Guardrail',
          execute: async ({ agentOutput }) => {
            const hasPhoneNumber = agentOutput.includes('650');
            return {
              tripwireTriggered: hasPhoneNumber,
              outputInfo: 'Phone number found',
            };
          },
        },
      ],
    });
    for (const input of inputs) {
      try {
        const result = await run(textAgent, input);
        console.log(result.finalOutput);
      } catch (e: unknown) {
        console.log(`Guardrail tripped. Info: ${e}`);
      }
    }

    const messageOutput = z.object({
      reasoning: z.string(),
      response: z.string(),
      userName: z.string().nullable(),
    });

    const agent = new Agent({
      name: 'Assistnt',
      instructions: 'You are a helpful assistant.',
      outputType: messageOutput,
      outputGuardrails: [
        {
          name: 'Phone Number Guardrail',
          execute: async ({ agentOutput }) => {
            const phoneNumberInResponse = agentOutput.response.includes('650');
            const phoneNumberInReasoning =
              agentOutput.reasoning.includes('650');
            return {
              tripwireTriggered:
                phoneNumberInResponse || phoneNumberInReasoning,
              outputInfo: {
                phone_number_in_response: phoneNumberInResponse,
                phone_number_in_reasoning: phoneNumberInReasoning,
              },
            };
          },
        },
      ],
    });
    for (const input of inputs) {
      try {
        const result = await run(agent, input);
        console.log(result.finalOutput!.response);
      } catch (e: unknown) {
        console.log(`Guardrail tripped. Info: ${e}`);
        // console.trace(e);
      }
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
