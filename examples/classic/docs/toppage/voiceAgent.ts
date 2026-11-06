import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
});

// Automatically connects your microphone and audio output in the browser via WebRTC.
const session = new RealtimeSession(agent);
await session.connect({
  apiKey: '<client-api-key>',
});
