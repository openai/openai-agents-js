import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Real package export maps and built artifacts; no Vitest source aliases.
it.each(['module', 'commonjs'])(
  'published sandbox %s import keeps old exports without addon/cloud/process loading',
  (format) => {
    const load = format === 'module' ? 'await import' : 'require';
    const code = `const sandbox = ${load}('@openai/agents/sandbox');
    const classic = ${load}('@openai/agents/classic/sandbox');
    if (typeof sandbox.sandboxEnvironment !== 'function' || typeof sandbox.renderStorageLayout !== 'function') throw Error('Missing native adapter export');
    if (typeof sandbox.Manifest !== 'function' || typeof classic.SandboxAgent !== 'function' || 'sandboxEnvironment' in classic) throw Error('Legacy sandbox export changed');
    process.stdout.write('qualified');`;
    const output = execFileSync(
      process.execPath,
      [
        '--require',
        resolve(import.meta.dirname, 'fixtures/sandbox-import-guard.cjs'),
        `--input-type=${format}`,
        '-e',
        code,
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    expect(output).toBe('qualified');
  },
);
