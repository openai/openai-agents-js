import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startCounter } from '../../../../examples/codex/mcp-ui/server';

const directory = resolve(
  import.meta.dirname,
  '../../../../examples/codex/mcp-ui',
);
it.skipIf(process.env.OPENAI_AGENTS_BROWSER_TESTS !== '1')(
  'streams real native tool data and runs the official iframe tool bridge',
  async () => {
    expect(
      existsSync(resolve(directory, 'dist/client.js')),
      'Build examples/codex/mcp-ui first',
    ).toBe(true);
    const fixture = await startCounter();
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [resolve(directory, 'browser-check.mjs'), fixture.url],
        { timeout: 45000 },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        initialCount: 1,
        iframeCount: 2,
        terminal: 'Complete',
        wrongView: 403,
        foreignWindowIgnored: true,
      });
    } finally {
      await fixture.close();
    }
  },
  60000,
);
