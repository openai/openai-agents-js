import { Agent, run, tool, ToolOutputImage } from '@openai/agents';
import { z } from 'zod';

const fetchRandomImage = tool({
  name: 'fetch_random_image',
  description: 'Return a sample image for the model to describe.',
  parameters: z.object({}),
  execute: async (): Promise<ToolOutputImage> => {
    console.log('[tool] Returning a publicly accessible URL for the image ...');
    return {
      type: 'image',
      image:
        'https://images.unsplash.com/photo-1505761671935-60b3a7427bad?auto=format&fit=crop&w=400&q=80',
      detail: 'auto',
    };
  },
});

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
  tools: [fetchRandomImage],
});

async function main() {
  const result = await run(
    agent,
    'Call fetch_random_image and describe what you see in the picture.',
  );

  console.log(result.finalOutput);
  // This image features the clock tower commonly known as Big Ben attached to the Palace of Westminster in London, captured against a clear blue sky. The ornate architecture and the clock face stand out prominently above surrounding buildings, with a hint of passing traffic below.
}

if (require.main === module) {
  main().catch(console.error);
}
