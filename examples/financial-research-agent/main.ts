import { withTrace } from '@openai/agents';
import { FinancialResearchManager } from './manager';
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';
import OpenAI from 'openai';
import { setTracingDisabled } from '@openai/agents';

// Entrypoint for the financial bot example.
// Run this as `npx tsx examples/financial-research-agent/main.ts` and enter a financial research query, for example:
// "Write up an analysis of Apple Inc.'s most recent quarter."

async function main() {
  // Set up a custom OpenAI client before running the agents
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  setOpenAIAPI('chat_completions');
  if (apiKey) {
    setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL }));
  }
  setTracingDisabled(true);
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter a financial research query: ', async (query: string) => {
    rl.close();
    await withTrace('Financial research workflow', async () => {
      const manager = new FinancialResearchManager();
      await manager.run(query);
    });
  });
}

if (require.main === module) {
  main();
}
