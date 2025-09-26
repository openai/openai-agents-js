import { Agent } from '@openai/agents';

const myAgent = new Agent({
  name: 'My Agent',
  instructions: "You're a helpful agent.",
  modelSettings: {
    reasoning: { effort: 'minimal' },
    text: { verbosity: 'low' },
  },
  // If OPENAI_DEFAULT_MODEL=gpt-5 is set, passing only modelSettings works.
  // It's also fine to pass a GPT-5 model name explicitly:
  // model: 'gpt-5',
});
