import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as nodeUtil from 'node:util';
import type { CodexOptions } from '@openai/codex-sdk';

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

// Keep provider configuration independent of the optional SDK's minimum version.
export type CodexAppServerOptions = CodexOptions & {
  config?: { [key: string]: CodexConfigValue };
  configOverrides?: string[];
};

export type CodexAppServerEvent = {
  method: string;
  params?: unknown;
  id?: string | number;
};

export type CodexAppServer = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  events: AsyncIterable<CodexAppServerEvent>;
  close(): Promise<void>;
};

// Locate the SDK's own CLI dependency rather than a potentially different PATH CLI.
// getCallSites supplies this module's location in both CommonJS and ESM builds.
function resolveExecutable(): { executable: string; pathDir?: string } {
  if (
    typeof nodeModule.findPackageJSON !== 'function' ||
    typeof nodeUtil.getCallSites !== 'function'
  ) {
    throw new Error(
      'CodexProvider needs Node.js 22.14 or later to find the stock CLI. Set codexOptions.codexPathOverride to use an explicit executable.',
    );
  }
  const sdkPackage = nodeModule.findPackageJSON(
    '@openai/codex-sdk',
    nodeUtil.getCallSites()[0].scriptName,
  );
  if (!sdkPackage) {
    throw new Error('Unable to locate @openai/codex-sdk.');
  }
  const sdkRequire = nodeModule.createRequire(sdkPackage);
  let codexPackage: string;
  try {
    codexPackage = sdkRequire.resolve('@openai/codex/package.json');
  } catch {
    throw new Error(
      'CodexProvider requires @openai/codex-sdk >=0.166.0 or codexOptions.codexPathOverride pointing to a supported stock Codex CLI.',
    );
  }
  const codexRequire = nodeModule.createRequire(codexPackage);
  const platform = process.platform;
  const arch = process.arch;
  const targets: Record<string, Record<string, string>> = {
    linux: {
      x64: 'x86_64-unknown-linux-musl',
      arm64: 'aarch64-unknown-linux-musl',
    },
    android: {
      x64: 'x86_64-unknown-linux-musl',
      arm64: 'aarch64-unknown-linux-musl',
    },
    darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
    win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  };
  const target = targets[platform]?.[arch];
  if (!target) {
    throw new Error('Unsupported platform for Codex App Server.');
  }
  const packagePlatform = platform === 'android' ? 'linux' : platform;
  const platformPackage = codexRequire.resolve(
    `@openai/codex-${packagePlatform}-${arch}/package.json`,
  );
  const root = join(dirname(platformPackage), 'vendor', target);
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const current = join(root, 'bin', name);
  const executable =
    existsSync(join(root, 'codex-package.json')) && existsSync(current)
      ? current
      : join(root, 'codex', name);
  if (!existsSync(executable)) {
    throw new Error(
      'Unable to locate Codex CLI binaries. Install optional dependencies.',
    );
  }
  const pathDir = join(root, executable === current ? 'codex-path' : 'path');
  return { executable, pathDir: existsSync(pathDir) ? pathDir : undefined };
}

// Preserve the Codex SDK's structured TOML overrides and their precedence.
function configArguments(config: CodexAppServerOptions['config']): string[] {
  const overrides: string[] = [];
  function toml(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'boolean') {
      return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value);
    if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(
          ([key, child]) =>
            `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${toml(child)}`,
        )
        .join(', ')}}`;
    }
    throw new Error('Unsupported Codex config override value.');
  }
  function flatten(value: Record<string, unknown>, prefix = ''): void {
    for (const [key, child] of Object.entries(value)) {
      if (!key)
        throw new Error('Codex config override keys must be non-empty.');
      if (child === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (
        child &&
        typeof child === 'object' &&
        !Array.isArray(child) &&
        Object.keys(child).length
      ) {
        flatten(child as Record<string, unknown>, path);
      } else {
        overrides.push('--config', `${path}=${toml(child)}`);
      }
    }
  }
  if (config) flatten(config);
  return overrides;
}

export async function openCodexAppServer({
  codexOptions = {},
  cwd,
  signal,
}: {
  codexOptions?: CodexAppServerOptions;
  cwd?: string;
  signal?: AbortSignal;
} = {}): Promise<CodexAppServer> {
  signal?.throwIfAborted();
  const override = codexOptions.codexPathOverride;
  const { executable, pathDir } = override
    ? {
        executable:
          basename(override) === override ? override : resolve(override),
        pathDir: undefined,
      }
    : resolveExecutable();
  const args = [
    'app-server',
    '--config',
    'features.apps=false',
    '--config',
    'web_search="disabled"',
    ...configArguments(codexOptions.config),
  ];
  for (const override of codexOptions.configOverrides ?? []) {
    args.push('--config', override);
  }
  if (codexOptions.baseUrl) {
    args.push(
      '--config',
      `openai_base_url=${JSON.stringify(codexOptions.baseUrl)}`,
    );
  }
  const env = { ...(codexOptions.env ?? process.env) };
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ||= 'codex_sdk_ts';
  if (codexOptions.apiKey) env.CODEX_API_KEY = codexOptions.apiKey;
  if (pathDir) {
    const pathKey =
      process.platform === 'win32'
        ? (Object.keys(env).find((key) => key.toLowerCase() === 'path') ??
          'PATH')
        : 'PATH';
    env[pathKey] = [pathDir, env[pathKey]].filter(Boolean).join(delimiter);
  }
  const child = spawn(executable, args, { cwd, env, stdio: 'pipe' });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const queue: CodexAppServerEvent[] = [];
  let nextId = 0;
  let failure: Error | undefined;
  let closing = false;
  let wake: (() => void) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => {
      closing = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      fail(new Error('Codex App Server exited.'));
      resolve();
    });
  });
  function fail(error: Error): void {
    if (failure) return;
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    wake?.();
    wake = undefined;
  }
  function stop(error: Error): void {
    fail(error);
    if (closing) return;
    closing = true;
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    killTimer.unref();
  }
  function abort(): void {
    stop(new DOMException('Codex App Server request aborted.', 'AbortError'));
  }
  child.on('error', () => stop(new Error('Unable to run Codex App Server.')));
  child.stdin.on('error', () =>
    stop(new Error('Unable to write to Codex App Server.')),
  );
  child.stdout.on('error', () =>
    stop(new Error('Unable to read from Codex App Server.')),
  );
  child.stderr.on('error', () => {});
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('error', () =>
    stop(new Error('Unable to read from Codex App Server.')),
  );
  lines.on('line', (line) => {
    if (failure) return;
    try {
      const message: unknown = JSON.parse(line);
      if (!message || typeof message !== 'object') throw new Error();
      const data = message as Record<string, unknown>;
      if (typeof data.method === 'string') {
        queue.push({
          method: data.method,
          params: data.params,
          ...(typeof data.id === 'string' || typeof data.id === 'number'
            ? { id: data.id }
            : {}),
        });
        wake?.();
        wake = undefined;
      } else if (
        typeof data.id === 'number' &&
        ('result' in data || 'error' in data)
      ) {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if ('error' in data) {
          request.reject(new Error('Codex App Server request failed.'));
        } else {
          request.resolve(data.result);
        }
      } else {
        throw new Error();
      }
    } catch {
      stop(new Error('Invalid Codex App Server protocol message.'));
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  function write(message: unknown): void {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () =>
      reject(new Error('Unable to run Codex App Server.')),
    );
  }).catch(async (error) => {
    await exited;
    throw error;
  });
  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    events: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (failure) {
            if (closing && failure.message === 'Codex App Server closed.')
              return;
            throw failure;
          }
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    async close() {
      stop(new Error('Codex App Server closed.'));
      await exited;
    },
  };
}
