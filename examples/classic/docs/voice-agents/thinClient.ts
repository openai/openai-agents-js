import { OpenAIRealtimeWebSocket } from '@openai/agents/realtime';

export async function connectRawAudio(
  apiKey: string,
  playAudio: (pcm16: ArrayBuffer) => void,
) {
  const client = new OpenAIRealtimeWebSocket();

  // Forward received PCM frames to your application's playback queue.
  client.on('audio', (event) => playAudio(event.data));

  try {
    await client.connect({
      apiKey,
      model: 'gpt-realtime-2.1',
      initialSessionConfig: {
        instructions: 'Speak like a pirate',
        outputModalities: ['audio'],
        audio: {
          input: { format: 'pcm16' },
          output: { format: 'pcm16', voice: 'ash' },
        },
      },
    });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
