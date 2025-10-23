import { Agent, run, withTrace, extractAllTextOutput } from '@openai/agents';
import readline from 'node:readline/promises';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const spanishAgent = new Agent({
  name: 'spanish_agent',
  instructions: "You translate the user's message to Spanish",
});

const translationPicker = new Agent({
  name: 'translation_picker',
  instructions: 'You pick the best Spanish translation from the given options.',
});

async function main() {
  const msg = await rl.question(
    "Hi! Enter a message, and we'll translate it to Spanish.\n\n",
  );

  if (!msg) {
    throw new Error('No message provided');
  }

  await withTrace('Parallel translation', async () => {
    const [res1, res2, res3] = await Promise.all([
      run(spanishAgent, msg),
      run(spanishAgent, msg),
      run(spanishAgent, msg),
    ]);

    const outputs = [
      extractAllTextOutput(res1.newItems),
      extractAllTextOutput(res2.newItems),
      extractAllTextOutput(res3.newItems),
    ];

    const translations = outputs.join('\n\n');
    console.log(`\n\nTranslations:\n\n${translations}`);

    const bestTranslationResult = await run(
      translationPicker,
      `Input: ${msg}\n\nTranslations:\n${translations}`,
    );

    console.log('\n\n-----');
    console.log(`Best translation: ${bestTranslationResult.finalOutput}`);
  });

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
