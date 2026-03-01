import { Agent, run } from '@openai/agents';

const historyTutorAgent = new Agent({
  name: 'History Tutor',
  instructions:
    'You provide assistance with historical queries. Explain important events and context clearly.',
});

const mathTutorAgent = new Agent({
  name: 'Math Tutor',
  instructions:
    'You provide help with math problems. Explain your reasoning at each step and include examples',
});

const triageAgent = Agent.create({
  name: 'Triage Agent',
  instructions:
    "You determine which agent to use based on the user's homework question",
  handoffs: [historyTutorAgent, mathTutorAgent],
});

async function main() {
  const result = await run(triageAgent, 'What is the capital of France?');
  console.log(result.finalOutput);
}

main().catch((err) => console.error(err));
