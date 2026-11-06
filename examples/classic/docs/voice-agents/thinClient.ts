import { OpenAIRealtimeWebRTC } from '@openai/agents/realtime';

const client = new OpenAIRealtimeWebRTC();
const audioBuffer = new ArrayBuffer(0);

await client.connect({
  apiKey: '<api key>',
  model: 'gpt-realtime-2.1',
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

// Listen for audio when you manage playback yourself
client.on('audio', (newAudio) => {});

client.sendAudio(audioBuffer);
