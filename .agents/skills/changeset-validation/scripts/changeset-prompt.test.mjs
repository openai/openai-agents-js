import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const source = fs.readFileSync(
  new URL('./changeset-prompt.mjs', import.meta.url),
  'utf8',
);
const templatePath =
  '.agents/skills/changeset-validation/references/validation-prompt.md';
const template = fs.readFileSync(
  new URL('../references/validation-prompt.md', import.meta.url),
  'utf8',
);

// Every process and filesystem operation in the generator is recorded or stubbed.
// Special-character fixtures never reach an operating-system process or Git object.
async function generate({ ci = false, failOptional = false } = {}) {
  const baseRef = 'base;literal&suffix';
  const headRef = 'topic$(literal)';
  const packageDir = "extra package;'$ &()";
  const packagePath = `packages/${packageDir}`;
  const changedFile = `${packagePath}/source file.ts`;
  const untrackedFile = `${packagePath}/new file.ts`;
  const changeset = '.changeset/example.md';
  const calls = [];
  const output = [];
  const errors = [];
  const writes = [];
  const files = new Map([
    [templatePath, template],
    [
      'packages/agents-core/package.json',
      '{"name":"@openai/agents-core","version":"1.0.0"}',
    ],
  ]);
  const sameArgs = (args, expected) =>
    JSON.stringify(args) === JSON.stringify(expected);
  function record(method, file, args, options) {
    assert.equal(file, 'git');
    assert.ok(Array.isArray(args));
    assert.ok(args.every((arg) => typeof arg === 'string'));
    assert.ok(!options.shell);
    calls.push({ method, args: Array.from(args) });
  }
  const childProcess = {
    execSync() {
      throw new Error('Shell execution is forbidden in this test');
    },
    execFileSync(file, args, options) {
      record('execFileSync', file, args, options);
      assert.equal(options.encoding, 'utf8');
      assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
      assert.equal(options.maxBuffer, 1024 * 1024);
      if (sameArgs(args, ['rev-parse', '--show-toplevel'])) return '/fixture\n';
      if (sameArgs(args, ['rev-parse', headRef])) {
        return 'head-sha\n';
      }
      if (sameArgs(args, ['merge-base', baseRef, headRef])) return 'base-sha\n';
      if (sameArgs(args, ['diff', '--name-status', 'base-sha', 'head-sha'])) {
        return `M\t${changedFile}\nA\t${changeset}\nM\tpackages/agents-core/package.json\n`;
      }
      if (sameArgs(args, ['diff', '--name-status', '--cached']))
        return `M\t${changedFile}\n`;
      if (sameArgs(args, ['diff', '--name-status']))
        return `M\t${changedFile}\n`;
      if (sameArgs(args, ['ls-files', '--others', '--exclude-standard']))
        return `${untrackedFile}\n`;
      if (sameArgs(args, ['diff', 'base-sha', 'head-sha', '--', packagePath]))
        return ' committed content \n';
      if (sameArgs(args, ['diff', '--cached', '--', packagePath]))
        return ' staged content \n';
      if (sameArgs(args, ['diff', '--', packagePath])) {
        if (failOptional) throw new Error('optional diff unavailable');
        return ' unstaged content \n';
      }
      if (
        sameArgs(args, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          changedFile,
        ])
      )
        return '';
      if (
        sameArgs(args, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          untrackedFile,
        ])
      )
        return `${untrackedFile}\n`;
      throw new Error(`Unexpected invocation: ${JSON.stringify(args)}`);
    },
    spawnSync(file, args, options) {
      record('spawnSync', file, args, options);
      if (sameArgs(args, ['show', `head-sha:${changeset}`])) {
        return {
          status: 0,
          stdout: '---\n"@openai/agents-core": patch\n---\n\nfix: example\n',
        };
      }
      if (
        args[0] === 'show' &&
        args[1].endsWith(':packages/agents-core/package.json')
      ) {
        return {
          status: 0,
          stdout: '{"name":"@openai/agents-core","version":"0.9.0"}',
        };
      }
      if (
        sameArgs(args, ['diff', '--no-index', '--', '/dev/null', untrackedFile])
      ) {
        return { status: 1, stdout: ' untracked content \n' };
      }
      throw new Error(`Unexpected invocation: ${JSON.stringify(args)}`);
    },
  };
  const context = createContext({
    process: {
      env: { CHANGESET_MAX_BUFFER_BYTES: String(1024 * 1024) },
      argv: [
        'node',
        'changeset-prompt.mjs',
        '--base',
        baseRef,
        '--head',
        headRef,
        ...(ci ? ['--ci', '--output', 'out/prompt.md'] : []),
      ],
      chdir: (dir) => assert.equal(dir, '/fixture'),
      exit: (code) => {
        output.push({ exitCode: code });
      },
    },
    console: {
      log: (message) => output.push(message),
      error: (message) => errors.push(message),
    },
  });
  const filesystem = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error('missing fixture');
      return files.get(file);
    },
    readdirSync: () => [{ name: 'agents-core', isDirectory: () => true }],
    existsSync: (file) => file === changedFile || file === untrackedFile,
    mkdirSync: (dir) => assert.equal(dir, 'out'),
    writeFileSync: (...args) => writes.push(args),
  };
  const modules = {
    fs: { default: filesystem },
    path: { default: path },
    child_process: childProcess,
  };
  const module = new SourceTextModule(source, { context });
  await module.link((name) => {
    const exports = modules[name];
    assert.ok(exports, `Unexpected import: ${name}`);
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports))
          this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return {
    calls,
    output,
    errors,
    writes,
    changedFile,
    untrackedFile,
    packageDir,
    changeset,
  };
}

test('preserves refs and package paths as argv data across local prompt sections', async () => {
  const result = await generate();
  assert.deepEqual(result.errors, []);
  assert.equal(result.calls.length, 15);
  const prompt = result.output[0];
  for (const section of ['Committed', 'Staged', 'Unstaged', 'Untracked']) {
    assert.ok(
      prompt.includes(
        `${section} diff (packages):\n${section.toLowerCase()} content`,
      ),
    );
  }
  assert.ok(prompt.includes(result.changedFile));
  assert.ok(prompt.includes(result.untrackedFile));
  assert.ok(prompt.includes(result.packageDir));
  assert.ok(prompt.includes(`File: ${result.changeset} (A)`));
  assert.ok(prompt.includes('fix: example'));
  assert.ok(!prompt.includes('packages/agents-core/package.json'));
});

test('CI prompt reads committed content and writes output without working-tree diffs', async () => {
  const result = await generate({ ci: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.calls.length, 8);
  assert.equal(result.writes.length, 1);
  const [file, prompt, encoding] = result.writes[0];
  assert.equal(file, 'out/prompt.md');
  assert.equal(encoding, 'utf8');
  assert.ok(prompt.includes('Committed diff (packages):\ncommitted content'));
  assert.ok(!prompt.includes('Staged diff (packages)'));
  assert.ok(!prompt.includes('Untracked diff (packages)'));
  assert.ok(prompt.endsWith('\n'));
});

test('optional Git failures omit only the unavailable diff section', async () => {
  const result = await generate({ failOptional: true });
  assert.deepEqual(result.errors, []);
  assert.ok(!result.output[0].includes('Unstaged diff (packages)'));
  assert.ok(
    result.output[0].includes('Untracked diff (packages):\nuntracked content'),
  );
});
