import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const child = fileURLToPath(
  new URL('./fixtures/tracing-borrowed-context-child.ts', import.meta.url),
);
it.each(['lifecycle', 'native-work', 'privacy'])(
  'qualifies retained native trace context: %s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-borrowed-trace-'));
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', child, mode],
        {
          timeout: 45000,
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
  },
  50000,
);
