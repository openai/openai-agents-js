import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardPath = join(rootDir, 'helpers/tests/console-guard.ts');
const guardCorePath = join(rootDir, 'helpers/tests/stdioGuard.ts');
const vitestPath = join(rootDir, 'node_modules/vitest/vitest.mjs');
const temporaryDirectories: string[] = [];

async function runFixture(
  files: Record<string, string>,
  options: {
    env?: Record<string, string>;
    globalSetup?: string;
  } = {},
) {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'agents-stdio-guard-'));
  temporaryDirectories.push(fixtureDir);
  await Promise.all([
    ...Object.entries(files).map(([name, contents]) =>
      writeFile(join(fixtureDir, name), contents),
    ),
    writeFile(
      join(fixtureDir, 'console-guard.ts'),
      await readFile(guardPath, 'utf8'),
    ),
    writeFile(
      join(fixtureDir, 'stdioGuard.ts'),
      await readFile(guardCorePath, 'utf8'),
    ),
    symlink(
      join(rootDir, 'node_modules'),
      join(fixtureDir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    ),
  ]);
  const configPath = join(fixtureDir, 'vitest.config.ts');
  await writeFile(
    configPath,
    `export default { test: { include: ['*.test.ts'], maxWorkers: 1, minWorkers: 1, setupFiles: ['./console-guard.ts']${options.globalSetup ? `, globalSetup: ${JSON.stringify(options.globalSetup)}` : ''} } };\n`,
  );
  return execa(process.execPath, [vitestPath, 'run', '--config', configPath], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      TEST_STDIO_MODE: 'error',
      ...options.env,
    },
    reject: false,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('test stdout/stderr guard', () => {
  it('fails on output from file-scoped fixture cleanup', async () => {
    const result = await runFixture({
      'fixture-cleanup.test.ts': `
        import { expect, test as base } from 'vitest';

        const test = base.extend({
          resource: [
            async ({}, use) => {
              await use('ready');
              process.stderr.write('FILE_FIXTURE_CLEANUP_OUTPUT');
            },
            { auto: true, scope: 'file' },
          ],
        });

        test('uses the fixture', ({ resource }) => {
          expect(resource).toBe('ready');
        });
      `,
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Unexpected stdout/stderr during test',
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'FILE_FIXTURE_CLEANUP_OUTPUT',
    );
  });

  it('fails on console.dir and console.dirxml output', async () => {
    const result = await runFixture({
      'console-methods.test.ts': `
        import { test } from 'vitest';
        test('dir', () => console.dir({ marker: 'CONSOLE_DIR_OUTPUT' }));
        test('dirxml', () => console.dirxml({ marker: 'CONSOLE_DIRXML_OUTPUT' }));
      `,
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'CONSOLE_DIR_OUTPUT',
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'CONSOLE_DIRXML_OUTPUT',
    );
  });

  it('fails on output from global setup imports', async () => {
    const result = await runFixture(
      {
        'global-setup.ts': `
          import { guardGlobalSetup } from './stdioGuard';
          export function setup() {
            return guardGlobalSetup(async () => {
              await import('./actual-global-setup');
            });
          }
        `,
        'actual-global-setup.ts': `
          import './noisy-global-import';
        `,
        'noisy-global-import.ts': `
          console.error('GLOBAL_SETUP_IMPORT_OUTPUT');
        `,
        'sample.test.ts': `
          import { test } from 'vitest';
          test('sample', () => {});
        `,
      },
      { globalSetup: './global-setup.ts' },
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'GLOBAL_SETUP_IMPORT_OUTPUT',
    );
  });

  it('fails on output from global teardown', async () => {
    const result = await runFixture(
      {
        'global-setup.ts': `
          import { guardGlobalSetup } from './stdioGuard';
          export function setup() {
            return guardGlobalSetup(async () => {
              return () => console.error('GLOBAL_TEARDOWN_OUTPUT');
            });
          }
        `,
        'sample.test.ts': `
          import { test } from 'vitest';
          test('sample', () => {});
        `,
      },
      { globalSetup: './global-setup.ts' },
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'GLOBAL_TEARDOWN_OUTPUT',
    );
  });

  it('preserves warn-mode output across test files', async () => {
    const result = await runFixture(
      {
        'first.test.ts': `
          import { test } from 'vitest';
          test('first', () => console.warn('FIRST_WARN_OUTPUT'));
        `,
        'second.test.ts': `
          import { test } from 'vitest';
          test('second', () => console.warn('SECOND_WARN_OUTPUT'));
        `,
      },
      { env: { TEST_STDIO_MODE: 'warn' } },
    );

    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('Unexpected stdout/stderr during test: first');
    expect(output).toContain('console.warn: FIRST_WARN_OUTPUT');
    expect(output).toContain('Unexpected stdout/stderr during test: second');
    expect(output).toContain('console.warn: SECOND_WARN_OUTPUT');
  });

  it('allows output without diagnostics when the guard is off', async () => {
    const result = await runFixture(
      {
        'off.test.ts': `
          import { test } from 'vitest';
          test('off', () => console.log('OFF_MODE_OUTPUT'));
        `,
      },
      { env: { TEST_STDIO_MODE: 'off' } },
    );

    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('OFF_MODE_OUTPUT');
    expect(output).not.toContain('Unexpected stdout/stderr');
  });

  it('fails on output for an unknown mode', async () => {
    const result = await runFixture(
      {
        'unknown.test.ts': `
          import { test } from 'vitest';
          test('unknown', () => process.stdout.write('UNKNOWN_MODE_OUTPUT'));
        `,
      },
      { env: { TEST_STDIO_MODE: 'unknown' } },
    );

    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('Unexpected stdout/stderr during test: unknown');
    expect(output).toContain('stdout.write: UNKNOWN_MODE_OUTPUT');
  });
});
