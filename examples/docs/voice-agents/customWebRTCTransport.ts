import {
  RealtimeAgent,
  RealtimeSession,
  OpenAIRealtimeWebRTC,
} from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

async function main() {
  const transport = new OpenAIRealtimeWebRTC({
    mediaStream: await navigator.mediaDevices.getUserMedia({ audio: true }),
    audioElement: document.createElement('audio'),
  });

  const customSession = new RealtimeSession(agent, { transport });
}
