import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Research assistant',
  modelSettings: {
    reasoning: { effort: 'medium' },
  },
});

const result = await run(
  agent,
  'A research brief proposes a six-week study with ten participants. Summarize the plan and identify its main risks.',
);
console.log(result.finalOutput);
