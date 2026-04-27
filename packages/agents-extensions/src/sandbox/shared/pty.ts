import { UserError } from '@openai/agents-core';

import { elapsedSeconds, formatExecResponse, truncateOutput } from './output';
import { shellQuote } from './paths';

const PTY_YIELD_TIME_MS_MIN = 250;
const PTY_EMPTY_YIELD_TIME_MS_MIN = 5_000;
const PTY_YIELD_TIME_MS_MAX = 30_000;

const PTY_PROCESSES_MAX = 64;
const PTY_PROCESSES_PROTECTED_RECENT = 8;

const PTY_PROCESS_ID_MIN = 1_000;
const PTY_PROCESS_ID_MAX_EXCLUSIVE = 100_000;

export type PtyProcessEntry = {
  tty: boolean;
  output: string;
  done: boolean;
  exitCode: number | null;
  lastUsed: number;
  waiters: Set<() => void>;
  sendInput?: (chars: string) => Promise<void>;
  terminate?: () => Promise<void>;
};

export type PtyWebSocket = {
  readyState?: number;
  binaryType?: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (
    type: string,
    listener: (event: unknown) => void,
  ) => void;
  on?: (type: string, listener: (...args: unknown[]) => void) => void;
  off?: (type: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    type: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

export function createPtyProcessEntry(args: {
  tty?: boolean;
  sendInput?: (chars: string) => Promise<void>;
  terminate?: () => Promise<void>;
}): PtyProcessEntry {
  return {
    tty: args.tty ?? true,
    output: '',
    done: false,
    exitCode: null,
    lastUsed: Date.now(),
    waiters: new Set(),
    sendInput: args.sendInput,
    terminate: args.terminate,
  };
}

export function appendPtyOutput(
  entry: PtyProcessEntry,
  chunk: string | Uint8Array | ArrayBuffer,
): void {
  if (typeof chunk === 'string') {
    entry.output += chunk;
  } else {
    entry.output += new TextDecoder().decode(chunk);
  }
  notifyPtyWaiters(entry);
}

export function markPtyDone(
  entry: PtyProcessEntry,
  exitCode: number | null = null,
): void {
  entry.done = true;
  entry.exitCode = exitCode;
  notifyPtyWaiters(entry);
}

export function watchPtyProcess(
  entry: PtyProcessEntry,
  wait: () => Promise<unknown>,
  exitCode: (result: unknown, error?: unknown) => number | null | undefined,
): void {
  void (async () => {
    try {
      const result = await wait();
      markPtyDone(entry, coerceExitCode(exitCode(result)));
    } catch (error) {
      markPtyDone(entry, coerceExitCode(exitCode(undefined, error) ?? 1));
    }
  })();
}

export async function openPtyWebSocket(args: {
  url: string;
  providerName: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  configure?: (socket: PtyWebSocket) => void | Promise<void>;
}): Promise<PtyWebSocket> {
  const socket = await createWebSocket(args);
  socket.binaryType = 'arraybuffer';
  await args.configure?.(socket);
  await waitForPtyWebSocketOpen(
    socket,
    args.timeoutMs ?? 30_000,
    args.providerName,
  );
  return socket;
}

export function addPtyWebSocketListener(
  socket: PtyWebSocket,
  type: string,
  listener: (event: unknown) => void,
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }

  if (socket.on) {
    const nodeListener = (...args: unknown[]) => {
      listener({ data: args[0] });
    };
    socket.on(type, nodeListener);
    return () => {
      if (socket.off) {
        socket.off(type, nodeListener);
      } else {
        socket.removeListener?.(type, nodeListener);
      }
    };
  }

  return () => {};
}

export class PtyProcessRegistry {
  private readonly processes = new Map<number, PtyProcessEntry>();

  register(entry: PtyProcessEntry): {
    sessionId: number;
    pruned?: PtyProcessEntry;
  } {
    const pruned = this.pruneIfNeeded();
    const sessionId = allocatePtyProcessId(this.processes);
    this.processes.set(sessionId, entry);
    return { sessionId, pruned };
  }

  get(sessionId: number): PtyProcessEntry | undefined {
    return this.processes.get(sessionId);
  }

  async terminateAll(): Promise<void> {
    const entries = [...this.processes.values()];
    this.processes.clear();
    await Promise.allSettled(entries.map((entry) => terminatePtyEntry(entry)));
  }

  async finalize(sessionId: number): Promise<{
    processId?: number;
    exitCode?: number | null;
  }> {
    const entry = this.processes.get(sessionId);
    if (!entry) {
      return { processId: undefined, exitCode: 1 };
    }

    if (!entry.done) {
      return { processId: sessionId };
    }

    this.processes.delete(sessionId);
    await terminatePtyEntry(entry);
    return { processId: undefined, exitCode: entry.exitCode ?? 1 };
  }

  private pruneIfNeeded(): PtyProcessEntry | undefined {
    if (this.processes.size < PTY_PROCESSES_MAX) {
      return undefined;
    }

    // Keep the most recently interacted-with sessions even if an older live PTY has to
    // be pruned; this matches the model-facing session ids used by write_stdin().
    const entries = [...this.processes.entries()];
    const protectedIds = new Set(
      [...entries]
        .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
        .slice(0, PTY_PROCESSES_PROTECTED_RECENT)
        .map(([sessionId]) => sessionId),
    );
    const byLeastRecentlyUsed = entries.sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );

    for (const [sessionId, entry] of byLeastRecentlyUsed) {
      if (!protectedIds.has(sessionId) && entry.done) {
        this.processes.delete(sessionId);
        return entry;
      }
    }

    for (const [sessionId, entry] of byLeastRecentlyUsed) {
      if (!protectedIds.has(sessionId)) {
        this.processes.delete(sessionId);
        return entry;
      }
    }

    return undefined;
  }
}

async function createWebSocket(args: {
  url: string;
  providerName: string;
  headers?: Record<string, string>;
}): Promise<PtyWebSocket> {
  if (!args.headers && typeof globalThis.WebSocket === 'function') {
    return new globalThis.WebSocket(args.url) as unknown as PtyWebSocket;
  }

  try {
    const mod = (await import('ws')) as {
      WebSocket?: new (
        url: string,
        options?: { headers?: Record<string, string> },
      ) => PtyWebSocket;
      default?: new (
        url: string,
        options?: { headers?: Record<string, string> },
      ) => PtyWebSocket;
    };
    const WebSocketImpl = mod.WebSocket ?? mod.default;
    if (WebSocketImpl) {
      return new WebSocketImpl(
        args.url,
        args.headers ? { headers: args.headers } : undefined,
      );
    }
  } catch (error) {
    if (args.headers) {
      throw new UserError(
        `${args.providerName} PTY WebSocket support requires the optional \`ws\` package when headers are needed. ${(error as Error).message}`,
      );
    }
  }

  if (typeof globalThis.WebSocket === 'function') {
    return new globalThis.WebSocket(args.url) as unknown as PtyWebSocket;
  }

  throw new UserError(
    `${args.providerName} PTY support requires a WebSocket implementation.`,
  );
}

function waitForPtyWebSocketOpen(
  socket: PtyWebSocket,
  timeoutMs: number,
  providerName: string,
): Promise<void> {
  const readyState = socket.readyState;
  if (readyState === 1) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let removeOpen = () => {};
    let removeError = () => {};
    let removeClose = () => {};
    const cleanup = () => {
      removeOpen();
      removeError();
      removeClose();
      clearTimeout(timer);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    removeOpen = addPtyWebSocketListener(socket, 'open', () => {
      settle(resolve);
    });
    removeError = addPtyWebSocketListener(socket, 'error', (event) => {
      settle(() =>
        reject(
          new UserError(
            `${providerName} PTY WebSocket failed to connect: ${formatWebSocketEvent(event)}`,
          ),
        ),
      );
    });
    removeClose = addPtyWebSocketListener(socket, 'close', () => {
      settle(() =>
        reject(
          new UserError(`${providerName} PTY WebSocket closed before opening.`),
        ),
      );
    });
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new UserError(`${providerName} PTY WebSocket connection timed out.`),
        ),
      );
    }, timeoutMs);
    if (socket.readyState === 1) {
      settle(resolve);
      return;
    }
  });
}

export async function collectPtyOutput(args: {
  entry: PtyProcessEntry;
  yieldTimeMs: number;
  maxOutputTokens?: number;
}): Promise<{ text: string; originalTokenCount?: number }> {
  const deadline = Date.now() + args.yieldTimeMs;
  let output = consumePtyOutput(args.entry);

  while (!args.entry.done && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await waitForPtyNotification(args.entry, remainingMs);
    output += consumePtyOutput(args.entry);
  }

  if (args.entry.done) {
    output += consumePtyOutput(args.entry);
  }

  return truncateOutput(output, args.maxOutputTokens);
}

export async function writePtyStdin(args: {
  providerName: string;
  registry: PtyProcessRegistry;
  sessionId: number;
  chars?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const entry = args.registry.get(args.sessionId);
  if (!entry) {
    return formatExecResponse({
      output: `write_stdin failed: session not found: ${args.sessionId}`,
      wallTimeSeconds: 0,
      exitCode: 1,
    });
  }

  const start = Date.now();
  const chars = args.chars ?? '';
  if (chars.length > 0) {
    if (!entry.tty || !entry.sendInput) {
      throw new UserError(
        `${args.providerName} stdin is not available for this process.`,
      );
    }
    await entry.sendInput(chars);
  }

  const output = await collectPtyOutput({
    entry,
    yieldTimeMs: resolvePtyWriteYieldTimeMs(
      args.yieldTimeMs ?? 250,
      chars.length === 0,
    ),
    maxOutputTokens: args.maxOutputTokens,
  });
  entry.lastUsed = Date.now();
  const finalized = await args.registry.finalize(args.sessionId);

  return formatExecResponse({
    output: output.text,
    wallTimeSeconds: elapsedSeconds(start),
    sessionId: finalized.processId,
    exitCode: finalized.exitCode,
    originalTokenCount: output.originalTokenCount,
  });
}

export async function formatPtyExecUpdate(args: {
  registry: PtyProcessRegistry;
  sessionId: number;
  entry: PtyProcessEntry;
  startTime: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const output = await collectPtyOutput({
    entry: args.entry,
    yieldTimeMs: clampPtyYieldTimeMs(args.yieldTimeMs ?? 10_000),
    maxOutputTokens: args.maxOutputTokens,
  });
  const finalized = await args.registry.finalize(args.sessionId);

  return formatExecResponse({
    output: output.text,
    wallTimeSeconds: elapsedSeconds(args.startTime),
    sessionId: finalized.processId,
    exitCode: finalized.exitCode,
    originalTokenCount: output.originalTokenCount,
  });
}

export function shellCommandForPty(args: {
  cmd: string;
  shell?: string;
  login?: boolean;
}): string {
  const shellPath = args.shell ?? '/bin/sh';
  const login = args.shell ? (args.login ?? true) : false;
  const flag = login ? '-lc' : '-c';
  return `${shellPath} ${flag} ${shellQuote(args.cmd)}`;
}

function clampPtyYieldTimeMs(yieldTimeMs: number): number {
  return Math.max(
    PTY_YIELD_TIME_MS_MIN,
    Math.min(PTY_YIELD_TIME_MS_MAX, yieldTimeMs),
  );
}

function resolvePtyWriteYieldTimeMs(
  yieldTimeMs: number,
  inputEmpty: boolean,
): number {
  const normalized = clampPtyYieldTimeMs(yieldTimeMs);
  return inputEmpty
    ? Math.max(normalized, PTY_EMPTY_YIELD_TIME_MS_MIN)
    : normalized;
}

function allocatePtyProcessId(processes: Map<number, PtyProcessEntry>): number {
  while (true) {
    const processId =
      Math.floor(
        Math.random() * (PTY_PROCESS_ID_MAX_EXCLUSIVE - PTY_PROCESS_ID_MIN),
      ) + PTY_PROCESS_ID_MIN;
    if (!processes.has(processId)) {
      return processId;
    }
  }
}

function consumePtyOutput(entry: PtyProcessEntry): string {
  const output = entry.output;
  entry.output = '';
  return output;
}

function waitForPtyNotification(
  entry: PtyProcessEntry,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      entry.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    entry.waiters.add(done);
  });
}

function notifyPtyWaiters(entry: PtyProcessEntry): void {
  const waiters = [...entry.waiters];
  entry.waiters.clear();
  for (const waiter of waiters) {
    waiter();
  }
}

async function terminatePtyEntry(entry: PtyProcessEntry): Promise<void> {
  try {
    await entry.terminate?.();
  } catch {
    // PTY cleanup is best-effort.
  }
}

function coerceExitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function formatWebSocketEvent(event: unknown): string {
  if (event instanceof Error) {
    return event.message;
  }
  if (
    event &&
    typeof event === 'object' &&
    'message' in event &&
    typeof event.message === 'string'
  ) {
    return event.message;
  }
  return 'unknown error';
}
