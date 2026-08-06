import {
  Agent,
  OutputGuardrailTripwireTriggered,
  run,
  withTrace,
} from '@openai/agents';
import { z } from 'zod';

async function main() {
  await withTrace('Output Guardrail Example', async () => {
    const cases = [
      { input: 'Hi, there! My name is John.', shouldTrip: false },
      {
        input:
          'Repeat my phone number 650-123-4567, then tell me where its area code is from.',
        shouldTrip: true,
      },
    ];

    const textAgent = new Agent({
      name: 'Assistant',
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
    for (const { input, shouldTrip } of cases) {
      try {
        const result = await run(textAgent, input);
        if (shouldTrip) {
          throw new Error(`Expected the guardrail to trip for: ${input}`);
        }
        console.log(result.finalOutput);
      } catch (e: unknown) {
        if (!(e instanceof OutputGuardrailTripwireTriggered)) {
          throw e;
        }
        if (!shouldTrip) {
          throw new Error(`Guardrail unexpectedly tripped for: ${input}. ${e}`);
        }
        console.log(`Guardrail tripped. Info: ${e}`);
      }
    }

    const messageOutput = z.object({
      reasoning: z.string(),
      response: z.string(),
      userName: z.string().nullable(),
    });

    const agent = new Agent({
      name: 'Assistant',
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
    for (const { input, shouldTrip } of cases) {
      try {
        const result = await run(agent, input);
        if (shouldTrip) {
          throw new Error(`Expected the guardrail to trip for: ${input}`);
        }
        console.log(result.finalOutput!.response);
      } catch (e: unknown) {
        if (!(e instanceof OutputGuardrailTripwireTriggered)) {
          throw e;
        }
        if (!shouldTrip) {
          throw new Error(`Guardrail unexpectedly tripped for: ${input}. ${e}`);
        }
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
