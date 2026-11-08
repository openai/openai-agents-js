import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// A child process owns native telemetry: configuration and shutdown are process-global.
it.runIf(process.env.OPENAI_AGENTS_NATIVE_TESTS === '1')(
  'preserves real native ancestry privacy for bounded speech payloads',
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL('./native/fixtures/voice-tracing-child.ts', import.meta.url),
        ),
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    expect(stdout).toContain('native voice trace privacy passed');
  },
  20000,
);
