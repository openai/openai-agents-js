import { exampleRunner } from '../tools/example-runner.ts';
import { mediaOptions, pdfText, readSample } from './media-input.ts';
import { Agent } from '@openai/agents';

const url = 'https://www.berkshirehathaway.com/letters/2024ltr.pdf';

async function main() {
  const options = mediaOptions(true);
  const runner = await exampleRunner(options.codex ?? false);
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const result = await runner.run(agent, [
    {
      role: 'user',
      content: [
        options.codex
          ? {
              type: 'input_text',
              text: pdfText(await readSample(url, options.file)),
            }
          : { type: 'input_file', file: url },
      ],
    },
    {
      role: 'user',
      content: 'Can you summarize the letter?',
    },
  ]);

  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
