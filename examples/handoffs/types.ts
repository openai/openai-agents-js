import { Agent, run } from '@openai/agents';
import { z } from 'zod';

const FirstOutput = z.object({
  first: z.string(),
});

// Agent<unknown, typeof FirstOutput>
const firstAgent = new Agent({
  name: 'First Assistant',
  instructions: 'Be a helpful assistant.',
  outputType: FirstOutput,
});

const SecondOutput = z.object({
  second: z.string(),
});

// Agent<unknown, typeof SecondOutput>
const secondAgent = new Agent({
  name: 'Second Assistant',
  instructions: 'Be a helpful assistant.',
  outputType: SecondOutput,
});

const triageAgent = Agent.create({
  name: 'Triage Assistant',
  instructions:
    'You are a triage assistant. If the input say "first", hand off to firstAgent. It it has "Second", hand off to secondAgent.',
  handoffs: [firstAgent, secondAgent],
});

async function main() {
  for (const keyword of ['first', 'second', 'last']) {
    const result = await run(
      triageAgent,
      `Hey, how are you? This is my ${keyword} message.`,
    );
    const finalOutput = result.finalOutput;
    if (typeof finalOutput === 'string') {
      console.log(`Triage Assistant: ${finalOutput}`);
    } else if (finalOutput && 'first' in finalOutput) {
      console.log(`First Assistant: ${JSON.stringify(finalOutput)}`);
    } else if (finalOutput && 'second' in finalOutput) {
      console.log(`Second Assistant: ${JSON.stringify(finalOutput)}`);
    } else {
      console.log('No final output.');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
