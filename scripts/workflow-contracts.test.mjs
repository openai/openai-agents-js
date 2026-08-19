import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe('repository workflow contracts', () => {
  it('exposes the example lifecycle through pnpm scripts without rerun state', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    const workflowScript = await readFile(
      path.join(repositoryRoot, 'scripts', 'run-examples-workflow.sh'),
      'utf8',
    );
    const exampleRunner = await readFile(
      path.join(repositoryRoot, 'scripts', 'run-example-starts.mjs'),
      'utf8',
    );

    expect(packageJson.scripts).toMatchObject({
      'examples:workflow': 'bash scripts/run-examples-workflow.sh',
      'examples:workflow:start': 'bash scripts/run-examples-workflow.sh start',
      'examples:workflow:status':
        'bash scripts/run-examples-workflow.sh status',
      'examples:workflow:stop': 'bash scripts/run-examples-workflow.sh stop',
      'examples:workflow:logs': 'bash scripts/run-examples-workflow.sh logs',
      'examples:workflow:tail': 'bash scripts/run-examples-workflow.sh tail',
      'test:integration':
        'cross-env NODE_ENV=test vitest run --config=vitest.integration.config.ts',
      'test:integration:managed':
        'node scripts/run-integration-tests-managed.mjs',
    });
    expect(workflowScript).toContain(
      'EXAMPLES_INTERACTIVE_MODE="${EXAMPLES_INTERACTIVE_MODE:-auto}"',
    );
    expect(workflowScript).toContain(
      'EXAMPLES_CONCURRENCY="${EXAMPLES_CONCURRENCY:-4}"',
    );
    expect(workflowScript).toContain(
      'EXAMPLES_INCLUDE_SERVER="${EXAMPLES_INCLUDE_SERVER:-0}"',
    );
    expect(workflowScript).toContain(
      'EXAMPLES_INCLUDE_AUDIO="${EXAMPLES_INCLUDE_AUDIO:-0}"',
    );
    expect(workflowScript).toContain(
      'EXAMPLES_INCLUDE_EXTERNAL="${EXAMPLES_INCLUDE_EXTERNAL:-0}"',
    );
    expect(workflowScript).toContain('--include-interactive');
    expect(workflowScript).toContain('--background');
    expect(workflowScript).toContain('start|stop|status|logs|tail');
    expect(packageJson.scripts).not.toHaveProperty('examples:workflow:rerun');
    expect(packageJson.scripts).not.toHaveProperty('examples:workflow:collect');
    expect(workflowScript).not.toContain('.tmp/examples-rerun.txt');
    expect(exampleRunner).not.toContain('collectRerunFromLog');
    expect(exampleRunner).not.toContain("arg === '--collect'");
  });

  it('retains only a read-only example analysis skill', async () => {
    const skillsRoot = path.join(repositoryRoot, '.agents', 'skills');
    const analysisSkill = path.join(skillsRoot, 'examples-run-analysis');
    const skillEntries = await readdir(analysisSkill);
    const skillText = await readFile(
      path.join(analysisSkill, 'SKILL.md'),
      'utf8',
    );

    expect(skillEntries.sort()).toEqual(['SKILL.md', 'agents']);
    expect(await pathExists(path.join(skillsRoot, 'examples-auto-run'))).toBe(
      false,
    );
    expect(await pathExists(path.join(skillsRoot, 'integration-tests'))).toBe(
      false,
    );
    expect(skillText).toContain('this skill never owns execution or cleanup.');
    expect(skillText).toContain('Never invoke pnpm');
    expect(skillText).toContain(
      'run or finish `pnpm examples:workflow:start` manually',
    );
    expect(skillText).not.toContain('examples:workflow:rerun');
    expect(skillText).not.toContain('.tmp/examples-rerun.txt');
    expect(skillEntries).not.toContain('scripts');
  });

  it('starts no example child when service-account provenance is invalid', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'examples-workflow-test-'),
    );
    const fakePnpm = path.join(temporaryDirectory, 'pnpm');
    const sentinel = path.join(temporaryDirectory, 'pnpm-started');
    await writeFile(
      fakePnpm,
      '#!/usr/bin/env bash\ntouch "$FAKE_PNPM_SENTINEL"\n',
      'utf8',
    );
    await chmod(fakePnpm, 0o755);

    try {
      const result = spawnSync(
        '/bin/bash',
        [
          path.join(repositoryRoot, 'scripts', 'run-examples-workflow.sh'),
          'start',
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PATH: `${temporaryDirectory}:/usr/bin:/bin`,
            FAKE_PNPM_SENTINEL: sentinel,
            OPENAI_API_KEY: 'untrusted-key',
            OPENAI_API_KEY_SOURCE: 'employee',
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(78);
      expect(result.stderr).toContain(
        'Refusing to run examples without OPENAI_API_KEY_SOURCE=service-account.',
      );
      expect(await pathExists(sentinel)).toBe(false);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('refuses to signal a stale unowned background pid', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'examples-stale-pid-test-'),
    );
    const stateDirectory = path.join(temporaryDirectory, 'state');
    const pidFile = path.join(stateDirectory, 'examples-auto-run.pid');
    const fakeBin = path.join(temporaryDirectory, 'bin');
    const fakePs = path.join(fakeBin, 'ps');
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      fakePs,
      '#!/usr/bin/env bash\nif [[ "$*" == *"-o command="* ]]; then printf "unrelated process\\n"; fi\n',
      'utf8',
    );
    await chmod(fakePs, 0o755);

    try {
      await writeFile(pidFile, `${process.pid} stale-token ready\n`, 'utf8');
      const stop = spawnSync(
        '/bin/bash',
        [
          path.join(repositoryRoot, 'scripts', 'run-examples-workflow.sh'),
          'stop',
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            EXAMPLES_WORKFLOW_STATE_DIR: stateDirectory,
          },
          encoding: 'utf8',
        },
      );

      expect(stop.status).toBe(1);
      expect(stop.stderr).toContain('Refusing to signal unowned pid');
      expect(await pathExists(pidFile)).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
