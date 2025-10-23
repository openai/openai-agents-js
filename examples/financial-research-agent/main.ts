import { withTrace } from '@openai/agents';
import { FinancialResearchManager } from './manager';

// Entrypoint for the financial bot example.
// Run this as `npx tsx examples/financial-research-agent/main.ts` and enter a financial research query, for example:
// "Write up an analysis of Apple Inc.'s most recent quarter."

async function main() {
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
