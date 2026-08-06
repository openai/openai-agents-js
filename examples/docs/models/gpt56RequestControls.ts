import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Research assistant',
  model: 'gpt-5.6',
  modelSettings: {
    reasoning: {
      mode: 'pro',
      effort: 'max',
      context: 'all_turns',
    },
    promptCacheOptions: {
      mode: 'explicit',
      ttl: '30m',
    },
  },
});

await run(agent, [
  {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'Treat this research brief as a reusable prompt prefix.',
        promptCacheBreakpoint: { mode: 'explicit' },
      },
      {
        type: 'input_text',
        text: 'Summarize the brief and identify its main risks.',
      },
    ],
  },
]);
