import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

const historyFunFact = tool({
  // The name of the tool will be used by the agent to tell what tool to use.
  name: 'history_fun_fact',
  // The description is used to describe when to use the tool by telling it what it does.
  description: 'Give a fun fact about a historical event',
  // This tool takes no parameters, so we provide an empty Zod object.
  parameters: z.object({}),
  execute: async () => {
    // The output will be returned back to the agent to use.
    return 'Sharks are older than trees.';
  },
});

const agent = new Agent({
  name: 'History Tutor',
  instructions:
    'You provide assistance with historical queries. Explain important events and context clearly.',
  // Add the tool to the agent.
  tools: [historyFunFact],
});
