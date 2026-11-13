import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'provider-response-span-id-child.ts',
);
for (const mode of [
  'host',
  'rounds',
  'plain',
  'invalid',
  'cancel',
  'retry',
  'cancel-io',
]) {
  it(`admits the owned native provider response span: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-response-span-'));
    const { OPENAI_API_KEY: _key, ...environment } = process.env;
    try {
      const result = await execute(
        '/usr/bin/env',
        [
          '-u',
          'OPENAI_API_KEY',
          process.execPath,
          '--import',
          'tsx',
          child,
          mode,
        ],
        {
          timeout: 45_000,
          env: { ...environment, CODEX_HOME: join(directory, 'home') },
        },
      );
      expect(result.stdout).toContain(`PASS response span ${mode}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 50_000);
}
