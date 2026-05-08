import { OpenAIRealtimeWebRTC } from '@openai/agents/realtime';

const client = new OpenAIRealtimeWebRTC();
const audioBuffer = new ArrayBuffer(0);

await client.connect({
  apiKey: '<api key>',
  model: 'gpt-realtime-2',
  initialSessionConfig: {
    instructions: 'Speak like a pirate',
    outputModalities: ['audio'],
    audio: {
      input: {
        format: 'pcm16',
      },
      output: {
        format: 'pcm16',
        voice: 'ash',
      },
    },
  },
});

// optionally for WebSockets
client.on('audio', (newAudio) => {});

client.sendAudio(audioBuffer);
