import { Agent, run, codeInterpreterTool, withTrace } from '@openai/agents';
import OpenAI from 'openai';

async function main() {
  const agent = new Agent({
    name: 'Agent Math Tutor',
    instructions:
      'You are a personal math tutor. When asked a math question, write and run code to answer the question.',
    tools: [codeInterpreterTool({ container: { type: 'auto' } })],
  });

  await withTrace('Code interpreter example', async () => {
    console.log('Solving math problem...');
    const result = await run(
      agent,
      'I need to solve the equation 3x + 11 = 14. Can you help me?',
      { stream: true },
    );
    for await (const event of result) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'model'
      ) {
        const modelEvent = event.data.event as
          | OpenAI.Responses.ResponseStreamEvent
          | undefined;
        if (
          modelEvent &&
          modelEvent.type === 'response.output_item.done' &&
          modelEvent.item.type === 'code_interpreter_call'
        ) {
          const code = modelEvent.item.code;
          console.log(`Code interpreter code:\n\`\`\`\n${code}\n\`\`\``);
        }
      }
    }
    console.log(`Final output: ${result.finalOutput}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
