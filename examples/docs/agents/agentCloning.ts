import { Agent } from '@openai/agents';

const pirateAgent = new Agent({
  name: 'Pirate',
  instructions: 'Respond like a pirate – lots of “Arrr!”',
  model: 'gpt-5-mini',
});

const robotAgent = pirateAgent.clone({
  name: 'Robot',
  instructions: 'Respond like a robot – be precise and factual.',
});
