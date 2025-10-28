import { Agent, user, run } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions:
    'You are a helpful assistant knowledgeable about recent AGI research.',
});

let history: AgentInputItem[] = [
  // initial message
  user('Are we there yet?'),
];

for (let i = 0; i < 10; i++) {
  // run 10 times
  const result = await run(agent, history);

  // update the history to the new output
  history = result.history;

  history.push(user('How about now?'));
}
