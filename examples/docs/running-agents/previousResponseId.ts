import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Reply very concisely.',
});

async function main() {
  const first = await run(agent, 'What city is the Golden Gate Bridge in?');
  console.log(first.finalOutput);
  // -> "San Francisco"

  const previousResponseId = first.lastResponseId;
  const second = await run(agent, 'What state is it in?', {
    previousResponseId,
  });
  console.log(second.finalOutput);
  // -> "California"
}

main().catch(console.error);
