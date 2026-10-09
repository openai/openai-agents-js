import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { setup } from './setup';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const repositoryRoot = process.cwd();
const dependabotConfig = await fs.readFile(
  path.join(repositoryRoot, '.github/dependabot.yml'),
  'utf8',
);
const fixtureDirectories = [
  ...dependabotConfig.matchAll(/"\/integration-tests\/([^"\n]+)"/g),
].map((match) => match[1]);

let temporaryRoot: string;
let originals: Map<string, Buffer>;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(tmpdir(), 'agents-registry-'));
  originals = new Map();
  for (const directory of fixtureDirectories) {
    const file = path.join(
      temporaryRoot,
      'integration-tests',
      directory,
      '.npmrc',
    );
    const content = Buffer.from(
      '# Custom fixture configuration\n@openai:registry=https://registry.npmjs.org\npackage-lock=false',
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    originals.set(file, content);
  }
  vi.spyOn(process, 'cwd').mockReturnValue(temporaryRoot);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
  vi.mocked(writeFile).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(writeFile).mockImplementation(fs.writeFile);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

async function expectOriginals() {
  for (const [file, content] of originals) {
    expect(await fs.readFile(file)).toEqual(content);
  }
}

describe('integration registry setup', () => {
  it('keeps every hosted updater on public npm without a custom registry', async () => {
    expect(fixtureDirectories).toHaveLength(13);
    expect(dependabotConfig).not.toMatch(/^registries:/m);
    expect(dependabotConfig).not.toContain('registries: [');
    for (const directory of fixtureDirectories) {
      const config = await fs.readFile(
        path.join(repositoryRoot, 'integration-tests', directory, '.npmrc'),
        'utf8',
      );
      expect(config).toContain('@openai:registry=https://registry.npmjs.org');
      expect(config).not.toContain('localhost');
    }
  });

  it('routes all fixtures locally for a run, then restores exact original bytes', async () => {
    const teardown = await setup();
    for (const file of originals.keys()) {
      expect(await fs.readFile(file, 'utf8')).toContain(
        '\n@openai:registry=http://localhost:4873\n',
      );
    }
    // Verify npm's effective configuration, including duplicate-key precedence.
    const fixture = path.join(temporaryRoot, 'integration-tests/node');
    expect(
      execFileSync('npm', ['config', 'get', '@openai:registry'], {
        cwd: fixture,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim(),
    ).toBe('http://localhost:4873');
    await teardown();
    await expectOriginals();
  });

  it('does not edit fixtures when the registry is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 503 } as Response);
    await expect(setup()).rejects.toThrow('Local npm registry not running');
    expect(writeFile).not.toHaveBeenCalled();
    await expectOriginals();
  });

  it('reads all originals before performing any writes', async () => {
    await fs.rm([...originals.keys()].at(-1)!);
    await expect(setup()).rejects.toThrow();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('restores partial writes when setup fails', async () => {
    const failure = new Error('Fixture write failed');
    vi.mocked(writeFile)
      .mockImplementationOnce(fs.writeFile)
      .mockImplementationOnce(async (file) => {
        await fs.writeFile(file, 'partial');
        throw failure;
      });
    await expect(setup()).rejects.toBe(failure);
    await expectOriginals();
  });

  it('attempts every restoration and preserves setup and cleanup errors', async () => {
    const setupFailure = new Error('Fixture write failed');
    const cleanupFailure = new Error('Fixture restoration failed');
    vi.mocked(writeFile)
      .mockImplementationOnce(fs.writeFile)
      .mockRejectedValueOnce(setupFailure)
      .mockRejectedValueOnce(cleanupFailure);
    const error = await setup().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBe(setupFailure);
    const errors = (error as AggregateError).errors;
    expect(errors[0]).toBe(setupFailure);
    expect((errors[1] as AggregateError).errors).toContain(cleanupFailure);
    const secondFile = [...originals.keys()][1];
    expect(await fs.readFile(secondFile)).toEqual(originals.get(secondFile));
    expect(writeFile).toHaveBeenCalledTimes(4);
  });
});
