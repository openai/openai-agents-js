import { Agent, run } from '@openai/agents';
import { z } from 'zod';

async function main() {
  const agent = new Agent({
    name: 'Assistnt',
    instructions:
      'You are a helpful assistant. You ALWAYS write long responses, making sure to be verbose and detailed.',
  });

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

  async function runGuardrail(text: string) {
    const result = await run(guardrailAgent, text);
    return result.finalOutput;
  }

  let currentText = '';
  let nextGuardrailCheckLen = 300;
  const result = await run(
    agent,
    'What is a black hole, and how does it behave?',
    { stream: true },
  );
  for await (const event of result) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      process.stdout.write(event.data.delta);
      currentText += event.data.delta;
      if (currentText.length > nextGuardrailCheckLen) {
        const guardrailResult = await runGuardrail(currentText);
        if (guardrailResult && !guardrailResult.isReadableByTenYearOld) {
          console.log(
            `\n\nGuardrail tripped. Reasoning: ${guardrailResult.reasoning}`,
          );
          return;
        }
        nextGuardrailCheckLen += 300;
      }
    }
  }
  const guardrailResult = await runGuardrail(currentText);
  if (guardrailResult && !guardrailResult.isReadableByTenYearOld) {
    console.log(
      `\n\nGuardrail tripped. Reasoning: ${guardrailResult.reasoning}`,
    );
    return;
  }
  console.log(`\n\n${result.finalOutput}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
