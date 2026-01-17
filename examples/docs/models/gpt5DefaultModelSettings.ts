import { Agent } from '@openai/agents';

const myAgent = new Agent({
  name: 'My Agent',
  instructions: "You're a helpful agent.",
  // If OPENAI_DEFAULT_MODEL=gpt-5.2 is set, passing only modelSettings works.
  // It's also fine to pass a GPT-5.x model name explicitly:
  model: 'gpt-5.2',
  modelSettings: {
    reasoning: { effort: 'high' },
    text: { verbosity: 'low' },
  },
});
