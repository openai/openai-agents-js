import { Agent, run } from '@openai/agents';

// Import the model package you installed
import { openai } from '@ai-sdk/openai';

// Import the adapter
import { aisdk } from '@openai/agents-extensions';

// Create a model instance to be used by the agent
const model = aisdk(openai('gpt-5-mini'));

// Create an agent with the model
const agent = new Agent({
  name: 'My Agent',
  instructions: 'You are a helpful assistant.',
  model,
});

// Run the agent with the new model
run(agent, 'What is the capital of Germany?');
