import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

export const agent = new RealtimeAgent({
  name: 'Assistant',
});

export const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
});
