import { afterEach, beforeEach, expect } from 'vitest';
import { format } from 'node:util';

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';
type StreamKind = 'stdout' | 'stderr';

type OutputEvent = {
  kind: StreamKind;
  source: 'console' | 'stream';
  method?: ConsoleMethod;
  message: string;
};

const mode = (process.env.TEST_STDIO_MODE ?? 'error').toLowerCase();
const guardEnabled = mode !== 'off';
const MAX_EVENTS = 20;

const consoleToStream: Record<ConsoleMethod, StreamKind> = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  warn: 'stderr',
  error: 'stderr',
};

const consoleMethods = Object.keys(consoleToStream) as ConsoleMethod[];
const baselineConsole = new Map<ConsoleMethod, (...args: unknown[]) => void>();
for (const method of consoleMethods) {
  baselineConsole.set(method, console[method].bind(console));
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

let consoleWriteDepth = 0;
let allowAll = false;
let droppedEvents = 0;
const allowedKinds = new Set<ConsoleMethod | StreamKind>();
let outputEvents: OutputEvent[] = [];

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

function isAllowed(kind: StreamKind, method?: ConsoleMethod): boolean {
  if (allowAll) {
    return true;
  }
  if (allowedKinds.has(kind)) {
    return true;
  }
  if (method && allowedKinds.has(method)) {
    return true;
  }
  return false;
}

function record(event: OutputEvent): void {
  if (outputEvents.length >= MAX_EVENTS) {
    droppedEvents += 1;
    return;
  }
  outputEvents.push({ ...event, message: event.message.trimEnd() });
}

export function allowConsole(kinds?: Array<ConsoleMethod | StreamKind>): void {
  if (!guardEnabled) {
    return;
  }
  if (!kinds || kinds.length === 0) {
    allowAll = true;
    return;
  }
  for (const kind of kinds) {
    allowedKinds.add(kind);
  }
}

function patchConsole(): void {
  for (const method of consoleMethods) {
    const original = baselineConsole.get(method);
    if (!original) {
      continue;
    }

    console[method] = (...args: unknown[]) => {
      const kind = consoleToStream[method];
      const message = format(...args);

      if (!isAllowed(kind, method)) {
        record({ kind, source: 'console', method, message });
        return;
      }

      consoleWriteDepth += 1;
      try {
        original(...args);
      } finally {
        consoleWriteDepth -= 1;
      }
    };
  }
}

function patchStream(kind: StreamKind): void {
  const stream = kind === 'stdout' ? process.stdout : process.stderr;
  const originalWrite =
    kind === 'stdout' ? originalStdoutWrite : originalStderrWrite;

  stream.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    const callback =
      typeof encoding === 'function'
        ? (encoding as (err?: Error) => void)
        : (cb as ((err?: Error) => void) | undefined);
    const resolvedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    // Avoid double counting console.* calls that delegate to stream writes.
    if (consoleWriteDepth === 0) {
      const message = normalizeChunk(chunk, resolvedEncoding);
      if (!isAllowed(kind)) {
        record({ kind, source: 'stream', message });
      }
    }

    if (isAllowed(kind)) {
      return originalWrite(
        chunk as any,
        resolvedEncoding as any,
        callback as any,
      );
    }

    callback?.();
    return true;
  }) as typeof stream.write;
}

function patchAll(): void {
  if (!guardEnabled) {
    return;
  }
  patchConsole();
  patchStream('stdout');
  patchStream('stderr');
}

function formatEvent(event: OutputEvent): string {
  const label =
    event.source === 'console'
      ? `console.${event.method}`
      : `${event.kind}.write`;
  return `${label}: ${truncate(event.message)}`;
}

function buildFailureMessage(): string {
  const testName = expect.getState().currentTestName ?? '<unknown test>';
  const lines = outputEvents.map(formatEvent);
  if (droppedEvents > 0) {
    lines.push(`...and ${droppedEvents} more event(s).`);
  }
  return [
    `Unexpected stdout/stderr during test: ${testName}`,
    ...lines.map((line) => ` - ${line}`),
    'Use allowConsole([...]) in a test when output is intentional.',
    'Set TEST_STDIO_MODE=off to disable this guard locally.',
  ].join('\n');
}

patchAll();

beforeEach(() => {
  if (!guardEnabled) {
    return;
  }
  // Reapply patches in case a previous test restored mocked console methods.
  patchAll();
  allowAll = false;
  droppedEvents = 0;
  allowedKinds.clear();
  outputEvents = [];
});

afterEach(() => {
  if (!guardEnabled || outputEvents.length === 0) {
    return;
  }
  const message = buildFailureMessage();
  if (mode === 'warn') {
    originalStderrWrite(`${message}\n`);
    return;
  }
  throw new Error(message);
});
