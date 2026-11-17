import { prepareMcpExample, question } from './sdkManagedAgent';

async function main() {
  const { agent, runner, server } = await prepareMcpExample();
  try {
    const result = await runner.run(agent, question, { stream: true });
    for await (const event of result) {
      if (event.type === 'run_item_stream_event') {
        console.log(`SDK event: ${event.name}`, event.item);
      }
    }
    await result.completed;
    console.log(`Done streaming; final result: ${result.finalOutput}`);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
