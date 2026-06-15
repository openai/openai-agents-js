import {
  Agent,
  run,
  OutputGuardrail,
  OutputGuardrailTripwireTriggered,
} from '@openai/agents';
import { z } from 'zod';

async function main() {
  const GuardrailOutput = z.object({
    reasoning: z.string(),
    isReadableByTenYearOld: z.boolean(),
  });

  const guardrailAgent = new Agent({
    name: 'Checker',
    model: 'gpt-4o-mini',
    instructions:
      'You will be given a question and a response. Your goal is to judge whether the response is simple enough to be understood by a ten year old.',
    outputType: GuardrailOutput,
  });

  // A single output guardrail. The runner runs it on the partial output while the
  // model streams (see `streamingOutputGuardrailCheckpoint` below) and again on the
  // final output. `agentOutput` is the accumulated text so far for streaming checks.
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
    instructions:
      'You are a helpful assistant. You ALWAYS write long responses, making sure to be verbose and detailed.',
    outputGuardrails: [readabilityGuardrail],
  });

  // Decide when to run the guardrail while streaming: here, every ~300 characters.
  // Until a checkpoint passes, the streamed output is held back, so unsafe content
  // never reaches the consumer.
  let lastCheckpoint = 0;

  try {
    const result = await run(
      agent,
      'What is a black hole, and how does it behave?',
      {
        stream: true,
        streamingOutputGuardrailCheckpoint: ({ accumulatedText }) => {
          if (accumulatedText.length - lastCheckpoint >= 300) {
            lastCheckpoint = accumulatedText.length;
            return true;
          }
          return false;
        },
      },
    );

    for await (const event of result) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        process.stdout.write(event.data.delta);
      }
    }
    await result.completed;

    console.log(`\n\n${result.finalOutput}`);
  } catch (error) {
    if (error instanceof OutputGuardrailTripwireTriggered) {
      const info = error.result.output.outputInfo as
        | z.infer<typeof GuardrailOutput>
        | undefined;
      console.log(
        `\n\nGuardrail tripped. Reasoning: ${info?.reasoning ?? 'not readable'}`,
      );
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
