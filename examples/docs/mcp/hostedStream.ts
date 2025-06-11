import { run } from '@openai/agents';
import { agent } from './hostedAgent';

async function main() {
  const result = await run(
    agent,
    'Which language is the repo I pointed in the MCP tool settings written in?',
    { stream: true },
  );

  for await (const event of result) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'model' &&
      event.data.event.type !== 'response.mcp_call_arguments.delta' &&
      event.data.event.type !== 'response.output_text.delta'
    ) {
      console.log(`Got event of type ${JSON.stringify(event.data)}`);
    }
  }
  console.log(`Done streaming; final result: ${result.finalOutput}`);
}

main().catch(console.error);
