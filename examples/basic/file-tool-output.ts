import { Agent, run, tool, ToolOutputFileContent } from '@openai/agents';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const fetchSystemCard = tool({
  name: 'fetch_system_card',
  description: 'Fetch the system card for the given topic.',
  parameters: z.object({ topic: z.string() }),
  execute: async ({ topic }): Promise<ToolOutputFileContent> => {
    console.log('[tool] Fetching system card for topic:', topic);
    const pdfPath = path.join(
      __dirname,
      'media',
      'partial_o3-and-o4-mini-system-card.pdf',
    );
    return {
      type: 'file',
      file: {
        data: fs.readFileSync(pdfPath),
        mediaType: 'application/pdf',
        filename: 'partial_o3-and-o4-mini-system-card.pdf',
      },
    };
  },
});

const agent = new Agent({
  name: 'System Card Agent',
  instructions:
    "You are a helpful assistant who can fetch system cards. When you cannot find the answer in the data from tools, you must not guess anything. Just say you don't know.",
  tools: [fetchSystemCard],
});

async function main() {
  const result = await run(
    agent,
    'Call fetch_system_card and let me know what version of Preparedness Framework was used?',
  );

  console.log(result.finalOutput);
  // The version of the Preparedness Framework used is Version 2.
}

if (require.main === module) {
  main().catch(console.error);
}
