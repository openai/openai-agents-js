import { RealtimeSession, RealtimeAgent } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Assistant',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime-2.1',
});

// Connect with an ephemeral client token before sending conversation events.
await session.connect({ apiKey: '<client-api-key>' });

session.sendMessage('Hello, how are you?');
