import {
  Agent,
  GuardrailExecutionError,
  InputGuardrail,
  InputGuardrailTripwireTriggered,
  OutputGuardrail,
  OutputGuardrailTripwireTriggered,
  run,
} from '@openai/agents';
import { z } from 'zod';

// Shared guardrail agent to avoid re-creating it on every fallback run.
const guardrailAgent = new Agent({
  name: 'Guardrail check',
  instructions: 'Check if the user is asking you to do their math homework.',
  outputType: z.object({
    isMathHomework: z.boolean(),
    reasoning: z.string(),
  }),
});

async function main() {
  const input = 'Hello, can you help me solve for x: 2x + 3 = 11?';
  const context = { customerId: '12345' };

  // Input guardrail example

  const unstableInputGuardrail: InputGuardrail = {
    name: 'Math Homework Guardrail (unstable)',
    execute: async () => {
      throw new Error('Something is wrong!');
    },
  };

  const fallbackInputGuardrail: InputGuardrail = {
    name: 'Math Homework Guardrail (fallback)',
    execute: async ({ input, context }) => {
      const result = await run(guardrailAgent, input, { context });
      const isMathHomework =
        result.finalOutput?.isMathHomework ??
        /solve for x|math homework/i.test(JSON.stringify(input));
      return {
        outputInfo: result.finalOutput,
        tripwireTriggered: isMathHomework,
      };
    },
  };

  const agent = new Agent({
    name: 'Customer support agent',
    instructions:
      'You are a customer support agent. You help customers with their questions.',
    inputGuardrails: [unstableInputGuardrail],
  });

  try {
    // Input guardrails only run on the first turn of a run, so retries must start a fresh run.
    await run(agent, input, { context });
  } catch (e) {
    if (e instanceof GuardrailExecutionError) {
      console.error(`Guardrail execution failed (input): ${e}`);
      try {
        agent.inputGuardrails = [fallbackInputGuardrail];
        // Retry from scratch with the original input and context.
        await run(agent, input, { context });
      } catch (ee) {
        if (ee instanceof InputGuardrailTripwireTriggered) {
          console.log('Math homework input guardrail tripped on retry');
        } else {
          throw ee;
        }
      }
    } else {
      throw e;
    }
  }

  // Output guardrail example

  const replyOutputSchema = z.object({ reply: z.string() });

  const unstableOutputGuardrail: OutputGuardrail<typeof replyOutputSchema> = {
    name: 'Answer review (unstable)',
    execute: async () => {
      throw new Error('Output guardrail crashed.');
    },
  };

  const fallbackOutputGuardrail: OutputGuardrail<typeof replyOutputSchema> = {
    name: 'Answer review (fallback)',
    execute: async ({ agentOutput }) => {
      const outputText =
        typeof agentOutput === 'string'
          ? agentOutput
          : (agentOutput?.reply ?? JSON.stringify(agentOutput));
      const flagged = /math homework|solve for x|x =/i.test(outputText);
      return {
        outputInfo: { flaggedOutput: outputText },
        tripwireTriggered: flagged,
      };
    },
  };

  const agent2 = new Agent<unknown, typeof replyOutputSchema>({
    name: 'Customer support agent (output check)',
    instructions: 'You are a customer support agent. Answer briefly.',
    outputType: replyOutputSchema,
    outputGuardrails: [unstableOutputGuardrail],
  });

  try {
    await run(agent2, input, { context });
  } catch (e) {
    if (e instanceof GuardrailExecutionError && e.state) {
      console.error(`Guardrail execution failed (output): ${e}`);
      try {
        agent2.outputGuardrails = [fallbackOutputGuardrail];
        // Output guardrails can be retried using the saved state without another model call.
        await run(agent2, e.state);
      } catch (ee) {
        if (ee instanceof OutputGuardrailTripwireTriggered) {
          console.log('Output guardrail tripped after retry with saved state');
        } else {
          throw ee;
        }
      }
    } else {
      throw e;
    }
  }
}

main().catch(console.error);
