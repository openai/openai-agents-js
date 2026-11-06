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
  // Keep a handle on the stream you pass in. The transport does not stop a caller-supplied
  // stream on close(), so your application owns it and is responsible for ending it.
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });

  const transport = new OpenAIRealtimeWebRTC({
    mediaStream,
    audioElement: document.createElement('audio'),
  });

  const customSession = new RealtimeSession(agent, { transport });

  // Later, once the application is actually done with the microphone, release it. Leaving this
  // out keeps the microphone indicator on even after the session closes.
  // mediaStream.getTracks().forEach((track) => track.stop());
}
