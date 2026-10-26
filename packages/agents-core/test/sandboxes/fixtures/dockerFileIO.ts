import * as childProcess from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, vi, type Mock } from 'vitest';
import { DockerSandboxSession, Manifest } from '../../../src/sandbox/local';

export const success = {
  status: 0,
  stdout: '',
  stderr: '',
  signal: null,
  timedOut: false,
};

// Execute Docker payloads against a distinct local filesystem. Only transport,
// user selection and GNU utility spelling are adapted; filesystem I/O is real.
// This fixture does not prove live-container containment or user permissions.
export async function createDockerFileIOFixture(runDockerProcess: Mock) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-file-io-')));
  const workspace = join(root, 'container');
  const host = join(root, 'host');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(workspace), mkdir(host), mkdir(outside)]);
  await writeFile(join(workspace, 'note.txt'), 'before\n');
  await writeFile(join(host, 'note.txt'), 'host sentinel\n');
  await writeFile(join(outside, 'secret.txt'), 'outside sentinel\n');
  const commands: string[][] = [];
  runDockerProcess.mockReset().mockResolvedValue(success);
  const native =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  vi.spyOn(childProcess, 'spawn').mockImplementation(((
    command: string,
    args: string[],
    options: childProcess.SpawnOptions,
  ) => {
    expect(command).toBe('docker');
    commands.push(args);
    if (args.includes('/usr/bin/tar')) {
      // Real archive extraction; the native Docker test covers containment.
      return native.spawn(
        'tar',
        [
          '-xpf',
          '-',
          '--no-same-owner',
          '-C',
          args
            .find((arg) => arg.startsWith('--directory='))!
            .slice('--directory='.length),
        ],
        options,
      );
    }
    if (args.includes('/usr/bin/realpath')) {
      // Use real OS path resolution, including missing tails, on macOS too.
      return native.spawn(
        process.execPath,
        [
          '-e',
          `
const fs = require('node:fs');
const path = require('node:path');
let current = process.argv[1];
const tail = [];
while (true) {
  try { process.stdout.write(path.resolve(fs.realpathSync(current), ...tail) + '\\n'); break; }
  catch (error) {
if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
tail.unshift(path.basename(current)); current = path.dirname(current);
  }
}
`,
          args.at(-1)!,
        ],
        { ...options, env: { PATH: '/usr/bin:/bin' } },
      );
    }
    if (args.includes('stat') && args.includes('%f')) {
      return native.spawn(
        process.execPath,
        [
          '-e',
          `
const fs = require('node:fs');
try {
  const info = fs.lstatSync(process.argv[1]);
  process.stdout.write(info.mode.toString(16) + '\\n');
} catch (error) {
  process.stderr.write(error.code === 'ENOENT' ? 'stat: No such file or directory\\n' : String(error));
  process.exit(1);
}
`,
          args.at(-1)!,
        ],
        options,
      );
    }
    let script = args.at(-1)!;
    fixture.beforeCommand?.(script);
    if (process.platform === 'darwin') {
      // Preserve base64's exit status instead of using shell redirection.
      script = script.replace(/base64 -- /gu, 'base64 -i ');
      // Preserve GNU find's type/name records using portable host utilities.
      script = script.replace(
        "-printf '%y\\0%f\\0'",
        `-exec /bin/sh -c 'for file do kind=o; if [ -L "$file" ]; then kind=l; elif [ -d "$file" ]; then kind=d; elif [ -f "$file" ]; then kind=f; fi; printf "%s\\0%s\\0" "$kind" "\${file##*/}"; done' sh {} +`,
      );
    }
    const environment: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      ...session.state.environment,
    };
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '-e') continue;
      const assignment = args[++index]!;
      const separator = assignment.indexOf('=');
      environment[assignment.slice(0, separator)] = assignment.slice(
        separator + 1,
      );
    }
    const launcher = args.indexOf('/usr/bin/env');
    return native.spawn(
      launcher >= 0 ? '/usr/bin/env' : '/bin/sh',
      // Keep container commands away from the host's login profile.
      launcher >= 0
        ? [...args.slice(launcher + 1, -1), script]
        : ['-c', script],
      {
        ...options,
        cwd: '/',
        env: environment,
      },
    );
  }) as typeof childProcess.spawn);
  const session = new DockerSandboxSession({
    state: {
      manifest: new Manifest({ root: workspace }),
      workspaceRootPath: host,
      workspaceRootOwned: false,
      environment: {},
      containerId: 'test-container',
      image: 'test:image',
      defaultUser: 'container-user',
    },
  });
  const fixture = {
    root,
    workspace,
    host,
    outside,
    session,
    commands,
    beforeCommand: undefined as ((command: string) => void) | undefined,
  };
  return fixture;
}
