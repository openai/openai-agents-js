import { Runner, withTrace } from '@openai/agents';
import { plannerAgent } from './agents.ts';
import { FinancialResearchManager } from './manager.ts';

async function main() {
  const args = process.argv.slice(2);
  const useCodex = args.includes('--codex');
  let query = args
    .filter((arg) => arg !== '--codex')
    .join(' ')
    .trim();
  if (!query) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    query = await rl.question('Enter a financial research query: ');
    rl.close();
  }
  let runner: Runner | undefined;
  if (useCodex) {
    const { CodexProvider } =
      await import('@openai/agents-extensions/experimental/codex');
    runner = new Runner({
      modelProvider: new CodexProvider({
        threadOptions: {
          workingDirectory: process.cwd(),
          skipGitRepoCheck: true,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
        },
      }),
      model: process.env.CODEX_MODEL ?? plannerAgent.model,
    });
  }
  await withTrace('Financial research workflow', async () => {
    const manager = new FinancialResearchManager(runner);
    await manager.run(query);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
