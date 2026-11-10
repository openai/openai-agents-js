import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));

test('keeps the Classic Codex entry importable with a peer lacking native exports', async () => {
  const cache = join(root, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const temp = await mkdtemp(join(cache, 'codex-peer-'));
  try {
    const peer = join(temp, 'node_modules/@openai/agents');
    await mkdir(peer, { recursive: true });
    await writeFile(
      join(peer, 'package.json'),
      JSON.stringify({
        name: '@openai/agents',
        type: 'module',
        exports: { '.': './index.mjs', './classic': './classic.mjs' },
      }),
    );
    await writeFile(join(peer, 'index.mjs'), 'export const legacyPeer = true;');
    for (const name of ['agents-codex', 'agents-core']) {
      await symlink(
        join(root, 'packages', name),
        join(temp, 'node_modules/@openai', name),
        'junction',
      );
    }
    const classic = pathToFileURL(
      resolve(root, 'packages/agents/dist/classic/index.mjs'),
    ).href;
    await writeFile(
      join(peer, 'classic.mjs'),
      `export * from ${JSON.stringify(classic)};`,
    );
    const output = join(temp, 'codex.mjs');
    await build({
      entryPoints: [
        join(
          root,
          'packages/agents-extensions/src/experimental/codex/index.ts',
        ),
      ],
      outfile: output,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
    });
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { codexTool, nativeCodexTool } from ${JSON.stringify(pathToFileURL(output).href)};
      assert.equal(codexTool({ name: 'engineer' }).name, 'codex_engineer');
      assert.equal(nativeCodexTool({ name: 'engineer' }).name, 'codex_engineer');
      console.log('legacy peer import and declarations pass');
    `,
      ],
      { cwd: temp, timeout: 15000 },
    );
    expect(stdout.trim()).toBe('legacy peer import and declarations pass');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
