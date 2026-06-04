import {
  Agent,
  run,
  OutputGuardrail,
  OutputGuardrailTripwireTriggered,
} from '@openai/agents';
import { z } from 'zod';

const GuardrailOutput = z.object({
  reasoning: z.string(),
  isReadableByTenYearOld: z.boolean(),
});

const guardrailAgent = new Agent({
  name: 'Checker',
  instructions:
    'Judge whether the response is simple enough to be understood by a ten year old.',
  outputType: GuardrailOutput,
});

// Runs both mid-stream (against the accumulated partial text) and on the final output.
const readabilityGuardrail: OutputGuardrail = {
  name: 'Readable by a ten-year-old',
  async execute({ agentOutput }) {
    const result = await run(guardrailAgent, String(agentOutput));
    const output = result.finalOutput;
    return {
      outputInfo: output,
      tripwireTriggered: output ? !output.isReadableByTenYearOld : false,
    };
  },
};

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant. Always write long responses.',
  outputGuardrails: [readabilityGuardrail],
});

async function main() {
  // Run the guardrail every ~300 streamed characters.
  let lastCheckpoint = 0;

  try {
    const result = await run(agent, 'What is a black hole?', {
      stream: true,
      streamingOutputGuardrailCheckpoint: ({ accumulatedText }) => {
        if (accumulatedText.length - lastCheckpoint >= 300) {
          lastCheckpoint = accumulatedText.length;
          return true;
        }
        return false;
      },
    });

    // Output is released only after each checkpoint passes, so unsafe content
    // never reaches the consumer.
    for await (const event of result) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        process.stdout.write(event.data.delta);
      }
    }
    await result.completed;
  } catch (e) {
    if (e instanceof OutputGuardrailTripwireTriggered) {
      console.log('\n\nStreaming output guardrail tripped');
    }
  }
}

main().catch(console.error);
