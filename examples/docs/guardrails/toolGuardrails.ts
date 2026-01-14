import {
  Agent,
  ToolGuardrailFunctionOutputFactory,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  tool,
} from '@openai/agents';
import { z } from 'zod';

const blockSecrets = defineToolInputGuardrail({
  name: 'block_secrets',
  run: async ({ toolCall }) => {
    const args = JSON.parse(toolCall.arguments) as { text?: string };
    if (args.text?.includes('sk-')) {
      return ToolGuardrailFunctionOutputFactory.rejectContent(
        'Remove secrets before calling this tool.',
      );
    }
    return ToolGuardrailFunctionOutputFactory.allow();
  },
});

const redactOutput = defineToolOutputGuardrail({
  name: 'redact_output',
  run: async ({ output }) => {
    const text = String(output ?? '');
    if (text.includes('sk-')) {
      return ToolGuardrailFunctionOutputFactory.rejectContent(
        'Output contained sensitive data.',
      );
    }
    return ToolGuardrailFunctionOutputFactory.allow();
  },
});

const classifyTool = tool({
  name: 'classify_text',
  description: 'Classify text for internal routing.',
  parameters: z.object({
    text: z.string(),
  }),
  inputGuardrails: [blockSecrets],
  outputGuardrails: [redactOutput],
  execute: ({ text }) => `length:${text.length}`,
});

const agent = new Agent({
  name: 'Classifier',
  instructions: 'Classify incoming text.',
  tools: [classifyTool],
});

void agent;
