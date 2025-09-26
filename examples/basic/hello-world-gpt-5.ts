import { Agent, OpenAIChatCompletionsModel, run } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

const output = z.object({
  title: z.string(),
  description: z.string(),
});

async function main() {
  const prompt =
    'Tell me about recursion in programming. Quickly responding with a single answer is fine.';

  const agent = new Agent({
    name: 'GPT-5 Assistant',
    model: 'gpt-5',
    instructions: "You're a helpful assistant.",
    modelSettings: {
      reasoning: { effort: 'minimal' },
      text: { verbosity: 'low' },
    },
    outputType: output,
  });

  const result = await run(agent, prompt);
  console.log(result.finalOutput);

  // The following code works in the same way:
  // const agent2 = agent.clone({
  //   modelSettings: {
  //     providerData: {
  //       reasoning: { effort: 'minimal' },
  //       text: { verbosity: 'low' },
  //     }
  //   },
  // });
  // const result2 = await run(agent2, prompt);
  // console.log(result2.finalOutput);

  const completionsAgent = new Agent({
    name: 'GPT-5 Assistant',
    model: new OpenAIChatCompletionsModel(new OpenAI(), 'gpt-5'),
    instructions: "You're a helpful assistant.",
    modelSettings: {
      reasoning: { effort: 'minimal' },
      text: { verbosity: 'low' },
    },
    outputType: output,
  });
  const completionsResult = await run(completionsAgent, prompt);
  console.log(completionsResult.finalOutput);

  // The following code works in the same way:
  // const completionsAgent2 = completionsAgent.clone({
  //   modelSettings: {
  //     providerData: {
  //       reasoning_effort: 'minimal',
  //       verbosity: 'low',
  //     }
  //   },
  // });
  // const completionsResult2 = await run(completionsAgent2, prompt);
  // console.log(completionsResult2.finalOutput);
}

if (require.main === module) {
  main().catch(console.error);
}
