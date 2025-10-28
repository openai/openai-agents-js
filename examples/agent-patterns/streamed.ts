import { Agent, Runner, tool } from '@openai/agents';
import chalk from 'chalk';
import { z } from 'zod';

const storyTellerAgent = new Agent({
  name: 'Storyteller',
  instructions:
    'You are a talented story teller that can tell an engaging 3-4 paragraph story on any topic.',
});

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const weatherAgent = new Agent({
  name: 'Weather Agent',
  tools: [getWeatherTool],
});

const runner = new Runner({
  model: 'gpt-4.1-mini',
});

async function main() {
  console.log(chalk.bgCyan('  ● Text only stream  \n'));

  const storyStream = await runner.run(
    storyTellerAgent,
    'Tell me a story about corgis',
    {
      // enable streaming
      stream: true,
    },
  );

  // If you only care about the text you can use the transformed textStream
  storyStream
    .toTextStream({ compatibleWithNodeStreams: true })
    .pipe(process.stdout);

  // waiting to make sure that we are done with handling the stream
  await storyStream.completed;

  console.log(chalk.bgCyan('\n\n  ● All event stream  \n'));

  const weatherStream = await runner.run(
    weatherAgent,
    'What is the weather in San Francisco and Seattle?',
    {
      stream: true,
    },
  );

  for await (const event of weatherStream) {
    // these are the raw events from the model
    if (event.type === 'raw_model_stream_event') {
      console.log(`${chalk.bgWhite(event.type)} %o`, event.data);
    }

    // agent updated events
    if (event.type == 'agent_updated_stream_event') {
      console.log(
        `${chalk.bgGreen(event.type)} New agent: %s`,
        event.agent.name,
      );
    }

    // Agent SDK specific events
    if (event.type === 'run_item_stream_event') {
      console.log(`${chalk.bgYellow(event.type)} %o`, event.item);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
