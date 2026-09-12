export type PrismaCommand = 'db-push' | 'generate';

type PrismaInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const PRISMA_COMMAND_ARGS = {
  'db-push': ['prisma', 'db', 'push', '--schema', './prisma/schema.prisma'],
  generate: ['prisma', 'generate', '--schema', './prisma/schema.prisma'],
} as const satisfies Record<PrismaCommand, readonly string[]>;

export function getPrismaInvocation(
  command: PrismaCommand,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PrismaInvocation {
  const args = [...PRISMA_COMMAND_ARGS[command]];

  if (platform !== 'win32') {
    return { command: 'pnpm', args };
  }

  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"pnpm.cmd ${args.join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}
