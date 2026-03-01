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
  withTrace('GPT-5.2 Assistant', async () => {
    const prompt =
      'Tell me about recursion in programming in a few sentences. Quickly responding with a single answer is fine.';

    const agent = new Agent({
      name: 'GPT-5.2 Assistant',
      model: 'gpt-5.2',
      instructions: "You're a helpful assistant.",
      modelSettings: {
        reasoning: { effort: 'none' },
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
    //       reasoning: { effort: 'none' },
    //       text: { verbosity: 'low' },
    //     }
    //   },
    // });
    // const result2 = await run(agent2, prompt);
    // console.log(result2.finalOutput);

    const completionsAgent = new Agent({
      name: 'GPT-5.2 Assistant',
      model: new OpenAIChatCompletionsModel(new OpenAI(), 'gpt-5.2'),
      instructions: "You're a helpful assistant.",
      modelSettings: {
        reasoning: { effort: 'none' },
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
    //       reasoning_effort: 'none',
    //       verbosity: 'low',
    //     }
    //   },
    // });
    // const completionsResult2 = await run(completionsAgent2, prompt);
    // console.log(completionsResult2.finalOutput);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
