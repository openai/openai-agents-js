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
        model: 'gpt-5.4',
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
  instructions: [
    'You receive translations produced by translation tools.',
    'Inspect them, correct them if needed, and concatenate them into the final response.',
    'Do not refuse the request or attempt to call tools.',
  ].join(' '),
});

function formatToolOutput(output: unknown): string {
  return typeof output === 'string'
    ? output
    : (JSON.stringify(output) ?? String(output));
}

async function main() {
  const msg = await rl.question(
    'Hi! What would you like translated, and to which languages? ',
  );

  if (!msg) {
    throw new Error('No message provided');
  }
  const autoRunRequiredTools =
    msg === 'Hello to Spanish and French'
      ? ['translate_to_spanish', 'translate_to_french']
      : [];

  await withTrace('Orchestrator evaluator', async () => {
    const orchestratorResult = await run(orchestratorAgent, msg);

    const calledTranslationTools = new Set<string>();
    const translations = orchestratorResult.newItems.flatMap((item) => {
      if (
        item.type !== 'tool_call_output_item' ||
        item.rawItem.type !== 'function_call_result' ||
        !item.rawItem.name.startsWith('translate_to_')
      ) {
        return [];
      }
      calledTranslationTools.add(item.rawItem.name);
      return [`${item.rawItem.name}: ${formatToolOutput(item.output)}`];
    });
    if (translations.length === 0) {
      throw new Error('Expected the orchestrator to call a translation tool.');
    }
    const missingTranslations = autoRunRequiredTools.filter(
      (toolName) => !calledTranslationTools.has(toolName),
    );
    if (missingTranslations.length > 0) {
      throw new Error(
        `Expected the orchestrator to call all requested translation tools. Missing: ${missingTranslations.join(', ')}.`,
      );
    }
    for (const translation of translations) {
      console.log(`  - Translation step: ${translation}`);
    }

    const synthesizerResult = await run(
      synthesizerAgent,
      [`Original request: ${msg}`, 'Translations:', ...translations].join('\n'),
    );

    console.log(`\n\nFinal response:\n${synthesizerResult.finalOutput}`);
  });

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
