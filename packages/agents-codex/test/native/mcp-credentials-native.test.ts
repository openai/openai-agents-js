import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// Run the credential lifecycle in an isolated Node process.
const run = promisify(execFile);
it.each(['literal'] as const)(
  'keeps %s MCP credentials out of checkpoints and uses current authority after replacement and restore',
  async (credential) => {
    const { stdout } = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(import.meta.dirname, 'fixtures/mcp-credentials.ts'),
        credential,
      ],
      { timeout: 25_000, maxBuffer: 1024 * 1024 },
    );
    expect(JSON.parse(stdout)).toEqual({ credential, result: 'ok' });
  },
  30_000,
);
