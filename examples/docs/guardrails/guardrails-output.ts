import {
  Agent,
  run,
  OutputGuardrailTripwireTriggered,
  OutputGuardrail,
} from '@openai/agents';
import { z } from '@openai/zod';

// The output by the main agent
const MessageOutput = z.object({ response: z.string() });
type MessageOutput = z.infer<typeof MessageOutput>;

// The output by the math guardrail agent
const MathOutput = z.object({ reasoning: z.string(), isMath: z.boolean() });

// The guardrail agent
const guardrailAgent = new Agent({
  name: 'Guardrail check',
  instructions: 'Check if the output includes any math.',
  outputType: MathOutput,
});

// An output guardrail using an agent internally
const mathGuardrail: OutputGuardrail<typeof MessageOutput> = {
  name: 'Math Guardrail',
  async execute({ agentOutput, context }) {
    const result = await run(guardrailAgent, agentOutput.response, {
      context,
    });
    return {
      outputInfo: result.finalOutput,
      tripwireTriggered: result.finalOutput?.isMath ?? false,
    };
  },
};

const agent = new Agent({
  name: 'Support agent',
  instructions:
    'You are a user support agent. You help users with their questions.',
  outputGuardrails: [mathGuardrail],
  outputType: MessageOutput,
});

async function main() {
  try {
    const input = 'Hello, can you help me solve for x: 2x + 3 = 11?';
    await run(agent, input);
    console.log("Guardrail didn't trip - this is unexpected");
  } catch (e) {
    if (e instanceof OutputGuardrailTripwireTriggered) {
      console.log('Math output guardrail tripped');
    }
  }
}

main().catch(console.error);
