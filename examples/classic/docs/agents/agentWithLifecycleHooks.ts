import { Agent } from '@openai/agents/classic';

const agent = new Agent({
  name: 'Verbose agent',
  instructions: 'Explain things thoroughly.',
});

agent.on('agent_start', (ctx, agent) => {
  console.log(`[${agent.name}] started`);
});
agent.on('agent_end', (ctx, output) => {
  console.log(`[agent] produced:`, output);
});
