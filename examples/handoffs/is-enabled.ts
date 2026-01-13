import { Agent, RunContext, handoff, run, withTrace } from '@openai/agents';
import { createInterface } from 'node:readline/promises';

const introduction =
  `Handoffs with Conditional Enabling\n\n` +
  'This routes conversations to language specialists based on user preferences.\n';

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
  handoffDescription: 'Spanish speaking specialist.',
});

const frenchAgent = new Agent<AppContext>({
  name: 'french_agent',
  instructions:
    "You respond in French. Always reply to the user's question in French.",
  handoffDescription: 'French speaking specialist.',
});

const italianAgent = new Agent<AppContext>({
  name: 'italian_agent',
  instructions:
    "You respond in Italian. Always reply to the user's question in Italian.",
  handoffDescription: 'Italian speaking specialist.',
});

const spanishHandoff = handoff(spanishAgent, {
  toolDescriptionOverride:
    'Transfer the conversation to the Spanish specialist.',
});

const frenchHandoff = handoff(frenchAgent, {
  isEnabled: frenchSpanishEnabled,
  toolDescriptionOverride:
    'Transfer the conversation to the French specialist.',
});

const italianHandoff = handoff(italianAgent, {
  isEnabled: europeanEnabled,
  toolDescriptionOverride:
    'Transfer the conversation to the Italian specialist.',
});

const triageAgent = new Agent<AppContext>({
  name: 'triage_agent',
  instructions: [
    'You triage multilingual conversations.',
    'When a specialist handoff is available you immediately transfer the conversation.',
    'If no specialist is available you answer in English and explain the limitation.',
  ].join(' '),
  handoffs: [spanishHandoff, frenchHandoff, italianHandoff],
});

const autoMode = process.env.EXAMPLES_INTERACTIVE_MODE === 'auto';

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (prompt: string, fallback: string) => {
    if (autoMode) return fallback;
    return (await rl.question(prompt)).trim();
  };

  try {
    console.log(introduction);
    console.log('Choose language preference:');
    console.log('1. Spanish only (handoff to Spanish agent)');
    console.log(
      '2. French and Spanish (handoffs to Spanish and French agents)',
    );
    console.log('3. European languages (handoffs to all three agents)');

    const choice = await ask('\nSelect option (1-3): ', '2');
    const preferenceMap: Record<string, LanguagePreference> = {
      '1': 'spanish_only',
      '2': 'french_spanish',
      '3': 'european',
    };
    const languagePreference = preferenceMap[choice] ?? 'spanish_only';

    const runContext = new RunContext<AppContext>({ languagePreference });
    const enabledHandoffs = await triageAgent.getEnabledHandoffs(runContext);
    const handoffNames = enabledHandoffs
      .map((handoffItem) => handoffItem.toolName)
      .join(', ');

    console.log(`\nLanguage preference: ${languagePreference}`);
    console.log(
      handoffNames
        ? `Available handoffs: ${handoffNames} (the model sees ${enabledHandoffs.length} options).`
        : 'Available handoffs: none.',
    );

    const userRequest = await ask(
      '\nAsk a question and see which specialist handles the conversation:\n',
      'How do you say good night?',
    );

    if (!userRequest.trim()) {
      console.log('No question provided, exiting.');
      return;
    }

    console.log('\nProcessing request...');
    await withTrace('Conditional handoff access', async () => {
      const result = await run(triageAgent, userRequest, {
        context: runContext,
      });
      const finalAgentName = result.lastAgent?.name ?? triageAgent.name;
      console.log(`\nFinal agent: ${finalAgentName}`);
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
