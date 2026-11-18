import { exampleRunner } from '../tools/example-runner.ts';
import { mediaOptions, pdfText } from './media-input.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '@openai/agents';

const filePath = path.join(
  import.meta.dirname,
  'media/partial_o3-and-o4-mini-system-card.pdf',
);

async function main() {
  const options = mediaOptions();
  const runner = await exampleRunner(options.codex ?? false);
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const pdf = fs.readFileSync(filePath);
  const result = await runner.run(agent, [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'What is the first sentence of the introduction?',
        },
        options.codex
          ? { type: 'input_text', text: pdfText(pdf) }
          : {
              type: 'input_file',
              file: `data:application/pdf;base64,${pdf.toString('base64')}`,
              filename: 'partial_o3-and-o4-mini-system-card.pdf',
            },
      ],
    },
  ]);

  console.log(result.finalOutput);
  // OpenAI o3 and OpenAI o4-mini combine state-of-the-art reasoning with full tool capabilities — web browsing, Python, image and file analysis, image generation, canvas, automations, file search, and memory.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
