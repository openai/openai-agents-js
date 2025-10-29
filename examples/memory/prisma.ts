// Prisma-backed Session implementation example. To try it out:
//   pnpm add @prisma/client prisma
//   npx prisma migrate dev --name init --schema ./examples/memory/prisma/schema.prisma
//   npx prisma generate --schema ./examples/memory/prisma/schema.prisma
//   pnpm start:prisma

import { Agent, run } from '@openai/agents';
import { createPrismaSession } from './sessions';

async function main() {
  const { session, prisma } = await createPrismaSession();
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  try {
    let result = await run(
      agent,
      'What is the largest country in South America?',
      { session },
    );
    console.log(result.finalOutput);

    result = await run(agent, 'What is the capital of that country?', {
      session,
    });
    console.log(result.finalOutput);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function mainStream() {
  const { session, prisma } = await createPrismaSession();
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  try {
    let result = await run(
      agent,
      'What is the largest country in South America?',
      {
        stream: true,
        session,
      },
    );

    for await (const event of result) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        process.stdout.write(event.data.delta);
      }
    }
    console.log();

    result = await run(agent, 'What is the capital of that country?', {
      stream: true,
      session,
    });

    for await (const event of result.toTextStream()) {
      process.stdout.write(event);
    }
    console.log();
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function promptAndRun() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const isStream = await rl.question('Run in stream mode? (y/n): ');
  rl.close();
  if (isStream.trim().toLowerCase() === 'y') {
    await mainStream();
  } else {
    await main();
  }
}

promptAndRun().catch((error) => {
  console.error(error);
  process.exit(1);
});
