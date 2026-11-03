import process from 'node:process';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from '@typescript/typescript6';
import { loadConfig } from 'tsc-multi';
import { buildPackages } from './build-packages.mjs';

test('builds final conditional declaration graphs before dependents and propagates semantic failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-dual-build-'));
  const json = (file, value) => writeFileSync(file, JSON.stringify(value));
  const exports = {
    import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
    require: { types: './dist/index.d.ts', default: './dist/index.js' },
  };
  try {
    mkdirSync(join(root, 'node_modules/dual'), { recursive: true });
    json(join(root, 'node_modules/dual/package.json'), {
      name: 'dual',
      exports: {
        import: { types: './index.d.mts', default: './index.mjs' },
        require: { types: './index.d.ts', default: './index.js' },
      },
    });
    writeFileSync(
      join(root, 'node_modules/dual/index.d.mts'),
      `export declare const value: 'esm';`,
    );
    writeFileSync(
      join(root, 'node_modules/dual/index.d.ts'),
      `export declare const value: 'commonjs';`,
    );
    writeFileSync(
      join(root, 'node_modules/dual/index.mjs'),
      `export const value = 'esm';`,
    );
    writeFileSync(
      join(root, 'node_modules/dual/index.js'),
      `exports.value = 'commonjs';`,
    );
    for (const name of ['a', 'b']) {
      const directory = join(root, name);
      mkdirSync(join(directory, 'src'), { recursive: true });
      json(join(directory, 'package.json'), {
        name: `fixture-${name}`,
        exports,
      });
      json(join(directory, 'tsconfig.json'), {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          declaration: true,
          outDir: './dist',
          rootDir: './src',
          types: [],
          strict: true,
        },
      });
      writeFileSync(
        join(directory, 'src/index.ts'),
        `import {value as input} from '${name === 'a' ? 'dual' : 'fixture-a'}'; export const value = input;`,
      );
      symlinkSync(directory, join(root, 'node_modules', `fixture-${name}`));
    }
    json(join(root, 'tsc-multi.json'), {
      compiler: '@typescript/typescript6',
      projects: ['a/tsconfig.json', 'b/tsconfig.json'],
      targets: [
        { extname: '.mjs', module: 'esnext' },
        { extname: '.js', module: 'commonjs', moduleResolution: 'bundler' },
      ],
    });
    const config = {
      ...(await loadConfig({ cwd: root })),
      stdout: 'ignore',
      stderr: 'ignore',
    };
    assert.equal(await buildPackages(config), 0);
    const files = [];
    for (const [extension, literal] of [
      ['cts', 'commonjs'],
      ['mts', 'esm'],
    ]) {
      const file = join(root, `consumer.${extension}`);
      files.push(file);
      writeFileSync(
        file,
        `import {value} from 'fixture-b'; const result: '${literal}' = value; void result;`,
      );
    }
    const program = ts.createProgram(files, {
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      types: [],
      strict: true,
    });
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      [],
    );
    for (const [extension, source] of [
      [
        'cjs',
        `if(require('fixture-b').value !== 'commonjs') throw new Error('wrong CJS branch');`,
      ],
      [
        'mjs',
        `import {value} from 'fixture-b'; if(value !== 'esm') throw new Error('wrong ESM branch');`,
      ],
    ]) {
      const file = join(root, `runtime.${extension}`);
      writeFileSync(file, source);
      execFileSync(process.execPath, [file], { cwd: root });
    }
    // ESM succeeds, but CommonJS must still run its own semantic check.
    writeFileSync(
      join(root, 'b/src/index.ts'),
      `import {value} from 'fixture-a'; export const checked: 'esm' = value;`,
    );
    assert.notEqual(
      await buildPackages({ ...config, projects: ['b/tsconfig.json'] }),
      0,
    );
    assert.match(
      readFileSync(join(root, 'b/dist/index.d.mts'), 'utf8'),
      /checked: ['"]esm['"]/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
