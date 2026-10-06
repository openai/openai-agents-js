import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { UserError } from '../../../errors';
import { UNIX_LOCAL_FILE_WORKER } from './unixLocalFileWorker';

/** Host file protection. auto is an alias for required; off is rejected. */
export type LocalFileIOProtection = 'auto' | 'required' | 'off';

// Transfer trusted preparation across setup without selecting a backend twice.
export const preparedFileIO = Symbol('preparedFileIO');

/** Canonical host authority plus the requested path to check as the worker user. */
export type LocalFilePath = {
  path: string;
  accessPath: string;
  preserveLeaf: boolean;
};

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
  path: LocalFilePath;
  destination?: LocalFilePath;
  unlinkPath?: LocalFilePath;
  limit?: number;
};

// Resolve from trusted host configuration, never the manifest's command environment.
function pythonExecutable(mode: LocalFileIOProtection): string {
  if (mode === 'off') {
    throw new UserError(
      'UnixLocal file I/O protection cannot be disabled. Use a trusted Python 3 installation with descriptor-relative filesystem support.',
    );
  }
  if (process.platform === 'win32') {
    throw new UserError(
      'Required file I/O protection is supported only on Unix hosts.',
    );
  }
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
      const probe = spawnSync(
        executable,
        [
          '-I',
          '-S',
          '-c',
          UNIX_LOCAL_FILE_WORKER,
          JSON.stringify({ operation: 'probe' }),
        ],
        {
          cwd: '/',
          env: { PATH: '/usr/bin:/bin' },
          timeout: 5000,
          maxBuffer: 4096,
          encoding: 'utf8',
        },
      );
      if (!probe.error && probe.status === 0 && probe.stdout === 'ready')
        return executable;
    } catch {
      // Try the next trusted installation path.
    }
  }
  throw new UserError(
    'Required file I/O protection needs a trusted Python 3 installation with descriptor-relative filesystem support. Set the host OPENAI_AGENTS_PYTHON to an absolute executable path.',
  );
}

/** Owns trusted file workers independently of sandbox shell processes. */
export class UnixLocalFiles {
  private readonly executable: string;

  constructor(mode: LocalFileIOProtection = 'required') {
    this.executable = pythonExecutable(mode);
  }

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
    const child = spawn(
      this.executable,
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
              { code: detail.code ?? 'EIO', path: request.path.path },
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
