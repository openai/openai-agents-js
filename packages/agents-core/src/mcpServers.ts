import { getLogger, logToolActionDebug, logToolActionError } from './logger';
import type { MCPServer } from './mcp';
import { getMcpServerExternalName } from './mcpLogging';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

const logger = getLogger('openai-agents:mcp-servers');

function getMcpServerLogLabel(server: MCPServer): string {
  if (logger.dontLogToolData) {
    return 'MCP server';
  }
  return `MCP server '${getMcpServerExternalName(server.name)}'`;
}

type ServerAction = 'connect' | 'close';

type ServerCommand = {
  action: ServerAction;
  timeoutMs: number | null;
  resolve: () => void;
  reject: (error: Error) => void;
};

type TrackedCloseTask = {
  task: Promise<void>;
  settled: boolean;
};

class ServerWorker {
  private queue: ServerCommand[] = [];
  private draining = false;
  private done = false;
  private closing: TrackedCloseTask | null = null;
  private closeResult: Promise<void> | null = null;

  constructor(
    private readonly server: MCPServer,
    private readonly connectTimeoutMs: number | null,
    private readonly closeTimeoutMs: number | null,
    private readonly onCloseSettled: (error: Error | null) => void,
  ) {}

  get isDone(): boolean {
    return this.done;
  }

  connect(): Promise<void> {
    return this.submit('connect', this.connectTimeoutMs);
  }

  async close(): Promise<void> {
    if (this.done) {
      return;
    }
    if (this.closeResult) {
      return this.closeResult;
    }
    if (this.closing) {
      const existingClose = this.closing;
      try {
        await runWithTimeoutTask(
          existingClose.task,
          this.closeTimeoutMs,
          createTimeoutError('close', this.server, this.closeTimeoutMs),
        );
        return;
      } catch (error) {
        if (!existingClose.settled) {
          throw error;
        }
        if (this.closing === existingClose) {
          this.closing = null;
        }
      }
    }
    return this.submit('close', this.closeTimeoutMs);
  }

  private submit(
    action: ServerAction,
    timeoutMs: number | null,
  ): Promise<void> {
    if (this.done) {
      return Promise.reject(createClosedError(this.server));
    }
    if (this.closeResult || this.closing) {
      if (action === 'close' && this.closeResult) {
        return this.closeResult;
      }
      return Promise.reject(createClosingError(this.server));
    }
    let resolveCommand: (() => void) | undefined;
    let rejectCommand: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    const command = {
      action,
      timeoutMs,
      resolve: resolveCommand!,
      reject: rejectCommand!,
    };
    if (action === 'close') {
      this.closeResult = promise;
    }
    this.queue.push(command);
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    while (this.queue.length > 0) {
      const command = this.queue.shift();
      if (!command) {
        continue;
      }
      const shouldExit = command.action === 'close';
      let closeError: Error | null = null;
      try {
        if (command.action === 'connect') {
          await runWithTimeout(
            () => this.server.connect(),
            command.timeoutMs,
            createTimeoutError('connect', this.server, command.timeoutMs),
          );
        } else {
          const closeTask = this.server.close();
          const trackedClose = trackCloseTask(closeTask, (error) => {
            if (this.closing !== trackedClose) {
              return;
            }
            if (!error) {
              this.done = true;
            }
            this.onCloseSettled(error);
          });
          this.closing = trackedClose;
          await runWithTimeoutTask(
            closeTask,
            command.timeoutMs,
            createTimeoutError('close', this.server, command.timeoutMs),
          );
        }
        command.resolve();
      } catch (error) {
        const err = toError(error);
        command.reject(err);
        if (shouldExit) {
          closeError = err;
        }
      }
      if (shouldExit) {
        const pendingError = closeError ?? createClosedError(this.server);
        while (this.queue.length > 0) {
          const pending = this.queue.shift();
          if (pending) {
            pending.reject(pendingError);
          }
        }
        this.closeResult = null;
        if (!closeError) {
          this.done = true;
        }
        break;
      }
    }
    this.draining = false;
  }
}

export type MCPServersOptions = {
  connectTimeoutMs?: number | null;
  closeTimeoutMs?: number | null;
  dropFailed?: boolean;
  strict?: boolean;
  suppressAbortError?: boolean;
  connectInParallel?: boolean;
};

export type MCPServersReconnectOptions = {
  failedOnly?: boolean;
};

/**
 * Manages MCP server lifecycle and exposes only connected servers.
 */
export class MCPServers {
  private readonly allServers: MCPServer[];
  private connectedServerSet = new Set<MCPServer>();
  private failedServers: MCPServer[] = [];
  private failedServerSet = new Set<MCPServer>();
  private errorsByServer = new Map<MCPServer, Error>();
  private suppressedAbortFailures = new Set<MCPServer>();
  private workers = new Map<MCPServer, ServerWorker>();
  private serialCloseTasks = new Map<MCPServer, TrackedCloseTask>();
  private lifecycleTail: Promise<void> = Promise.resolve();

  private readonly connectTimeoutMs: number | null;
  private readonly closeTimeoutMs: number | null;
  private readonly dropFailed: boolean;
  private readonly strict: boolean;
  private readonly suppressAbortError: boolean;
  private readonly connectInParallel: boolean;

  declare [Symbol.asyncDispose]: () => Promise<void>;

  static {
    const asyncDispose = Symbol.asyncDispose;
    if (asyncDispose) {
      Object.defineProperty(this.prototype, asyncDispose, {
        value: function (this: MCPServers) {
          return this.close();
        },
        configurable: true,
      });
    }
  }

  private constructor(servers: MCPServer[], options?: MCPServersOptions) {
    this.allServers = uniqueServers(servers);

    this.connectTimeoutMs =
      options?.connectTimeoutMs === undefined
        ? DEFAULT_CONNECT_TIMEOUT_MS
        : options.connectTimeoutMs;
    this.closeTimeoutMs =
      options?.closeTimeoutMs === undefined
        ? DEFAULT_CLOSE_TIMEOUT_MS
        : options.closeTimeoutMs;
    this.dropFailed = options?.dropFailed ?? true;
    this.strict = options?.strict ?? false;
    this.suppressAbortError = options?.suppressAbortError ?? true;
    this.connectInParallel = options?.connectInParallel ?? false;
  }

  static async open(
    servers: MCPServer[],
    options?: MCPServersOptions,
  ): Promise<MCPServers> {
    const session = new MCPServers(servers, options);
    logger.debug(
      `Opening MCPServers with ${session.allServers.length} server(s).`,
    );
    await session.connectAll();
    return session;
  }

  get all(): MCPServer[] {
    return [...this.allServers];
  }

  get active(): MCPServer[] {
    if (!this.dropFailed) {
      return [...this.allServers];
    }
    return this.allServers.filter((server) =>
      this.connectedServerSet.has(server),
    );
  }

  get failed(): MCPServer[] {
    return [...this.failedServers];
  }

  get errors(): ReadonlyMap<MCPServer, Error> {
    return new Map(this.errorsByServer);
  }

  async reconnect(
    options: MCPServersReconnectOptions = {},
  ): Promise<MCPServer[]> {
    return this.enqueueLifecycle(() => this.reconnectNow(options));
  }

  private async reconnectNow(
    options: MCPServersReconnectOptions,
  ): Promise<MCPServer[]> {
    const failedOnly = options.failedOnly ?? true;
    const serversToCleanup = failedOnly
      ? uniqueServers(this.failedServers)
      : [...this.allServers];

    logger.debug(
      `Reconnecting MCP servers (failedOnly=${failedOnly}) with ${serversToCleanup.length} target(s).`,
    );

    if (!failedOnly) {
      for (const server of serversToCleanup) {
        if (!this.failedServerSet.has(server)) {
          this.storeFailure(server, createClosedError(server));
        }
      }
    }

    try {
      const serversToRetry = await this.closeServers(serversToCleanup);
      if (!failedOnly) {
        const cleanedServers = new Set(serversToRetry);
        const cleanupFailures = serversToCleanup.flatMap((server) => {
          if (cleanedServers.has(server)) {
            return [];
          }
          const error = this.errorsByServer.get(server);
          return error ? [{ server, error }] : [];
        });

        this.failedServers = [];
        this.failedServerSet = new Set();
        this.errorsByServer = new Map();
        this.suppressedAbortFailures = new Set();
        for (const { server, error } of cleanupFailures) {
          this.storeFailure(server, error);
        }
        for (const server of serversToRetry) {
          this.storeFailure(server, createClosedError(server));
        }
      }

      if (this.connectInParallel) {
        await this.connectAllParallel(serversToRetry);
      } else {
        for (const server of serversToRetry) {
          await this.attemptConnect(server);
        }
      }
    } finally {
      this.refreshActiveServers();
    }

    return this.active;
  }

  async close(): Promise<void> {
    await this.enqueueLifecycle(() => this.closeAll());
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async connectAll(): Promise<MCPServer[]> {
    this.failedServers = [];
    this.failedServerSet = new Set();
    this.errorsByServer = new Map();
    this.suppressedAbortFailures = new Set();

    const serversToConnect = [...this.allServers];
    let connectedServers: MCPServer[] = [];

    logger.debug(`Connecting ${serversToConnect.length} MCP server(s).`);
    try {
      if (this.connectInParallel) {
        await this.connectAllParallel(serversToConnect);
      } else {
        for (const server of serversToConnect) {
          await this.attemptConnect(server);
          if (!this.failedServerSet.has(server)) {
            connectedServers.push(server);
          }
        }
      }
    } catch (error) {
      if (this.connectInParallel) {
        connectedServers = serversToConnect.filter(
          (server) => !this.failedServerSet.has(server),
        );
      }
      const serversToCleanup = uniqueServers([
        ...connectedServers,
        ...this.failedServers,
      ]);
      await this.closeServers(serversToCleanup);
      throw error;
    }

    this.refreshActiveServers();
    return this.active;
  }

  private async closeAll(): Promise<void> {
    try {
      for (const server of [...this.allServers].reverse()) {
        await this.closeServer(server);
      }
    } finally {
      this.refreshActiveServers();
    }
  }

  private async attemptConnect(server: MCPServer): Promise<void> {
    const raiseOnError = this.strict;
    try {
      logger.debug(`Connecting ${getMcpServerLogLabel(server)}.`);
      await this.runConnect(server);
      this.connectedServerSet.add(server);
      logger.debug(`Connected ${getMcpServerLogLabel(server)}.`);
      if (this.failedServerSet.has(server)) {
        this.removeFailedServer(server);
        this.errorsByServer.delete(server);
      }
    } catch (error) {
      const err = toError(error);
      if (isAbortError(err)) {
        this.recordFailure(server, err, 'connect');
        if (!this.suppressAbortError) {
          this.suppressedAbortFailures.delete(server);
          throw err;
        }
        this.suppressedAbortFailures.add(server);
        return;
      }
      this.suppressedAbortFailures.delete(server);
      this.recordFailure(server, err, 'connect');
      if (raiseOnError) {
        throw err;
      }
    }
  }

  private refreshActiveServers(): void {
    logger.debug(
      `Active MCP servers: ${this.active.length}; failed: ${this.failedServers.length}.`,
    );
  }

  private recordFailure(server: MCPServer, error: Error, phase: string): void {
    logToolActionError(
      logger,
      `Failed to ${phase} ${getMcpServerLogLabel(server)}:`,
      error,
    );
    this.storeFailure(server, error);
  }

  private storeFailure(server: MCPServer, error: Error): void {
    if (!this.failedServerSet.has(server)) {
      this.failedServers.push(server);
      this.failedServerSet.add(server);
    }
    this.errorsByServer.set(server, error);
  }

  private async runConnect(server: MCPServer): Promise<void> {
    if (this.connectInParallel) {
      const worker = this.getWorker(server);
      await worker.connect();
      return;
    }
    this.serialCloseTasks.delete(server);
    await runWithTimeout(
      () => server.connect(),
      this.connectTimeoutMs,
      createTimeoutError('connect', server, this.connectTimeoutMs),
    );
  }

  private async closeServer(server: MCPServer): Promise<boolean> {
    try {
      logger.debug(`Closing ${getMcpServerLogLabel(server)}.`);
      await this.runClose(server);
      logger.debug(`Closed ${getMcpServerLogLabel(server)}.`);
      return true;
    } catch (error) {
      const err = toError(error);
      if (isAbortError(err)) {
        if (!this.suppressAbortError) {
          throw err;
        }
        logToolActionDebug(
          logger,
          `Close cancelled for ${getMcpServerLogLabel(server)}:`,
          err,
        );
        this.errorsByServer.set(server, err);
        return false;
      }
      logToolActionError(
        logger,
        `Failed to close ${getMcpServerLogLabel(server)}:`,
        err,
      );
      this.errorsByServer.set(server, err);
      return false;
    } finally {
      this.connectedServerSet.delete(server);
    }
  }

  private async runClose(server: MCPServer): Promise<void> {
    if (this.connectInParallel && this.workers.has(server)) {
      const worker = this.workers.get(server);
      if (worker) {
        await worker.close();
        return;
      }
    }
    const existingClose = this.serialCloseTasks.get(server);
    if (existingClose) {
      try {
        await runWithTimeoutTask(
          existingClose.task,
          this.closeTimeoutMs,
          createTimeoutError('close', server, this.closeTimeoutMs),
        );
        return;
      } catch (error) {
        if (!existingClose.settled) {
          throw error;
        }
        if (this.serialCloseTasks.get(server) === existingClose) {
          this.serialCloseTasks.delete(server);
        }
      }
    }

    const closeTask = server.close();
    const trackedCloseTask = trackCloseTask(closeTask, (error) => {
      if (error && this.serialCloseTasks.get(server) === trackedCloseTask) {
        this.errorsByServer.set(server, error);
      }
    });
    this.serialCloseTasks.set(server, trackedCloseTask);
    await runWithTimeoutTask(
      closeTask,
      this.closeTimeoutMs,
      createTimeoutError('close', server, this.closeTimeoutMs),
    );
  }

  private async closeServers(servers: MCPServer[]): Promise<MCPServer[]> {
    const closedServers = new Set<MCPServer>();
    for (const server of [...servers].reverse()) {
      try {
        if (await this.closeServer(server)) {
          closedServers.add(server);
        }
      } catch (error) {
        this.errorsByServer.set(server, toError(error));
        throw error;
      }
    }
    return servers.filter((server) => closedServers.has(server));
  }

  private async connectAllParallel(servers: MCPServer[]): Promise<void> {
    const results = await Promise.allSettled(
      servers.map((server) => this.attemptConnect(server)),
    );
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejection) {
      throw rejection.reason;
    }
    if (this.strict) {
      const firstFailure = servers.find(
        (server) =>
          this.failedServerSet.has(server) &&
          !this.suppressedAbortFailures.has(server),
      );
      if (firstFailure) {
        const error = this.errorsByServer.get(firstFailure);
        if (error) {
          throw error;
        }
        throw new Error(
          `Failed to connect MCP server '${getMcpServerExternalName(firstFailure.name)}'.`,
        );
      }
    }
  }

  private getWorker(server: MCPServer): ServerWorker {
    const worker = this.workers.get(server);
    if (!worker || worker.isDone) {
      const next = new ServerWorker(
        server,
        this.connectTimeoutMs,
        this.closeTimeoutMs,
        (error) => {
          if (error && this.workers.get(server) === next) {
            this.errorsByServer.set(server, error);
          }
        },
      );
      this.workers.set(server, next);
      return next;
    }
    return worker;
  }

  private removeFailedServer(server: MCPServer): void {
    if (this.failedServerSet.has(server)) {
      this.failedServerSet.delete(server);
    }
    this.suppressedAbortFailures.delete(server);
    this.failedServers = this.failedServers.filter(
      (failedServer) => failedServer !== server,
    );
  }
}

function trackCloseTask(
  task: Promise<void>,
  onSettled: (error: Error | null) => void,
): TrackedCloseTask {
  const tracked: TrackedCloseTask = {
    task,
    settled: false,
  };
  void task.then(
    () => {
      tracked.settled = true;
      onSettled(null);
    },
    (error) => {
      tracked.settled = true;
      onSettled(toError(error));
    },
  );
  return tracked;
}

/**
 * Connect to multiple MCP servers and return a managed MCPServers instance.
 */
export async function connectMcpServers(
  servers: MCPServer[],
  options?: MCPServersOptions,
): Promise<MCPServers> {
  return MCPServers.open(servers, options);
}

function createTimeoutError(
  action: ServerAction,
  server: MCPServer,
  timeoutMs: number | null,
): Error {
  if (timeoutMs === null) {
    return new Error(`MCP server ${action} timed out.`);
  }
  const error = new Error(
    `MCP server ${action} timed out after ${timeoutMs}ms for '${getMcpServerExternalName(server.name)}'.`,
  );
  error.name = 'TimeoutError';
  return error;
}

function createClosedError(server: MCPServer): Error {
  const error = new Error(
    `MCP server '${getMcpServerExternalName(server.name)}' is closed.`,
  );
  error.name = 'ClosedError';
  return error;
}

function createClosingError(server: MCPServer): Error {
  const error = new Error(
    `MCP server '${getMcpServerExternalName(server.name)}' is closing.`,
  );
  error.name = 'ClosingError';
  return error;
}

async function runWithTimeout(
  fn: () => Promise<void>,
  timeoutMs: number | null,
  timeoutError: Error,
): Promise<void> {
  if (timeoutMs === null) {
    await fn();
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const task = fn();

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      task.catch(() => undefined);
    }
  }
}

async function runWithTimeoutTask(
  task: Promise<void>,
  timeoutMs: number | null,
  timeoutError: Error,
): Promise<void> {
  if (timeoutMs === null) {
    await task;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      task.catch(() => undefined);
    }
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function isAbortError(error: Error): boolean {
  const code = (error as { code?: string }).code;
  return (
    error.name === 'AbortError' ||
    error.name === 'CanceledError' ||
    error.name === 'CancelledError' ||
    code === 'ABORT_ERR' ||
    code === 'ERR_ABORTED'
  );
}

function uniqueServers(servers: MCPServer[]): MCPServer[] {
  const seen = new Set<MCPServer>();
  const unique: MCPServer[] = [];
  for (const server of servers) {
    if (!seen.has(server)) {
      seen.add(server);
      unique.push(server);
    }
  }
  return unique;
}
