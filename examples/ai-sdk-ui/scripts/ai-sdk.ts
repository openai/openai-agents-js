import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAiSdkTextStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';

async function main() {
  const result = streamText({
    model: openai('gpt-4.1'),
    system: 'Respond with three short sentences.',
    prompt: 'Tell me about stars.',
  });

  const response = createAiSdkTextStreamResponse(result.textStream);

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
