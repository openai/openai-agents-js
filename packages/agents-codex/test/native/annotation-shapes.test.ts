import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/annotation-shapes-child.ts',
);
for (const mode of [
  'classic',
  'array',
  'object',
  'nested',
  'string',
  'encoded',
  'unicode',
  'top-level',
  'outcome-array',
  'outcome-object',
  'outcome-nested',
  'outcome-string',
  'bounds',
  'otlp',
  'processor-large-export-bounded',
  'generic',
  'wide',
  'wide-queue',
  'combined',
  'combined-escaped',
  'collision',
  'carrier-host',
  'carrier-otlp',
  'redispatch-wide',
  'redispatch-root',
  'redispatch-queue',
  'redispatch-unrelated',
  'redispatch-root-queue',
  'redispatch-root-unrelated',
  'redispatch-configured',
  'redispatch-receipt',
  'redispatch-wide-legacy',
  'redispatch-root-legacy',
]) {
  it(
    'preserves bounded native annotation payloads: ' + mode,
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'agents-annotation-shapes-'),
      );
      try {
        const result = await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', child, mode],
          {
            timeout: 45000,
            maxBuffer: 2097152,
            env: {
              ...process.env,
              OPENAI_API_KEY: '',
              CODEX_HOME: join(directory, 'home'),
            },
          },
        );
        expect(result.stdout).toContain('PASS ' + mode);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    50000,
  );
}
