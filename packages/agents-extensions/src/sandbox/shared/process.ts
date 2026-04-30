import { spawn } from 'node:child_process';

export type SandboxProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
};

export type RunSandboxProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;

export async function runSandboxProcess(
  command: string,
  args: string[],
  options: RunSandboxProcessOptions = {},
): Promise<SandboxProcessResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    let timedOut = false;
    let closed = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const captureChunk = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
    ): number => {
      const remainingBytes = maxOutputBytes - currentBytes;
      if (remainingBytes <= 0) {
        return currentBytes;
      }
      const captured =
        chunk.length > remainingBytes
          ? chunk.subarray(0, remainingBytes)
          : chunk;
      chunks.push(captured);
      return currentBytes + captured.length;
    };

    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      closed = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error,
        timedOut,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = captureChunk(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = captureChunk(stderrChunks, stderrBytes, chunk);
    });

    child.on('error', (childError) => {
      error = childError;
      finish(null, null);
    });

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (!closed) {
            child.kill('SIGKILL');
          }
        }, FORCE_KILL_DELAY_MS);
      }, options.timeoutMs);
    }

    child.on('close', (status, signal) => {
      finish(status, signal);
    });
  });
}

export function formatSandboxProcessError(
  result: SandboxProcessResult,
): string {
  if (result.timedOut) {
    return 'process timed out';
  }
  return (
    result.stderr || result.stdout || result.error?.message || 'process failed'
  );
}
