import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { buildEsmDeclarations } from './build-esm-declarations.mjs';

test('ESM declarations follow emitted modules without rewriting literal types or CommonJS imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-esm-declarations-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'index.mjs'), '');
    writeFileSync(join(root, 'value.mjs'), '');
    writeFileSync(
      join(root, 'nested/parent.d.ts'),
      `export type Parent = import('..').Root;`,
    );
    writeFileSync(join(root, 'nested/index.mjs'), '');
    writeFileSync(join(root, 'native.js'), '');
    const source = `// Keep './value' in comments.
import { Value } from './value';
export * as Nested from './nested';
export type Dynamic = import('./value.js').Value;
export type Native = import('./native.js').Native;
export type External = import('external').External;
export type Literal = './value';
export type Self = import('.').Root;
`;
    writeFileSync(join(root, 'index.d.ts'), source);
    buildEsmDeclarations(root);
    assert.equal(readFileSync(join(root, 'index.d.ts'), 'utf8'), source);
    assert.equal(
      readFileSync(join(root, 'nested/parent.d.mts'), 'utf8'),
      `export type Parent = import('../index.mjs').Root;`,
    );
    assert.equal(
      readFileSync(join(root, 'index.d.mts'), 'utf8'),
      `// Keep './value' in comments.
import { Value } from './value.mjs';
export * as Nested from './nested/index.mjs';
export type Dynamic = import('./value.mjs').Value;
export type Native = import('./native.js').Native;
export type External = import('external').External;
export type Literal = './value';
export type Self = import('./index.mjs').Root;
`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the standalone generator emits declarations for every configured package', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-standalone-declarations-'));
  try {
    const script = join(root, 'scripts', 'build-esm-declarations.mjs');
    mkdirSync(dirname(script));
    copyFileSync(
      new URL('./build-esm-declarations.mjs', import.meta.url),
      script,
    );
    const config = join(root, 'tsc-multi.json');
    copyFileSync(new URL('../tsc-multi.json', import.meta.url), config);
    symlinkSync(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'junction',
    );
    const { projects } = JSON.parse(readFileSync(config, 'utf8'));
    const outputs = projects.map((project) =>
      join(root, dirname(project), 'dist'),
    );
    const declaration = 'export type Value = string;\n';
    for (const output of outputs) {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'index.d.ts'), declaration);
    }

    execFileSync(process.execPath, [script]);
    for (const output of outputs) {
      assert.equal(
        readFileSync(join(output, 'index.d.mts'), 'utf8'),
        declaration,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
