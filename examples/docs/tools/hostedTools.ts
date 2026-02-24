import {
  Agent,
  codeInterpreterTool,
  fileSearchTool,
  imageGenerationTool,
  webSearchTool,
} from '@openai/agents';

const agent = new Agent({
  name: 'Travel assistant',
  tools: [
    webSearchTool({ searchContextSize: 'medium' }),
    fileSearchTool('VS_ID', { maxNumResults: 3 }),
    codeInterpreterTool(),
    imageGenerationTool({ size: '1024x1024' }),
  ],
});
