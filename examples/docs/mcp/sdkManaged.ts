import { prepareMcpExample, question } from './sdkManagedAgent';

async function main() {
  const { agent, runner, server } = await prepareMcpExample();
  try {
    const result = await runner.run(agent, question);
    console.log(result.finalOutput);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
