import { tool } from '@openai/agents/classic';

interface LooseToolInput {
  text: string;
}

const looseTool = tool({
  description: 'Echo input; be forgiving about typos',
  strict: false,
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: true,
  },
  execute: async (input) => {
    // because strict is false we need to do our own verification
    if (typeof input !== 'object' || input === null || !('text' in input)) {
      return 'Invalid input. Please try again';
    }
    return (input as LooseToolInput).text;
  },
});
