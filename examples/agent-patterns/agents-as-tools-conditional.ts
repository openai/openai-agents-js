import { Agent, RunContext, run, withTrace } from '@openai/agents';
import { createInterface } from 'node:readline/promises';

const introduction =
  `Agents-as-Tools with Conditional Enabling\n\n` +
  'This demonstrates how language response tools are dynamically enabled based on user preferences.\n';

type LanguagePreference = 'spanish_only' | 'french_spanish' | 'european';

type AppContext = {
  languagePreference: LanguagePreference;
};

function frenchSpanishEnabled({
  runContext,
}: {
  runContext: RunContext<AppContext>;
}) {
  return (
    runContext.context.languagePreference === 'french_spanish' ||
    runContext.context.languagePreference === 'european'
  );
}

function europeanEnabled({
  runContext,
}: {
  runContext: RunContext<AppContext>;
}) {
  return runContext.context.languagePreference === 'european';
}

const spanishAgent = new Agent<AppContext>({
  name: 'spanish_agent',
  instructions:
    "You respond in Spanish. Always reply to the user's question in Spanish.",
});

const frenchAgent = new Agent<AppContext>({
  name: 'french_agent',
  instructions:
    "You respond in French. Always reply to the user's question in French.",
});

const italianAgent = new Agent<AppContext>({
  name: 'italian_agent',
  instructions:
    "You respond in Italian. Always reply to the user's question in Italian.",
});

const orchestrator = new Agent<AppContext>({
  name: 'orchestrator',
  instructions: [
    'You are a multilingual assistant. You use the tools given to you to respond to users.',
    'You must call all available tools to provide responses in different languages.',
    'You never respond in languages yourself, you always use the provided tools.',
  ].join(' '),
  tools: [
    spanishAgent.asTool({
      toolName: 'respond_spanish',
      toolDescription: "Respond to the user's question in Spanish.",
      isEnabled: true,
    }),
    frenchAgent.asTool({
      toolName: 'respond_french',
      toolDescription: "Respond to the user's question in French.",
      isEnabled: frenchSpanishEnabled,
    }),
    italianAgent.asTool({
      toolName: 'respond_italian',
      toolDescription: "Respond to the user's question in Italian.",
      isEnabled: europeanEnabled,
    }),
  ],
});

async function main() {
  const autoMode = process.env.EXAMPLES_INTERACTIVE_MODE === 'auto';
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (prompt: string, fallback: string) => {
    if (autoMode) return fallback;
    return (await rl.question(prompt)).trim();
  };

  try {
    console.log(introduction);
    console.log('Choose language preference:');
    console.log('1. Spanish only (1 tool)');
    console.log('2. French and Spanish (2 tools)');
    console.log('3. European languages (3 tools)');

    const choice = await ask('\nSelect option (1-3): ', '2');
    const preferenceMap: Record<string, LanguagePreference> = {
      '1': 'spanish_only',
      '2': 'french_spanish',
      '3': 'european',
    };
    const languagePreference = preferenceMap[choice] ?? 'spanish_only';

    const runContext = new RunContext<AppContext>({ languagePreference });
    const availableTools = await orchestrator.getAllTools(runContext);
    const toolNames = availableTools.map((tool) => tool.name).join(', ');

    console.log(`\nLanguage preference: ${languagePreference}`);
    console.log(
      toolNames
        ? `Available tools: ${toolNames} (the model sees ${availableTools.length} tools).`
        : 'Available tools: none.',
    );

    const userRequest = await ask(
      '\nAsk a question and see responses in the available languages:\n',
      'How do you say good morning?',
    );

    if (!userRequest.trim()) {
      console.log('No question provided, exiting.');
      return;
    }

    console.log('\nProcessing request...');
    await withTrace('Conditional tool access', async () => {
      const result = await run(orchestrator, userRequest, {
        context: runContext,
      });
      console.log(`\nResponse:\n${result.finalOutput}`);
    });
  } finally {
    await rl.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
