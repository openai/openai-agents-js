import {
  RealtimeAgent,
  RealtimeSession,
  TransportLayerAudio,
} from '@openai/agents/realtime';

const agent = new RealtimeAgent({ name: 'My agent' });
const session = new RealtimeSession(agent);
// Connect with an ephemeral client token before sending conversation events.
await session.connect({ apiKey: '<client-api-key>' });

const newlyRecordedAudio = new ArrayBuffer(0);

session.on('audio', (event: TransportLayerAudio) => {
  // play your audio
});

// send new audio to the agent
session.sendAudio(newlyRecordedAudio);
