import { memory } from '@openai/agents/sandbox';

const memoryCapability = memory({
  generate: {
    maxRawMemoriesForConsolidation: 128,
    phaseOneModel: 'gpt-5.4-mini',
    phaseTwoModel: 'gpt-5.4',
    extraPrompt:
      'Prioritize workflow corrections, verification commands, and user preferences.',
  },
});
