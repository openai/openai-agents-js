import { deepseek } from '@ai-sdk/deepseek';
import { Agent } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';

const agent = new Agent({
  name: 'AI SDK v4 Test Agent',
  instructions: 'You are a helpful assistant.',
  model: aisdk(deepseek('deepseek-chat')),
});

console.log(`[AISDK_V4_MODEL_READY]${agent.name}[/AISDK_V4_MODEL_READY]`);
