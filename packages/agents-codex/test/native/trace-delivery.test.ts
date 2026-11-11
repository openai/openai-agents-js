import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
for (const mode of [
  'flush-trigger',
  'timer',
  'overflow-count',
  'overflow-bytes',
  'invalid',
]) {
  it(`applies native trace delivery controls: ${mode}`, async () => {
    const child = fileURLToPath(
      new URL('./fixtures/trace-delivery-child.ts', import.meta.url),
    );
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', child, mode],
      {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.stdout).toContain(`PASS ${mode}`);
  }, 25_000);
}
