import { Agent, run } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'Joker',
    instructions: 'You are a helpful assistant.',
  });

  const stream = await run(agent, 'Please tell me 5 jokes.', {
    stream: true,
  });
  for await (const event of stream.toTextStream()) {
    process.stdout.write(event);
  }
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
