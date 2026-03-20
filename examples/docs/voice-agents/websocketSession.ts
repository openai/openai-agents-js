import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

const myRecordedArrayBuffer = new ArrayBuffer(0);

const wsSession = new RealtimeSession(agent, {
  transport: 'websocket',
  model: 'gpt-realtime-1.5',
});
await wsSession.connect({ apiKey: process.env.OPENAI_API_KEY! });

wsSession.on('audio', (event) => {
  // event.data is a chunk of PCM16 audio
});

wsSession.sendAudio(myRecordedArrayBuffer);
