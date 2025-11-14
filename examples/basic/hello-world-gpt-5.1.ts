import {
  Agent,
  OpenAIChatCompletionsModel,
  run,
  withTrace,
} from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

const output = z.object({
  title: z.string(),
  description: z.string(),
});

async function main() {
  withTrace('GPT-5.1 None Reasoning Assistant', async () => {
    const prompt =
      'Tell me about recursion in programming in a few sentences. Quickly responding with a single answer is fine.';
    const agent = new Agent({
      name: 'GPT-5.1 Responses Assistant',
      model: 'gpt-5.1',
      instructions: "You're a helpful assistant.",
      modelSettings: {
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
      },
      outputType: output,
    });
    const result = await run(agent, prompt);
    console.log(result.finalOutput);

    const completionsAgent = new Agent({
      name: 'GPT-5.1 Chat Completions Assistant',
      model: new OpenAIChatCompletionsModel(new OpenAI(), 'gpt-5.1'),
      instructions: "You're a helpful assistant.",
      modelSettings: {
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
      },
      outputType: output,
    });
    const completionsResult = await run(completionsAgent, prompt);
    console.log(completionsResult.finalOutput);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
