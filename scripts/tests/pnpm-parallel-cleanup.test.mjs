import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(100);
  }
}

test(
  'pnpm parallel failure stops the tsx watcher and releases its server port',
  { timeout: 90_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pnpm-parallel-cleanup-'));
    const manifest = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    );
    let runner;
    let server;
    let output = '';
    try {
      await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'cleanup-fixture',
          private: true,
          packageManager: manifest.packageManager,
          scripts: {
            'dev:server': 'tsx watch server.cjs',
            'dev:failure': 'node fail.cjs',
          },
        }),
      );
      await writeFile(
        path.join(dir, 'server.cjs'),
        `
      const net = require('node:net');
      const fs = require('node:fs');
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => fs.writeFileSync('ready.json', JSON.stringify({
        pid: process.pid, watcherPid: process.ppid, port: server.address().port
      })));
    `,
      );
      await writeFile(
        path.join(dir, 'fail.cjs'),
        `
      const fs = require('node:fs');
      setInterval(() => { if (fs.existsSync('ready.json')) process.exit(23); }, 100);
    `,
      );
      runner = spawn('pnpm --filter cleanup-fixture run --parallel "/^dev:/"', {
        cwd: dir,
        shell: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let exit;
      runner.on('error', (error) => {
        exit = { error };
      });
      runner.on('exit', (code, signal) => {
        exit = { code, signal };
      });
      runner.stdout.on('data', (data) => {
        output += data;
      });
      runner.stderr.on('data', (data) => {
        output += data;
      });
      await waitFor(async () => {
        try {
          server = JSON.parse(
            await readFile(path.join(dir, 'ready.json'), 'utf8'),
          );
          return true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          assert.equal(exit, undefined, output);
          return false;
        }
      }, 'the backend to listen');
      await waitFor(() => exit !== undefined, 'pnpm to report failure');
      assert.equal(typeof exit.code, 'number', output);
      assert.notEqual(exit.code, 0, output);
      await waitFor(
        () => !alive(server.pid) && !alive(server.watcherPid),
        'the backend and watcher to exit',
        5_000,
      );
      const probe = net.createServer();
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(server.port, '127.0.0.1', () => probe.close(resolve));
      });
    } finally {
      t.diagnostic(output);
      // Clean up our fixture even when checking a runner with broken tree cleanup.
      if (process.platform === 'win32') {
        for (const pid of [runner?.pid, server?.watcherPid, server?.pid]) {
          if (pid && alive(pid))
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
              stdio: 'ignore',
            });
        }
      } else if (runner?.pid) {
        try {
          process.kill(-runner.pid, 'SIGKILL');
        } catch {
          // The process group may already have exited.
        }
      }
      runner?.stdout.destroy();
      runner?.stderr.destroy();
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
