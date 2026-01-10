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
        'https://images.unsplash.com/photo-1505761671935-60b3a7427bad?auto=format&fit=crop&w=400&q=80',
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
  // This image features the clock tower commonly known as Big Ben attached to the Palace of Westminster in London, captured against a clear blue sky. The ornate architecture and the clock face stand out prominently above surrounding buildings, with a hint of passing traffic below.
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
