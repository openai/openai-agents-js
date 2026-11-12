import process from 'node:process';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import test from 'node:test';
import ts from '@typescript/typescript6';
import { loadConfig } from 'tsc-multi';
import { buildPackages, watchPackages } from './build-packages.mjs';

test('builds final conditional declaration graphs before dependents and propagates semantic failures', async () => {
  let watcher;
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
    // Watch starts from absent outputs and must keep both declaration graphs
    // current through dependency edits, compiler errors, and subsequent fixes.
    writeFileSync(
      join(root, 'b/src/index.ts'),
      `import {value} from 'fixture-a'; export const valueFromA = value;`,
    );
    for (const name of ['a', 'b'])
      rmSync(join(root, name, 'dist'), { recursive: true, force: true });
    const statuses = [];
    async function nextBuild() {
      const deadline = Date.now() + 60_000;
      while (!statuses.length) {
        assert.ok(Date.now() < deadline, 'Watch build did not finish');
        await delay(50);
      }
      return statuses.shift();
    }
    watcher = watchPackages(config, (status) => statuses.push(status));
    assert.equal(await nextBuild(), 0, 'clean initial watch build');
    assert.match(readFileSync(join(root, 'b/dist/index.d.mts'), 'utf8'), /esm/);
    assert.match(
      readFileSync(join(root, 'b/dist/index.d.ts'), 'utf8'),
      /commonjs/,
    );

    // A config change can move the source directory while watch is running.
    const aConfig = join(root, 'a/tsconfig.json');
    const aOptions = JSON.parse(readFileSync(aConfig, 'utf8'));
    const relocatedSource = join(root, 'a/relocated/index.ts');
    mkdirSync(join(root, 'a/relocated'));
    writeFileSync(relocatedSource, `export const value = 'relocated';`);
    aOptions.compilerOptions.rootDir = './relocated';
    aOptions.include = ['relocated'];
    json(aConfig, aOptions);
    assert.equal(await nextBuild(), 0, 'source directory change rebuild');
    assert.match(
      readFileSync(join(root, 'b/dist/index.d.mts'), 'utf8'),
      /relocated/,
    );

    writeFileSync(relocatedSource, `export const value = 'updated';`);
    assert.equal(await nextBuild(), 0, 'dependency change rebuild');
    for (const extension of ['d.mts', 'd.ts']) {
      assert.match(
        readFileSync(join(root, `b/dist/index.${extension}`), 'utf8'),
        /updated/,
      );
    }
    writeFileSync(
      join(root, 'b/src/index.ts'),
      `export const broken: number = 'invalid';`,
    );
    assert.notEqual(await nextBuild(), 0, 'semantic error is reported');
    writeFileSync(
      join(root, 'b/src/index.ts'),
      `import {value} from 'fixture-a'; export const recovered = value;`,
    );
    assert.equal(await nextBuild(), 0, 'watch recovers after semantic error');
    for (const extension of ['d.mts', 'd.ts']) {
      assert.match(
        readFileSync(join(root, `b/dist/index.${extension}`), 'utf8'),
        /recovered.*updated/,
      );
    }
  } finally {
    await watcher?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('builds and refreshes the shared modern Node Core graph in watch mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-core-node-build-'));
  const directory = join(root, 'packages/agents-core');
  let watcher;
  const json = (file, value) => writeFileSync(file, JSON.stringify(value));
  try {
    mkdirSync(join(directory, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@openai'), { recursive: true });
    symlinkSync(directory, join(root, 'node_modules/@openai/agents-core'));
    const exports = {};
    for (const [key, name] of [
      ['.', 'index'],
      ['./sandbox', 'sandbox'],
    ]) {
      exports[key] = {
        types: `./dist/${name}.d.ts`,
        node: { 'module-sync': `./dist/node/${name}.cjs` },
        require: `./dist/${name}.js`,
        import: `./dist/${name}.mjs`,
      };
    }
    json(join(directory, 'package.json'), {
      name: '@openai/agents-core',
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
      },
    });
    json(join(root, 'tsc-multi.json'), {
      compiler: '@typescript/typescript6',
      projects: ['packages/agents-core/tsconfig.json'],
      targets: [
        { extname: '.mjs', module: 'esnext' },
        { extname: '.js', module: 'commonjs', moduleResolution: 'bundler' },
      ],
    });
    for (const name of ['index', 'sandbox']) {
      writeFileSync(
        join(directory, `src/${name}.ts`),
        `export * from './manifest';`,
      );
    }
    writeFileSync(
      join(directory, 'src/index.ts'),
      `export * from './manifest'; export const readLazy = () => import('./lazy');`,
    );
    const source = join(directory, 'src/manifest.ts');
    const update = (value) => {
      writeFileSync(
        source,
        `export class Manifest {} export const value = '${value}';`,
      );
      writeFileSync(
        join(directory, 'src/lazy.ts'),
        `export const value = '${value}';`,
      );
    };
    update('initial');
    const config = {
      ...(await loadConfig({ cwd: root })),
      stdout: 'ignore',
      stderr: 'ignore',
    };
    function snapshot() {
      return execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        import * as esm from '@openai/agents-core';
        import * as sandbox from '@openai/agents-core/sandbox';
        const require = createRequire(import.meta.url);
        const common = require('@openai/agents-core');
        assert.equal(esm.Manifest, common.Manifest);
        assert.equal(sandbox.Manifest, common.Manifest);
        assert.equal(esm.default, common);
        assert.equal(esm.__esModule, true);
        assert.deepEqual(Object.getOwnPropertySymbols(common), []);
        assert.equal(Object.prototype.toString.call(common), '[object Object]');
        process.stdout.write(esm.value);
      `,
        ],
        { cwd: root, encoding: 'utf8' },
      );
    }
    assert.equal(await buildPackages(config), 0);
    assert.equal(snapshot(), 'initial');
    rmSync(join(directory, 'dist'), { recursive: true });
    const statuses = [];
    async function nextBuild() {
      const deadline = Date.now() + 60_000;
      while (!statuses.length) {
        assert.ok(Date.now() < deadline, 'Core watch build did not finish');
        await delay(50);
      }
      return statuses.shift();
    }
    watcher = watchPackages(config, (status) => statuses.push(status));
    assert.equal(await nextBuild(), 0);
    assert.equal(snapshot(), 'initial');
    const held = createRequire(import.meta.url)(
      join(directory, 'dist/node/index.cjs'),
    );
    update('updated');
    assert.equal(await nextBuild(), 0);
    assert.equal(snapshot(), 'updated');
    assert.equal((await held.readLazy()).value, 'initial');
  } finally {
    await watcher?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
