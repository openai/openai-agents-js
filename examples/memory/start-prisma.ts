import { spawnSync } from 'node:child_process';
import {
  getPrismaInvocation,
  type PrismaCommand,
} from './prisma-command';

function runPrismaCommand(command: PrismaCommand) {
  const invocation = getPrismaInvocation(command);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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

  runPrismaCommand('db-push');
  runPrismaCommand('generate');

  await import('./prisma');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
