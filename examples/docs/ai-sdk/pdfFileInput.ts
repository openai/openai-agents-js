import { Agent, run } from '@openai/agents';
import { openai } from '@ai-sdk/openai';
import { aisdk } from '@openai/agents-extensions/ai-sdk';

const agent = new Agent({
  name: 'Document assistant',
  instructions: 'Summarize the document and call out important details.',
  model: aisdk(openai('gpt-5.4')),
});

const result = await run(agent, [
  {
    role: 'user',
    content: [
      {
        type: 'input_file',
        file: 'https://example.com/quarterly-report.pdf',
        filename: 'quarterly-report.pdf',
      },
      {
        type: 'input_text',
        text: 'Summarize this report.',
      },
    ],
  },
]);

console.log(result.finalOutput);
