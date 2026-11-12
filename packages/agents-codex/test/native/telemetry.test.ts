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
  'lifecycle',
  'restart',
  'restart-credentials',
  'restart-diagnostics-omitted',
  'restart-diagnostics-null',
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
    if (mode.startsWith('restart-diagnostics-')) {
      const [before, after] = result.stdout.split(
        'DIAGNOSTICS_RESTART_BOUNDARY',
      );
      expect(after).toBeDefined();
      const records = (output: string) =>
        output.split('\n').flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return value.kind === 'native_diagnostic' ? [value] : [];
          } catch {
            return [];
          }
        });
      expect(JSON.stringify(records(before!))).toContain(
        'DIAGNOSTICS_ENABLED_PAYLOAD',
      );
      expect(records(after!)).toEqual([]);
    }
  }, 50_000);
}
