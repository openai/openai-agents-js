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
        'https://upload.wikimedia.org/wikipedia/commons/0/0c/GoldenGateBridge-001.jpg',
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
  // The image shows a large, iconic suspension bridge painted in a bright reddish-orange color. The bridge spans over a large body of water, connecting two landmasses. The weather is clear, with a blue sky and soft clouds in the background. Vehicles can be seen traveling along the bridge, and there is some greenery in the foreground. The overall atmosphere is serene and scenic.
}

if (require.main === module) {
  main().catch(console.error);
}
