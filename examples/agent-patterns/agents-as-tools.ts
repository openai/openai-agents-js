import { Agent, run, withTrace } from '@openai/agents';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });

const spanishAgent = new Agent({
  name: 'spanish_agent',
  instructions: "You translate the user's message to Spanish",
});

const frenchAgent = new Agent({
  name: 'french_agent',
  instructions: "You translate the user's message to French",
});

const italianAgent = new Agent({
  name: 'italian_agent',
  instructions: "You translate the user's message to Italian",
});

const orchestratorAgent = new Agent({
  name: 'orchestrator_agent',
  instructions: [
    'You are a translation agent. You use the tools given to you to translate.',
    'If asked for multiple translations, you call the relevant tools in order.',
    'You never translate on your own, you always use the provided tools.',
  ].join(' '),
  tools: [
    spanishAgent.asTool({
      toolName: 'translate_to_spanish',
      toolDescription: "Translate the user's message to Spanish",
      // You can customize both runner init options and additional options for its execution
      runConfig: {
        model: 'gpt-5',
        modelSettings: {
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' },
        },
      },
      runOptions: {
        maxTurns: 3,
      },
    }),
    frenchAgent.asTool({
      toolName: 'translate_to_french',
      toolDescription: "Translate the user's message to French",
    }),
    italianAgent.asTool({
      toolName: 'translate_to_italian',
      toolDescription: "Translate the user's message to Italian",
    }),
  ],
});

const synthesizerAgent = new Agent({
  name: 'synthesizer_agent',
  instructions:
    'You inspect translations, correct them if needed, and produce a final concatenated response.',
});

async function main() {
  const msg = await rl.question(
    'Hi! What would you like translated, and to which languages? ',
  );

  if (!msg) {
    throw new Error('No message provided');
  }

  await withTrace('Orchestrator evaluator', async () => {
    const orchestratorResult = await run(orchestratorAgent, msg);

    for (const item of orchestratorResult.newItems) {
      if (item.type === 'message_output_item') {
        const text = item.content;
        if (text) {
          console.log(`  - Translation step: ${text}`);
        }
      }
    }

    const synthesizerResult = await run(
      synthesizerAgent,
      orchestratorResult.output,
    );

    console.log(`\n\nFinal response:\n${synthesizerResult.finalOutput}`);
  });

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
