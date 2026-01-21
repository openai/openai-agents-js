import { Agent, run } from '@openai/agents';
import { createAiSdkTextStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';

async function main() {
  const agent = new Agent({
    name: 'Text Agent',
    instructions: 'Respond with three short sentences.',
  });

  const stream = await run(agent, 'Tell me about stars.', { stream: true });
  const response = createAiSdkTextStreamResponse(stream);

  if (!response.body) {
    throw new Error('Response body is not available.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    process.stdout.write(decoder.decode(value, { stream: true }));
  }

  process.stdout.write(decoder.decode());
  await stream.completed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
