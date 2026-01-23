import 'server-only';

import { Agent, tool, webSearchTool } from '@openai/agents';
import { imageGenerationTool } from '@openai/agents-openai';
import { z } from 'zod';

export const imagePartialCount = 3;

const mathAgent = new Agent({
  name: 'Math Assistant',
  model: 'gpt-5.2',
  modelSettings: {
    reasoning: { effort: 'none' },
    text: { verbosity: 'low' },
  },
  instructions:
    'Use the demo_math tool to solve simple arithmetic questions. Respond with the result only.',
  tools: [
    tool({
      name: 'demo_math',
      description: 'Perform a simple arithmetic operation for tool-call demos.',
      parameters: z.object({
        a: z.number().describe('First number.'),
        b: z.number().describe('Second number.'),
        op: z.enum(['add', 'multiply']).describe('Operation to perform.'),
      }),
      async execute({ a, b, op }) {
        const result = op === 'add' ? a + b : a * b;
        return { op, a, b, result };
      },
    }),
  ],
});

export function createMainAgent(): Agent {
  const codexEnabled = process.env.EXAMPLES_CHATKIT_CODEX_ENABLED === '1';
  const instructions = codexEnabled
    ? 'You are a helpful assistant. When you get a technical question, you must use the codex tool for research.'
    : 'You are a helpful assistant. Provide concise answers using tools when needed.';
  return new Agent({
    name: 'ChatKit Agent',
    model: 'gpt-5.2',
    modelSettings: {
      reasoning: { effort: 'low', summary: 'detailed' },
      text: { verbosity: 'low' },
    },
    instructions,
    tools: [
      // built-in web search tool
      webSearchTool(),
      // built-in image generation tool
      imageGenerationTool({ partialImages: imagePartialCount }),
      // run local math agent for simple arithmetic or tool test requests
      mathAgent.asTool({
        toolName: 'math_agent',
        toolDescription: 'Use for simple arithmetic or tool test requests.',
      }),
    ],
  });
}

export const agent = createMainAgent();
