import {
  Agent,
  Runner,
  setDefaultOpenAIKey,
  setDefaultOpenAIClient,
  setTracingExportApiKey,
} from '@openai/agents';
import { OpenAI } from 'openai';

setDefaultOpenAIKey(process.env.OPENAI_API_KEY!);

setDefaultOpenAIClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));

const runner = new Runner({ model: 'gpt‑4o-mini' });
const agent = new Agent({
  name: 'Test Agent',
  instructions: 'You are a helpful assistant.',
  modelSettings: { temperature: 0.7, toolChoice: 'auto' },
});

async function main() {
  const result = await runner.run(agent, 'Hey, I need your help!');
  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
setTracingExportApiKey(process.env.OPENAI_API_KEY!);
