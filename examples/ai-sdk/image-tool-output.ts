import { Agent, run, tool, ToolOutputImage } from '@openai/agents';
import { aisdk, AiSdkModel } from '@openai/agents-extensions';
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

export async function runAgents(model: AiSdkModel) {
  const agent = new Agent({
    name: 'Assistant',
    model,
    instructions: 'You are a helpful assistant.',
    tools: [fetchRandomImage],
  });
  const result = await run(
    agent,
    'Call fetch_random_image and describe what you see in the picture.',
  );

  console.log(result.finalOutput);
  // The image shows a large, iconic suspension bridge painted in a bright reddish-orange color. The bridge spans over a large body of water, connecting two landmasses. The weather is clear, with a blue sky and soft clouds in the background. Vehicles can be seen traveling along the bridge, and there is some greenery in the foreground. The overall atmosphere is serene and scenic.
}

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
// import { openai } from '@ai-sdk/openai';

(async function () {
  // const model = aisdk(openai('gpt-4.1-nano'));
  const openRouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const model = aisdk(openRouter('openai/gpt-oss-120b'));
  await runAgents(model);
})();
