import { Agent, OpenAIConversationsSession, run } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';

const agent = new Agent({
  name: 'Planner',
  instructions: 'Track outstanding tasks before responding.',
});

// Any Session implementation can be passed here; customize storage as needed.
const session = new OpenAIConversationsSession();

const todoUpdate: AgentInputItem[] = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Add booking a hotel to my todo list.' },
    ],
  },
];

await run(agent, todoUpdate, {
  session,
  // function that combines session history with new input items before the model call
  sessionInputCallback: (history, newItems) => {
    const recentHistory = history.slice(-8);
    return [...recentHistory, ...newItems];
  },
});
