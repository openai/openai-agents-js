import { Agent, run } from '@openai/agents';
import { ToolOutputTrimmer } from '@openai/agents-extensions';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
});

const trimmer = new ToolOutputTrimmer({
  recentTurns: 2,
  maxOutputChars: 500,
  previewChars: 200,
});

const result = await run(agent, 'What is the weather like today?', {
  callModelInputFilter: trimmer.filter,
});

console.log(result.finalOutput);
