import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
