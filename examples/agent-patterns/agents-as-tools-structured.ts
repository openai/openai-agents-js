import { Agent, run } from '@openai/agents';
import { z } from 'zod';

const translator = new Agent({
  name: 'translator',
  instructions:
    'Translate the input text into the target language. If the target is not clear, you can ask the user for clarification.',
});

const orchestrator = new Agent({
  name: 'orchestrator',
  instructions:
    'You are a task dispatcher. Always call the tool with sufficient input for the task. Do not handle any tasks by yourself.',
  tools: [
    translator.asTool({
      toolName: 'translate_text',
      toolDescription:
        'Translate text between languages. When you call this tool, you must provide the text to translate, the source language, and the target language.',

      // Structured input parameters, filled by the model.
      parameters: z.object({
        text: z.string().describe('Text to translate.'),
        source: z.string().describe('Source language code or name.'),
        target: z.string().describe('Target language code or name.'),
      }),

      // By default, the input schema will be included in a simpler format.
      // Set includeInputSchema to true to include the full JSON Schema.
      // includeInputSchema: true,

      // Build a custom prompt from structured input data.
      // inputBuilder: async ({ params }) => {
      //   return `Translate the text "${params.text}" from ${params.source} to ${params.target}.`;
      // },
    }),
  ],
  modelSettings: { toolChoice: 'required' },
});

async function main() {
  const query = 'Translate "Hola" from Spanish to French.';

  const response1 = await run(translator, query);
  console.log('Translator agent direct run:', response1.finalOutput);

  const response2 = await run(orchestrator, query);
  console.log('Translator agent as tool:', response2.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
