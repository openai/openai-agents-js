import { format } from 'node:util';

type ConsoleMethod =
  'log' | 'info' | 'debug' | 'warn' | 'error' | 'dir' | 'dirxml';
type StreamKind = 'stdout' | 'stderr';

type OutputEvent = {
  kind: StreamKind;
  source: 'console' | 'stream';
  method?: ConsoleMethod;
  message: string;
};

type GuardOriginals = {
  stderrWrite: typeof process.stderr.write;
};

type InstallStdioGuardOptions = {
  scope: () => string;
};

type GlobalSetupCleanup = () => void | Promise<void>;

const consoleToStream: Record<ConsoleMethod, StreamKind> = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  warn: 'stderr',
  error: 'stderr',
  dir: 'stdout',
  dirxml: 'stdout',
};

const consoleMethods = Object.keys(consoleToStream) as ConsoleMethod[];
const originalsSymbol = Symbol.for('openai-agents.test-stdio-originals');
const processWithOriginals = process as typeof process & {
  [originalsSymbol]?: GuardOriginals;
};
const originals =
  processWithOriginals[originalsSymbol] ??
  (processWithOriginals[originalsSymbol] = {
    stderrWrite: process.stderr.write.bind(process.stderr),
  });

function normalizeChunk(chunk: unknown, encoding?: BufferEncoding): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(encoding);
  }
  return String(chunk);
}

function truncate(message: string, maxLength = 200): string {
  const trimmed = message.trimEnd();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function formatEvent(event: OutputEvent): string {
  const label =
    event.source === 'console'
      ? `console.${event.method}`
      : `${event.kind}.write`;
  return `${label}: ${truncate(event.message)}`;
}

function unexpectedOutput(event: OutputEvent, scope: string): Error {
  return new Error(
    [
      `Unexpected stdout/stderr during ${scope}`,
      ` - ${formatEvent(event)}`,
      'Mock the console or stream method and assert its calls when output is intentional.',
      'Set TEST_STDIO_MODE=off to disable this guard locally.',
    ].join('\n'),
  );
}

export function installStdioGuard({
  scope,
}: InstallStdioGuardOptions): () => void {
  const mode = (process.env.TEST_STDIO_MODE ?? 'error').toLowerCase();
  if (mode === 'off') {
    return () => {};
  }

  const previousConsole = new Map<ConsoleMethod, (...args: any[]) => void>();
  const consoleWrappers = new Map<
    ConsoleMethod,
    (...args: unknown[]) => void
  >();
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;

  function report(event: OutputEvent): void {
    const error = unexpectedOutput(event, scope());
    if (mode === 'warn') {
      originals.stderrWrite(`${error.message}\n`);
      return;
    }
    throw error;
  }

  for (const method of consoleMethods) {
    const previous = console[method];
    const wrapper = (...args: unknown[]) => {
      report({
        kind: consoleToStream[method],
        source: 'console',
        method,
        message: format(...args),
      });
    };
    previousConsole.set(method, previous);
    consoleWrappers.set(method, wrapper);
    console[method] = wrapper;
  }

  function patchStream(kind: StreamKind): void {
    const stream = kind === 'stdout' ? process.stdout : process.stderr;
    stream.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      const callback =
        typeof encoding === 'function'
          ? (encoding as (err?: Error) => void)
          : (cb as ((err?: Error) => void) | undefined);
      const resolvedEncoding =
        typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

      report({
        kind,
        source: 'stream',
        message: normalizeChunk(chunk, resolvedEncoding),
      });
      callback?.();
      return true;
    }) as typeof stream.write;
  }

  patchStream('stdout');
  patchStream('stderr');

  const stdoutWrapper = process.stdout.write;
  const stderrWrapper = process.stderr.write;
  return () => {
    for (const method of consoleMethods) {
      if (console[method] === consoleWrappers.get(method)) {
        console[method] = previousConsole.get(method)!;
      }
    }
    if (process.stdout.write === stdoutWrapper) {
      process.stdout.write = previousStdoutWrite;
    }
    if (process.stderr.write === stderrWrapper) {
      process.stderr.write = previousStderrWrite;
    }
  };
}

export async function guardGlobalSetup(
  setup: () => void | GlobalSetupCleanup | Promise<void | GlobalSetupCleanup>,
): Promise<void | GlobalSetupCleanup> {
  const restoreSetup = installStdioGuard({ scope: () => 'global setup' });
  let cleanup: void | GlobalSetupCleanup;
  try {
    cleanup = await setup();
  } finally {
    restoreSetup();
  }
  if (!cleanup) {
    return;
  }
  return async () => {
    const restoreCleanup = installStdioGuard({
      scope: () => 'global teardown',
    });
    try {
      await cleanup();
    } finally {
      restoreCleanup();
    }
  };
}
