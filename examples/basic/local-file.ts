import fs from 'node:fs';
import path from 'node:path';
import { Agent, run } from '@openai/agents';

const filePath = path.join(
  __dirname,
  'media/partial_o3-and-o4-mini-system-card.pdf',
);

function fileToBase64(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return fileBuffer.toString('base64');
}

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const b64File = fileToBase64(filePath);
  const result = await run(agent, [
    {
      role: 'user',
      content: [
        {
          type: 'input_file',
          file: `data:application/pdf;base64,${b64File}`,
          providerData: {
            filename: 'partial_o3-and-o4-mini-system-card.pdf',
          },
        },
      ],
    },
    {
      role: 'user',
      content: 'What is the first sentence of the introduction?',
    },
  ]);

  console.log(result.finalOutput);
  // OpenAI o3 and OpenAI o4-mini combine state-of-the-art reasoning with full tool capabilities — web browsing, Python, image and file analysis, image generation, canvas, automations, file search, and memory.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
