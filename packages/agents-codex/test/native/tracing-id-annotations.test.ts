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
  'tracing-id-annotations-child.ts',
);
for (const mode of [
  'ids',
  'receiver',
  'cancelled-callback',
  'automatic',
  'collision',
  'annotations',
  'restrictions',
  'invalid',
]) {
  it(`qualifies native tracing ID and annotation policy: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-tracing-policy-'));
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', child, mode],
        {
          timeout: 45_000,
          env: {
            ...process.env,
            OPENAI_API_KEY: '',
            CODEX_HOME: join(directory, 'home'),
          },
        },
      );
      expect(result.stdout).toContain(`PASS ${mode}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 50_000);
}
