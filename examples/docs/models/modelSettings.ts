import { Runner, Agent } from '@openai/agents/classic';

const agent = new Agent({
  name: 'Creative writer',
  // ...
  modelSettings: { temperature: 0.7, toolChoice: 'auto' },
});

// or globally
new Runner({ modelSettings: { temperature: 0.3 } });
