import { Agent, run } from '@openai/agents';
import { createAiSdkUiMessageStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Reply with a short answer.',
});

export async function POST() {
  const stream = await run(agent, 'Hello there.', { stream: true });
  return createAiSdkUiMessageStreamResponse(stream);
}
