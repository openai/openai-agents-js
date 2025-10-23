import { ResearchManager } from './manager';

async function main() {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('What would you like to research? ', async (query: string) => {
    rl.close();
    const manager = new ResearchManager();
    await manager.run(query);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
