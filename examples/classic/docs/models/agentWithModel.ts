import { Agent } from '@openai/agents/classic';

const agent = new Agent({
  name: 'Creative writer',
  model: 'gpt-5.6-sol',
});
