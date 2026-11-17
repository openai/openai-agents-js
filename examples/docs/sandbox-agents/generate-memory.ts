import { memory } from '@openai/agents/sandbox';

const memoryCapability = memory({
  generate: {
    maxRawMemoriesForConsolidation: 128,
    extraPrompt:
      'Prioritize workflow corrections, verification commands, and user preferences.',
  },
});
