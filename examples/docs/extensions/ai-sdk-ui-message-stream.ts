import { Agent, run } from '@openai/agents';
import { createAiSdkUiMessageStream } from '@openai/agents-extensions/ai-sdk-ui';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Reply with a short answer.',
});

export async function createStream() {
  const stream = await run(agent, 'Hello there.', { stream: true });
  return createAiSdkUiMessageStream(stream);
}
