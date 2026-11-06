import { Agent, run } from '@openai/agents/classic';

// Import the OpenAI model provider
import { openai } from '@ai-sdk/openai';

// Import the adapter
import { aisdk } from '@openai/agents-extensions/ai-sdk';

// Create a model instance to be used by the agent
const model = aisdk(openai('gpt-5.4'));

// Create an agent with the model
const agent = new Agent({
  name: 'My Agent',
  instructions: 'You are a helpful assistant.',
  model,
});

const result = await run(agent, 'What is the capital of Germany?');
console.log(result.finalOutput);
