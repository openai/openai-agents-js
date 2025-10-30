// Prisma-backed Session implementation example. To try it out:
//   pnpm add @prisma/client prisma
//   npx prisma migrate dev --name init --schema ./examples/memory/prisma/schema.prisma
//   npx prisma generate --schema ./examples/memory/prisma/schema.prisma
//   pnpm start:prisma

import { Agent, run, withTrace } from '@openai/agents';
import { createPrismaSession } from './sessions';
import { createLookupCustomerProfileTool, fetchImageData } from './tools';

const directory: Record<string, string> = {
  '1': 'Customer 1 (tier gold). Notes: Prefers concise replies.',
  '2': 'Customer 2 (tier standard). Notes: Interested in tutorials.',
};

const lookupCustomerProfile = createLookupCustomerProfileTool({
  directory,
  transientErrorMessage:
    'Simulated transient CRM outage. Please retry the tool call.',
});

async function main() {
  await withTrace('memory:prisma:main', async () => {
    const { session, prisma } = await createPrismaSession();
    const agent = new Agent({
      name: 'Assistant',
      instructions:
        'You are a helpful assistant. Be VERY concise. For every user turn you must call lookup_customer_profile and fetch_image_data before responding.',
      tools: [lookupCustomerProfile, fetchImageData],
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
  });
}

async function mainStream() {
  await withTrace('memory:prisma:mainStream', async () => {
    const { session, prisma } = await createPrismaSession();
    const agent = new Agent({
      name: 'Assistant',
      instructions:
        'You are a helpful assistant. Be VERY concise. For every user turn you must call lookup_customer_profile and fetch_image_data before responding.',
      tools: [lookupCustomerProfile, fetchImageData],
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

      // Additional tool invocations happen earlier in the turn.
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });
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
