import { run } from '@openai/agents';
import { agent } from './hostedAgent';

async function main() {
  const result = await run(
    agent,
    'Which language is the repo I pointed in the MCP tool settings written in?',
  );
  console.log(result.finalOutput);
}

main().catch(console.error);
