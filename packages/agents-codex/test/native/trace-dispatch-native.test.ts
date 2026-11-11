import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
it.each(['lifecycle', 'credentials', 'reentrant'])(
  'dispatches processor observations without live authority: %s',
  async (mode) => {
    const child = fileURLToPath(
      new URL('./fixtures/trace-dispatch-child.ts', import.meta.url),
    );
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', child, mode],
      { timeout: 30000, env: { ...process.env, OPENAI_API_KEY: '' } },
    );
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      mode,
      observations: 2,
    });
  },
  35000,
);
