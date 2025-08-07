import { Agent } from '@openai/agents';

const summarizer = new Agent({
  name: 'Summarizer',
  instructions: 'Generate a concise summary of the supplied text.',
});

const summarizerTool = summarizer.asTool({
  toolName: 'summarize_text',
  toolDescription: 'Generate a concise summary of the supplied text.',
});

const echoAgent = new Agent({
  name: 'Echo',
  instructions: 'Repeat whatever the user says.',
});

const echoTool = echoAgent.asTool({
  toolName: 'echo_text',
  returnRunResult: true,
});

const mainAgent = new Agent({
  name: 'Research assistant',
  tools: [summarizerTool, echoTool],
});
