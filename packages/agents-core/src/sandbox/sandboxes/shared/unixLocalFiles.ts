import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { applyOwnershipRecursive, pathExists } from './localWorkspace';
import { UserError } from '../../../errors';
import { UNIX_LOCAL_FILE_WORKER } from './unixLocalFileWorker';

type FileRequest = {
  operation:
    | 'read'
    | 'image'
    | 'list'
    | 'exists'
    | 'directoryExists'
    | 'create'
    | 'update'
    | 'delete';
  path: string;
  destination?: string;
  unlinkPath?: string;
  limit?: number;
  owner?: { uid: number; gid: number };
};

// Resolve from trusted host configuration, never the manifest's command environment.
function pythonExecutable(): string {
  const configured = process.env.OPENAI_AGENTS_PYTHON;
  const candidates = configured
    ? isAbsolute(configured)
      ? [configured]
      : []
    : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map((directory) =>
        join(directory, 'python3'),
      );
  for (const candidate of candidates) {
    try {
      const executable = realpathSync(candidate);
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // Try the next trusted installation path.
    }
  }
  throw new UserError(
    'UnixLocal file operations require Python 3. Set OPENAI_AGENTS_PYTHON to an absolute trusted Python 3 executable path.',
  );
}

/** Owns trusted file workers independently of sandbox shell processes. */
export class UnixLocalFiles {
  private readonly active = new Set<{
    cancel: () => void;
    done: Promise<void>;
  }>();
  private closed = false;

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
  }

  async stop(): Promise<void> {
    const active = [...this.active];
    for (const worker of active) worker.cancel();
    await Promise.all(active.map((worker) => worker.done));
  }

  async run(
    request: FileRequest,
    options: {
      input?: string;
      update?: (current: string) => string;
      identity?: { uid: number; gid: number };
    } = {},
  ): Promise<Buffer> {
    if (this.closed)
      throw new UserError('UnixLocal file operations are closed.');
    if (process.platform === 'win32') {
      return runWindowsHostFileOperation(request, options);
    }
    const executable = pythonExecutable();
    const child = spawn(
      executable,
      ['-I', '-S', '-c', UNIX_LOCAL_FILE_WORKER, JSON.stringify(request)],
      {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        ...(options.identity
          ? { uid: options.identity.uid, gid: options.identity.gid }
          : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let primaryError: unknown;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const worker = {
      done,
      cancel: () => {
        primaryError ??= new UserError('UnixLocal file operation cancelled.');
        child.kill('SIGKILL');
      },
    };
    this.active.add(worker);
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          const remaining = 8192 - stderrBytes;
          if (remaining > 0) {
            stderr.push(chunk.subarray(0, remaining));
            stderrBytes += Math.min(chunk.length, remaining);
          }
        });
        child.stdin.on('error', () => {
          // The worker's exit/error owns failures such as a denied open or a closed pipe.
        });
        child.on('error', (error) => {
          primaryError ??= error;
        });
        if (options.update) {
          child.stdout.on('end', () => {
            if (primaryError) return;
            const current = Buffer.concat(stdout);
            if (!current.subarray(0, 6).equals(Buffer.from('READY\n'))) return;
            try {
              const next = options.update!(
                current.subarray(6).toString('utf8'),
              );
              child.stdin.end(`W${next}`);
            } catch (error) {
              primaryError = error;
              child.stdin.end();
            }
          });
        } else {
          child.stdin.end(options.input ?? '');
        }
        child.on('close', (code, signal) => {
          if (!primaryError && (code !== 0 || signal)) {
            let detail: { code?: string; message?: string } = {};
            try {
              detail = JSON.parse(Buffer.concat(stderr).toString('utf8'));
            } catch {
              /* Preserve a bounded diagnostic below. */
            }
            primaryError = Object.assign(
              new Error(
                `${detail.code ?? 'EIO'}: ${detail.message ?? 'UnixLocal file worker failed. Python 3 with its standard library is required.'}`,
              ),
              { code: detail.code ?? 'EIO', path: request.path },
            );
          }
          if (primaryError) reject(primaryError);
          else resolve(Buffer.concat(stdout));
        });
      });
    } finally {
      this.active.delete(worker);
      resolveDone();
    }
  }
}

// Docker's Windows host fallback retains Node filesystem behavior; POSIX workers
// protect Unix hosts only and are not a Windows runtime prerequisite.
async function runWindowsHostFileOperation(
  request: FileRequest,
  options: { input?: string; update?: (current: string) => string },
): Promise<Buffer> {
  const { operation, path } = request;
  if (operation === 'exists')
    return Buffer.from(JSON.stringify(await pathExists(path)));
  if (operation === 'list') {
    const entries = await readdir(path, { withFileTypes: true });
    return Buffer.from(
      JSON.stringify(
        entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        })),
      ),
    );
  }
  if (operation === 'read') return readFile(path);
  if (operation === 'image') {
    const info = await stat(path);
    if (!info.isFile())
      throw Object.assign(new Error('Image path is not a file.'), {
        code: 'EINVAL',
      });
    if (info.size > request.limit!)
      throw Object.assign(new Error('Image file exceeds the limit.'), {
        code: 'EFBIG',
      });
    return readFile(path);
  }
  if (operation === 'delete') await unlink(path);
  else if (operation === 'create' || operation === 'update') {
    const destination = request.destination ?? path;
    const content =
      operation === 'create'
        ? options.input!
        : options.update!(await readFile(path, 'utf8'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, {
      encoding: 'utf8',
      flag: operation === 'create' ? 'wx' : 'w',
    });
    if (request.unlinkPath) await unlink(request.unlinkPath);
    if (request.owner)
      await applyOwnershipRecursive(
        destination,
        request.owner.uid,
        request.owner.gid,
      );
  }
  return Buffer.alloc(0);
}
