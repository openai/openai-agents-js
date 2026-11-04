import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

function emptySeries(native: string, source: string, revision: string): void {
  const tree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], {
    cwd: source,
    encoding: 'utf8',
  }).trim();
  for (const name of ['patches', 'rmcp-patches']) {
    mkdirSync(join(native, name));
    writeFileSync(
      join(native, name, 'series.json'),
      JSON.stringify({ patches: [], result_tree: tree }),
    );
  }
  writeFileSync(
    join(native, 'Cargo.toml'),
    `rmcp = { git = "https://github.com/modelcontextprotocol/rust-sdk", rev = "${revision}", version = "=3.3.0" }\n`,
  );
  writeFileSync(join(native, 'build.rs'), 'fn main() {}\n');
  mkdirSync(join(native, 'rust'));
  writeFileSync(join(native, 'rust/lib.rs'), '// Build input.\n');
  mkdirSync(join(native, 'tests/fixtures'), { recursive: true });
  writeFileSync(
    join(native, 'tests/fixtures/exec_server.rs'),
    '// Executor fixture input.\n',
  );
}

describe('native source archive', () => {
  it('preserves Git blob bytes with autocrlf enabled and audits platform file modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-native-prepare-'));
    temporary.push(dir);
    const native = join(dir, 'agents', 'native');
    const scripts = join(dir, 'agents', 'scripts');
    const source = join(dir, 'source');
    for (const path of [native, scripts, source]) {
      mkdirSync(path, { recursive: true });
    }
    for (const file of [
      'native.mjs',
      'native-source.mjs',
      'native-receipt.mjs',
      'v8-release.json',
    ]) {
      copyFileSync(
        resolve(import.meta.dirname, '../scripts', file),
        join(scripts, file),
      );
    }
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    const text = 'first line\nsecond line\n';
    const binary = Buffer.from([0, 1, 10, 13, 255]);
    writeFileSync(join(source, 'source.rs'), text);
    writeFileSync(join(source, 'data.bin'), binary);
    writeFileSync(join(source, 'script.sh'), '#!/bin/sh\necho fixture\n');
    symlinkSync('source.rs', join(source, 'source-link'), 'file');
    git('-c', 'core.autocrlf=false', '-c', 'core.symlinks=true', 'add', '.');
    git('update-index', '--chmod=+x', 'script.sh');
    git(
      '-c',
      'user.name=Source fixture',
      '-c',
      'user.email=source@example.invalid',
      'commit',
      '--no-gpg-sign',
      '--quiet',
      '-m',
      'fixture',
    );
    const revision = git('rev-parse', 'HEAD');
    writeFileSync(join(native, 'CODEX_REVISION'), revision + '\n');
    emptySeries(native, source, revision);
    git('config', 'core.autocrlf', 'true');
    const command = (name: string, windows = false) =>
      execFileSync(
        process.execPath,
        [
          // Exercise Windows metadata handling on hosts with POSIX mode bits.
          ...(windows
            ? [
                '--import',
                'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})',
              ]
            : []),
          join(scripts, 'native.mjs'),
          name,
          '--source',
          source,
          '--rmcp-source',
          source,
        ],
        { stdio: 'pipe' },
      );
    command('prepare');
    const archive = join(native, '.upstream', 'codex');
    expect(readFileSync(join(archive, 'source.rs'), 'utf8')).toBe(text);
    expect(readFileSync(join(archive, 'data.bin'))).toEqual(binary);
    expect(readlinkSync(join(archive, 'source-link'))).toBe('source.rs');
    command('audit');
    if (process.platform !== 'win32') {
      chmodSync(join(archive, 'script.sh'), 0o644);
      expect(() => command('audit')).toThrow(/Modified: script.sh/);
    }
    command('audit', true);
    if (process.platform !== 'win32') {
      // Identical blob bytes cannot make a changed file type acceptable.
      rmSync(join(archive, 'source.rs'));
      symlinkSync(text, join(archive, 'source.rs'));
      expect(() => command('audit', true)).toThrow(/Modified: source.rs/);
      rmSync(join(archive, 'source.rs'));
      writeFileSync(join(archive, 'source.rs'), text);
    }
    writeFileSync(join(archive, 'source.rs'), text.replaceAll('\n', '\r\n'));
    expect(() => command('audit')).toThrow(/Native source audit failed/);
    expect(() => command('audit', true)).toThrow(/Modified: source.rs/);
    // A changed existing archive is never silently reconstructed.
    expect(() => command('prepare')).toThrow(/Native source audit failed/);
    expect(readFileSync(join(archive, 'source.rs'), 'utf8')).toBe(
      text.replaceAll('\n', '\r\n'),
    );
    expect(git('config', 'core.autocrlf')).toBe('true');
  });
});

describe('native source archive reviewed patches', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'agents reviewed source '));
    temporary.push(dir);
    const source = join(dir, 'source');
    const native = join(dir, 'agents/native');
    const scripts = join(dir, 'agents/scripts');
    for (const path of [source, native, scripts])
      mkdirSync(path, { recursive: true });
    for (const name of [
      'native.mjs',
      'native-source.mjs',
      'native-receipt.mjs',
      'v8-release.json',
    ])
      copyFileSync(
        resolve(import.meta.dirname, '../scripts', name),
        join(scripts, name),
      );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(source, 'source.rs'), 'original\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Source fixture',
      '-c',
      'user.email=source@example.invalid',
      'commit',
      '--no-gpg-sign',
      '--quiet',
      '-m',
      'base',
    );
    const revision = git('rev-parse', 'HEAD');
    writeFileSync(join(native, 'CODEX_REVISION'), revision + '\n');
    emptySeries(native, source, revision);
    const patches = join(native, 'patches');
    writeFileSync(join(source, 'source.rs'), 'reviewed\n');
    const patch = execFileSync(
      'git',
      ['diff', '--full-index', '--binary', 'HEAD'],
      { cwd: source, stdio: 'pipe' },
    );
    git('add', '.');
    const tree = git('write-tree');
    writeFileSync(join(patches, '0001-reviewed.patch'), patch);
    const manifest = {
      patches: [
        {
          path: '0001-reviewed.patch',
          sha256: createHash('sha256').update(patch).digest('hex'),
        },
      ],
      result_tree: tree,
    };
    const save = () =>
      writeFileSync(join(patches, 'series.json'), JSON.stringify(manifest));
    save();
    const command = (name: string) =>
      execFileSync(
        process.execPath,
        [
          join(scripts, 'native.mjs'),
          name,
          '--source',
          source,
          '--rmcp-source',
          source,
        ],
        { stdio: 'pipe' },
      );
    return { native, source, patches, manifest, save, command };
  }
  it('prepares the committed base plus reviewed bytes without changing the pristine cache or source checkout', () => {
    const { native, source, command } = fixture();
    command('prepare');
    expect(
      readFileSync(join(native, '.upstream/codex/source.rs'), 'utf8'),
    ).toBe('original\n');
    expect(
      readFileSync(join(native, '.upstream/reviewed-codex/source.rs'), 'utf8'),
    ).toBe('reviewed\n');
    expect(readFileSync(join(source, 'source.rs'), 'utf8')).toBe('reviewed\n');
    command('prepare');
    command('audit');
  });
  it.each([
    'missing patch',
    'wrong digest',
    'wrong result tree',
    'unlisted patch',
    'symlink patch',
    'duplicate patch',
    'unknown manifest field',
    'missing marker',
    'tampered reviewed bytes',
    'extra reviewed file',
  ])('rejects %s without repairing or qualifying the source', (failure) => {
    const { native, patches, manifest, save, command } = fixture();
    const reviewed = join(native, '.upstream/reviewed-codex');
    const existing = [
      'missing marker',
      'tampered reviewed bytes',
      'extra reviewed file',
    ].includes(failure);
    if (existing) command('prepare');
    if (failure === 'missing patch')
      rmSync(join(patches, '0001-reviewed.patch'));
    if (failure === 'wrong digest') {
      manifest.patches[0].sha256 = '0'.repeat(64);
      save();
    }
    if (failure === 'wrong result tree') {
      manifest.result_tree = '0'.repeat(40);
      save();
    }
    if (failure === 'unlisted patch')
      writeFileSync(join(patches, 'unlisted.patch'), 'unlisted');
    if (failure === 'symlink patch') {
      rmSync(join(patches, '0001-reviewed.patch'));
      symlinkSync('series.json', join(patches, '0001-reviewed.patch'));
    }
    if (failure === 'duplicate patch') {
      manifest.patches.push(manifest.patches[0]);
      save();
    }
    if (failure === 'unknown manifest field')
      writeFileSync(
        join(patches, 'series.json'),
        JSON.stringify({ ...manifest, execute: 'never' }),
      );
    if (failure === 'missing marker')
      rmSync(join(reviewed, '.sdk-reviewed-source.json'));
    if (failure === 'tampered reviewed bytes')
      writeFileSync(join(reviewed, 'source.rs'), 'tampered');
    if (failure === 'extra reviewed file')
      writeFileSync(join(reviewed, 'extra.rs'), 'extra');
    expect(() => command('prepare')).toThrow();
    if (existing) {
      if (failure === 'tampered reviewed bytes')
        expect(readFileSync(join(reviewed, 'source.rs'), 'utf8')).toBe(
          'tampered',
        );
      expect(() => command('audit')).toThrow();
    } else
      expect(() =>
        readFileSync(join(reviewed, '.sdk-reviewed-source.json')),
      ).toThrow();
  });
});

// The fixture substitutes executable Rust tools on PATH, using POSIX shebangs.
// Windows linking itself must be qualified on a Windows host.
describe.skipIf(process.platform === 'win32')(
  'native helper build selection',
  () => {
    it.each([
      ['x86_64-pc-windows-msvc', false, true],
      ['aarch64-pc-windows-msvc', true, false],
      ['x86_64-unknown-linux-gnu', false, false],
      ['x86_64-unknown-linux-gnu', true, true],
      ['aarch64-apple-darwin', false, false],
    ] as const)(
      'packages helpers and keeps the addon build independent (%s, configured target %s, timings %s)',
      (host, configured, timings) => {
        const dir = mkdtempSync(join(tmpdir(), 'agents-native-build-'));
        temporary.push(dir);
        const pkg = join(dir, 'agents');
        const native = join(pkg, 'native');
        const scripts = join(pkg, 'scripts');
        const tools = join(dir, 'tools');
        const source = join(dir, 'source');
        for (const path of [native, scripts, tools, source]) {
          mkdirSync(path, { recursive: true });
        }
        for (const name of [
          'native.mjs',
          'native-source.mjs',
          'native-receipt.mjs',
        ])
          copyFileSync(
            resolve(import.meta.dirname, '../scripts', name),
            join(scripts, name),
          );
        const git = (...args: string[]) =>
          execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
        git('init', '--quiet');
        const upstreamConfig = join(source, 'codex-rs', '.cargo');
        mkdirSync(upstreamConfig, { recursive: true });
        writeFileSync(
          join(upstreamConfig, 'config.toml'),
          '[target.\'cfg(all(windows, target_env = "msvc"))\']\nrustflags = ["-C", "target-feature=+crt-static"]\n',
        );
        git('add', '.');
        git(
          '-c',
          'user.name=Build fixture',
          '-c',
          'user.email=build@example.invalid',
          'commit',
          '--no-gpg-sign',
          '--quiet',
          '-m',
          'fixture',
        );
        writeFileSync(
          join(native, 'CODEX_REVISION'),
          git('rev-parse', 'HEAD') + '\n',
        );
        emptySeries(native, source, git('rev-parse', 'HEAD'));
        writeFileSync(
          join(native, 'Cargo.lock'),
          '[[package]]\nname = "v8"\nversion = "1.2.3"\n',
        );
        const windows = host.endsWith('-windows-msvc');
        const names = [
          windows
            ? `rusty_v8_ptrcomp_sandbox_release_${host}.lib.gz`
            : `librusty_v8_ptrcomp_sandbox_release_${host}.a.gz`,
          `src_binding_ptrcomp_sandbox_release_${host}.rs`,
        ];
        const cache = join(native, '.cache/v8');
        mkdirSync(cache, { recursive: true });
        const assets = names.map((name) => {
          writeFileSync(join(cache, name), name);
          return {
            name,
            digest: 'sha256:' + createHash('sha256').update(name).digest('hex'),
          };
        });
        writeFileSync(
          join(scripts, 'v8-release.json'),
          JSON.stringify({ version: '1.2.3', assets }),
        );
        const log = join(dir, 'cargo-builds.jsonl');
        writeFileSync(
          join(tools, 'rustc'),
          '#!/usr/bin/env node\nprocess.stdout.write("host: " + process.env.TEST_RUST_HOST + "\\n");\n',
          { mode: 0o755 },
        );
        writeFileSync(
          join(tools, 'cargo'),
          `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : process.env.CARGO_BUILD_TARGET;
const output = path.join(process.env.CARGO_TARGET_DIR, ...(target ? [target] : []), args.includes('--release') ? 'release' : 'debug');
const windows = process.env.TEST_RUST_HOST.endsWith('-windows-msvc');
const darwin = process.env.TEST_RUST_HOST.includes('-apple-');
fs.appendFileSync(process.env.TEST_CARGO_LOG, JSON.stringify({ args, output, jobs: process.env.CARGO_BUILD_JOBS }) + '\\n');
fs.mkdirSync(output, { recursive: true });
if (args.includes('--lib')) fs.writeFileSync(path.join(output, windows ? 'agents_codex.dll' : darwin ? 'libagents_codex.dylib' : 'libagents_codex.so'), 'addon without helper CRT flags');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') fs.writeFileSync(path.join(output, args[i + 1] + (windows ? '.exe' : '')), 'helper ' + args[i + 1], { mode: 0o755 });
  if (args[i] === '--example') {
    fs.mkdirSync(path.join(output, 'examples'), { recursive: true });
    fs.writeFileSync(path.join(output, 'examples', args[i + 1] + (windows ? '.exe' : '')), 'fixture', { mode: 0o755 });
  }
}
if (args[0] === 'build' && process.env.TEST_MUTATE_NATIVE === 'input') fs.appendFileSync(path.join(process.cwd(), 'rust/lib.rs'), '// Changed during build.\\n');
if (args[0] === 'build' && process.env.TEST_MUTATE_NATIVE === 'fixture') fs.appendFileSync(path.join(process.cwd(), 'tests/fixtures/exec_server.rs'), '// Changed fixture input.\\n');
if (args[0] === 'build' && process.env.TEST_MUTATE_NATIVE === 'source') fs.appendFileSync(path.join(process.cwd(), '.upstream/reviewed-codex/codex-rs/.cargo/config.toml'), '# changed\\n');
`,
          { mode: 0o755 },
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: tools + delimiter + process.env.PATH,
          TEST_RUST_HOST: host,
          TEST_CARGO_LOG: log,
          CARGO_TARGET_DIR: join(dir, 'target'),
        };
        delete env.CARGO_BUILD_TARGET;
        delete env.CARGO_BUILD_JOBS;
        env.OPENAI_AGENTS_NATIVE_TIMINGS = timings ? '1' : '0';
        if (timings) env.CARGO_BUILD_JOBS = '2';
        delete env.RUSTY_V8_ARCHIVE;
        delete env.RUSTY_V8_SRC_BINDING_PATH;
        if (configured) env.CARGO_BUILD_TARGET = host;
        const suffix = windows ? '.exe' : '';
        const bin = join(pkg, 'bin');
        const build = [
          'build',
          '--source',
          source,
          '--rmcp-source',
          source,
          '--release',
          '--test-fixture',
        ];
        for (const args of [
          ['prepare', '--source', source, '--rmcp-source', source],
          build,
        ]) {
          // Simulate an earlier checkout's six-helper build.
          if (args === build) {
            mkdirSync(bin, { recursive: true });
            writeFileSync(join(bin, 'local-notes.txt'), 'keep unrelated work');
            for (const alias of [
              'apply_patch',
              'applypatch',
              'codex-linux-sandbox',
              'codex-execve-wrapper',
            ]) {
              writeFileSync(join(bin, alias + suffix), 'old helper');
            }
          }
          execFileSync(
            process.execPath,
            [join(scripts, 'native.mjs'), ...args],
            { env, stdio: 'pipe' },
          );
        }
        const builds: { args: string[]; output: string; jobs?: string }[] =
          readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.args[0] === 'build');
        const commands = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(commands[0].args).toEqual([
          'clean',
          '--locked',
          '--package',
          'codex-agents-node',
          '--release',
        ]);
        for (const build of builds) {
          expect(build.args.includes('--timings')).toBe(timings);
          expect(build.jobs).toBe(timings ? '2' : undefined);
          expect(build.args).not.toContain('--jobs');
          expect(build.args).not.toContain('-j');
        }
        const addon = builds.find((build) => build.args.includes('--lib'))!;
        expect(addon.args).not.toContain('--config');
        expect(addon.args).not.toContain('--target');
        expect(addon.output).toBe(
          join(dir, 'target', ...(configured ? [host] : []), 'release'),
        );
        const helpers = builds.find((build) =>
          build.args.includes('codex-sdk-runtime'),
        )!;
        if (windows) {
          expect(builds).toHaveLength(2);
          expect(helpers.args).not.toContain('--lib');
          expect(helpers.args).toEqual(
            expect.arrayContaining([
              '--config',
              join(
                native,
                '.upstream/reviewed-codex/codex-rs/.cargo/config.toml',
              ),
              '--target',
              host,
            ]),
          );
          expect(helpers.output).toBe(join(dir, 'target', host, 'release'));
        } else {
          expect(builds).toHaveLength(1);
          expect(helpers).toBe(addon);
        }
        expect(readFileSync(join(native, 'codex.node'), 'utf8')).toBe(
          'addon without helper CRT flags',
        );
        const platform = windows
          ? 'win32'
          : host.includes('-apple-')
            ? 'darwin'
            : 'linux';
        const expected: Record<typeof platform, string[]> = {
          win32: ['codex-sdk-runtime', 'codex-code-mode-host'],
          darwin: [
            'codex-sdk-runtime',
            'codex-code-mode-host',
            'codex-execve-wrapper',
          ],
          linux: [
            'codex-sdk-runtime',
            'codex-code-mode-host',
            'codex-linux-sandbox',
            'codex-execve-wrapper',
          ],
        };
        const filenames = expected[platform].map((name) => name + suffix);
        const directoryContents = [...filenames, 'local-notes.txt'].sort();
        expect(readdirSync(bin).sort()).toEqual(directoryContents);
        for (const name of expected[platform].filter(
          (item) => item !== 'codex-code-mode-host',
        )) {
          expect(readFileSync(join(bin, name + suffix), 'utf8')).toBe(
            'helper codex-sdk-runtime',
          );
        }
        expect(
          readFileSync(
            join(pkg, 'bin', 'codex-code-mode-host' + suffix),
            'utf8',
          ),
        ).toBe('helper codex-code-mode-host');
        expect(
          readFileSync(
            join(native, 'test-bin', 'exec-server-fixture' + suffix),
            'utf8',
          ),
        ).toBe('fixture');
        const receipt = JSON.parse(
          readFileSync(join(native, 'build-receipt.json'), 'utf8'),
        );
        expect(receipt.inputs['native/tests/fixtures/exec_server.rs']).toBe(
          createHash('sha256')
            .update(readFileSync(join(native, 'tests/fixtures/exec_server.rs')))
            .digest('hex'),
        );
        expect(receipt.sources.codex.revision).toBe(git('rev-parse', 'HEAD'));
        expect(Object.keys(receipt.products).sort()).toEqual(
          [
            'native/codex.node',
            'native/test-bin/exec-server-fixture' + suffix,
            ...filenames.map((name) => 'bin/' + name),
          ].sort(),
        );
        for (const [name, digest] of Object.entries(receipt.products)) {
          expect(digest).toBe(
            'sha256:' +
              createHash('sha256')
                .update(readFileSync(join(pkg, name)))
                .digest('hex'),
          );
        }
        // Exercise the real CommonJS binding's runtime defaults for the same
        // simulated platform; the fixture Rust output cannot be loaded by Node.
        const compiled = {};
        const mod = {
          exports: {} as { _packaged_runtime(): Record<string, string> },
        };
        runInNewContext(
          readFileSync(
            resolve(import.meta.dirname, '../native/index.js'),
            'utf8',
          ),
          {
            require: (id: string) =>
              id === './codex.node' ? compiled : { join },
            module: mod,
            __dirname: native,
            process: { platform },
          },
        );
        const runtime = mod.exports._packaged_runtime();
        expect(Object.values(runtime).sort()).toEqual(
          filenames.map((name) => join(bin, name)).sort(),
        );
        expect(runtime).toHaveProperty(
          'codex_self_exe',
          join(bin, 'codex-sdk-runtime' + suffix),
        );
        expect(runtime).toHaveProperty(
          'code_mode_host_exe',
          join(bin, 'codex-code-mode-host' + suffix),
        );
        if (platform !== 'linux') {
          expect(runtime).not.toHaveProperty('codex_linux_sandbox_exe');
        }
        if (platform === 'win32') {
          expect(runtime).not.toHaveProperty('main_execve_wrapper_exe');
        }
        // Rebuilding an existing output removes newly stale aliases without
        // removing an unrelated file from the checkout.
        writeFileSync(join(bin, 'applypatch' + suffix), 'stale again');
        execFileSync(
          process.execPath,
          [join(scripts, 'native.mjs'), ...build],
          { env, stdio: 'pipe' },
        );
        expect(readdirSync(bin).sort()).toEqual(directoryContents);
        expect(readFileSync(join(bin, 'local-notes.txt'), 'utf8')).toBe(
          'keep unrelated work',
        );
        // A previous receipt cannot qualify a failed build with changed inputs.
        expect(() =>
          execFileSync(
            process.execPath,
            [join(scripts, 'native.mjs'), ...build],
            {
              env: { ...env, TEST_MUTATE_NATIVE: 'input' },
              stdio: 'pipe',
            },
          ),
        ).toThrow(/Native inputs changed/);
        expect(() =>
          readFileSync(join(native, 'build-receipt.json')),
        ).toThrow();
        expect(() =>
          execFileSync(
            process.execPath,
            [join(scripts, 'native.mjs'), ...build],
            {
              env: { ...env, TEST_MUTATE_NATIVE: 'fixture' },
              stdio: 'pipe',
            },
          ),
        ).toThrow(/Native inputs changed/);
        expect(() =>
          readFileSync(join(native, 'build-receipt.json')),
        ).toThrow();
        expect(() =>
          execFileSync(
            process.execPath,
            [join(scripts, 'native.mjs'), ...build],
            {
              env: { ...env, TEST_MUTATE_NATIVE: 'source' },
              stdio: 'pipe',
            },
          ),
        ).toThrow(/Native source audit failed/);
        expect(() =>
          readFileSync(join(native, 'build-receipt.json')),
        ).toThrow();
      },
      15_000,
    );
  },
);
