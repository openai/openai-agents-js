import { Agent, OpenAIChatCompletionsModel, run } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

const output = z.object({
  title: z.string(),
  description: z.string(),
});

async function main() {
  const agent = new Agent({
    name: 'GPT-5 Assistant',
    model: 'gpt-5',
    instructions: "You're a helpful assistant.",
    modelSettings: {
      providerData: {
        reasoning: { effort: 'minimal' },
        text: { verbosity: 'low' },
      },
    },
    outputType: output,
  });

  const prompt =
    'Tell me about recursion in programming. Quickly responding with a single answer is fine.';
  const result = await run(agent, prompt);
  console.log(result.finalOutput);

  const completionsAgent = new Agent({
    name: 'GPT-5 Assistant',
    model: new OpenAIChatCompletionsModel(new OpenAI(), 'gpt-5'),
    instructions: "You're a helpful assistant.",
    modelSettings: {
      providerData: {
        reasoning_effort: 'minimal',
        verbosity: 'low',
      },
    },
    outputType: output,
  });
  const completionsResult = await run(completionsAgent, prompt);
  console.log(completionsResult.finalOutput);
}

if (require.main === module) {
  main().catch(console.error);
}
