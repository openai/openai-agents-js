import { spawnSync } from 'node:child_process';

const prismaSchemaPath = './prisma/schema.prisma';
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function runPrismaCommand(args: string[]) {
  const result = spawnSync(pnpmCommand, ['prisma', ...args], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    throw new Error(`Prisma command terminated with signal ${result.signal}.`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./dev.db';
    console.warn(
      'DATABASE_URL was not set. Defaulting to sqlite db at file:./dev.db',
    );
  }

  runPrismaCommand(['db', 'push', '--schema', prismaSchemaPath]);
  runPrismaCommand(['generate', '--schema', prismaSchemaPath]);

  await import('./prisma');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
