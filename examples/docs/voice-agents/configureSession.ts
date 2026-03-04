import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
  config: {
    outputModalities: ['audio'],
    audio: {
      input: {
        format: 'pcm16',
        transcription: {
          model: 'gpt-4o-mini-transcribe',
        },
      },
      output: {
        format: 'pcm16',
      },
    },
  },
});
