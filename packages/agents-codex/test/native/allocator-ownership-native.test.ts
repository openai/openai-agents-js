import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
for (const mode of ['buffers', 'workers'] as const) {
  it(`qualifies private Rust allocator ownership: ${mode}`, async () => {
    const child = fileURLToPath(
      new URL('./fixtures/allocator-ownership-child.mjs', import.meta.url),
    );
    // Reuse telemetry.test.ts's real-process watchdog. GC belongs only to this
    // ownership qualification, never to either performance arm.
    const args = mode === 'buffers' ? ['--expose-gc'] : [];
    const result = await exec(process.execPath, [...args, child, mode], {
      timeout: 80_000,
      maxBuffer: 1024 * 1024,
    });
    const rows = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{"fixture":"allocator-ownership"'))
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode, status: 'passed' });
    if (mode === 'buffers') {
      expect(
        rows[0].cases.map((item: { bytes: number }) => item.bytes),
      ).toEqual([0, 17, 256 * 1024]);
      for (const item of rows[0].cases) {
        expect(item.httpRequests).toBe(1);
        expect(item.websocketGenerations).toBe(0);
        expect(item.collectedWrappers).toBe(item.nativeBuffers);
        if (item.bytes) expect(item.nativeBuffers).toBeGreaterThan(0);
      }
    } else {
      expect(rows[0]).toMatchObject({ naturalExits: 4, terminatedPending: 1 });
    }
  }, 90_000);
}
