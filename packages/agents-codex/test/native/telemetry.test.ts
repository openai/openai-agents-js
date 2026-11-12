import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
for (const mode of [
  'completion-decisions',
  'completion-decisions-disabled',
  'completion-decisions-unknown',
  'completion-decisions-refusal',
  'processor-handlers',
  'external-parent-export',
  'lifecycle',
  'preclaim',
  'late',
  'postclaim',
  'race',
  'payload',
  'default-payload',
  'failed-export',
  'workers',
]) {
  it(`owns native telemetry: ${mode}`, async () => {
    const child = fileURLToPath(
      new URL('./fixtures/telemetry-child.ts', import.meta.url),
    );
    // External watchdog also catches an addon teardown that leaves the child alive.
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', child, mode],
      { timeout: 45_000, maxBuffer: 1024 * 1024 },
    );
    expect(result.stdout).toContain(`PASS ${mode}`);
  }, 50_000);
}
