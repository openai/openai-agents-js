import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime-2.1',
  config: {
    outputModalities: ['audio'],
    reasoning: {
      effort: 'low',
    },
    parallelToolCalls: true,
    audio: {
      input: {
        format: 'pcm16',
        transcription: {
          model: 'gpt-live-transcribe',
          delay: 'low',
          prompt:
            'A software support conversation about the OpenAI Agents SDK.',
          keywords: ['OpenAI Agents SDK', 'RealtimeSession'],
          languages: ['en', 'ja'],
        },
      },
      output: {
        format: 'pcm16',
      },
    },
  },
});
