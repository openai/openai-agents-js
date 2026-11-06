import { Agent } from '@openai/agents/classic';

const agent = new Agent({
  name: 'Haiku Agent',
  instructions: 'Always respond in haiku form.',
  model: 'gpt-5.4', // optional – falls back to the default model
});
