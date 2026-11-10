import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('preserves original native root metadata through retained contexts, callbacks and restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-root-metadata-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: join(directory, 'home'),
  };
  delete env.OPENAI_API_KEY;
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        join(
          dirname(fileURLToPath(import.meta.url)),
          'fixtures/tracing-metadata-child.ts',
        ),
      ],
      { timeout: 50_000, maxBuffer: 2_097_152, env },
    );
    expect(result.stdout).toContain('PASS native root metadata ownership');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
