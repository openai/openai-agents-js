import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it('drains blocked native interception and MCP reads on revoke or owner close across fresh threads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-readers-'));
  try {
    const home = join(directory, 'home');
    const cwd = join(directory, 'work');
    await Promise.all([mkdir(home), mkdir(cwd)]);
    const module = createRequire(import.meta.url).resolve(
      '../../native/index.js',
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const { setTimeout } = require('node:timers/promises');
      const { join } = require('node:path');
      const native = require(process.argv[1]);
      const home = process.argv[2];
      const cwd = process.argv[3];
      (async () => {
        const config = {
          model: 'gpt-5.1-codex', approval_policy: 'never',
          sandbox_mode: 'danger-full-access', web_search: 'disabled',
          'analytics.enabled': false, 'features.shell_snapshot': false,
        };
        const runtime = { codex_home: home, cwd, strict_config: true, loader: {
          managed_config_path: join(home, 'managed.toml'), system_config_path: join(home, 'system.toml'),
          system_requirements_path: join(home, 'requirements.toml'),
          ignore_user_config: true, ignore_project_config: true,
        } };
        const engine = await native.create_engine(JSON.stringify(config), JSON.stringify(runtime), 'synthetic-reader-test-key');
        try {
          for (const close of ['revoke', 'thread', 'revoke']) {
            const thread = await engine.start_replaceable_thread('{}', '[]');
            thread._enable_native_interception(4, 'thread_tree');
            thread._enable_native_mcp_results(4);
            const intercepted = thread._next_native_interception('0');
            const mcp = thread._next_native_mcp_result('0');
            assert.equal(await Promise.race([Promise.all([intercepted, mcp]), setTimeout(35, 'pending')]), 'pending');
            if (close === 'revoke') {
              thread._revoke_native_interception();
              thread._revoke_native_mcp_results();
            } else await thread.close();
            assert.deepEqual(await Promise.all([intercepted, mcp]), ['null', 'null']);
            await thread.close();
          }
        } finally { await engine.close(); }
        process.stdout.write('closed three fresh owners');
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `,
        module,
        home,
        cwd,
      ],
      { timeout: 12_000 },
    );
    expect(stdout).toBe('closed three fresh owners');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
