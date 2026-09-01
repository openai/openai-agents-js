import { describe, expect, it } from 'vitest';
import { getPrismaInvocation } from '../../examples/memory/prisma-command';

describe('Prisma memory example command invocation', () => {
  it('spawns pnpm directly off Windows', () => {
    expect(getPrismaInvocation('db-push', 'linux', {})).toEqual({
      command: 'pnpm',
      args: ['prisma', 'db', 'push', '--schema', './prisma/schema.prisma'],
    });
  });

  it('runs the pnpm.cmd shim through cmd.exe on Windows', () => {
    expect(getPrismaInvocation('generate', 'win32', {})).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"pnpm.cmd prisma generate --schema ./prisma/schema.prisma"',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it('honors ComSpec on Windows', () => {
    expect(
      getPrismaInvocation('db-push', 'win32', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      }),
    ).toMatchObject({
      command: 'C:\\Windows\\System32\\cmd.exe',
    });
  });
});
