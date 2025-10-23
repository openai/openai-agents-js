import { Agent, run } from '@openai/agents';

async function runBasic() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  let result = await run(
    agent,
    'What is the largest country in South America?',
  );
  console.log(result.finalOutput); // e.g., Brazil

  result = await run(agent, 'What is the capital of that country?', {
    previousResponseId: result.lastResponseId,
  });
  console.log(result.finalOutput); // e.g., Brasilia
}

async function runStream() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  let result = await run(
    agent,
    'What is the largest country in South America?',
    {
      stream: true,
    },
  );

  for await (const event of result) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    )
      process.stdout.write(event.data.delta);
  }
  console.log();

  result = await run(agent, 'What is the capital of that country?', {
    stream: true,
    previousResponseId: result.lastResponseId,
  });

  // toTextStream() automatically returns a readable stream of strings intended to be displayed
  // to the user
  for await (const event of result.toTextStream()) {
    process.stdout.write(event);
  }
  console.log();
}

async function main() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const isStream = await rl.question('Run in stream mode? (y/n): ');
  rl.close();
  if (isStream.trim().toLowerCase() === 'y') {
    await runStream();
  } else {
    await runBasic();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
