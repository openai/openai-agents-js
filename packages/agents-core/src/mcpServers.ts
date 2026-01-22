import { getLogger } from './logger';
import type { MCPServer } from './mcp';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

const logger = getLogger('openai-agents:mcp-servers');

type ServerAction = 'connect' | 'close';

type ServerCommand = {
  action: ServerAction;
  timeoutMs: number | null;
  resolve: () => void;
  reject: (error: Error) => void;
};

class ServerWorker {
  private queue: ServerCommand[] = [];
  private draining = false;
  private done = false;
  private closing: Promise<void> | null = null;
  private closeResult: Promise<void> | null = null;

  constructor(
    private readonly server: MCPServer,
    private readonly connectTimeoutMs: number | null,
    private readonly closeTimeoutMs: number | null,
  ) {}

  get isDone(): boolean {
    return this.done;
  }

  connect(): Promise<void> {
    return this.submit('connect', this.connectTimeoutMs);
  }

  close(): Promise<void> {
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
          this.closing = closeTask
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              this.closing = null;
            });
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
  private activeServers: MCPServer[];
  private failedServers: MCPServer[] = [];
  private failedServerSet = new Set<MCPServer>();
  private errorsByServer = new Map<MCPServer, Error>();
  private suppressedAbortFailures = new Set<MCPServer>();
  private workers = new Map<MCPServer, ServerWorker>();

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
    this.allServers = [...servers];
    this.activeServers = [...servers];

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
    return [...this.activeServers];
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
    const failedOnly = options.failedOnly ?? true;
    let serversToRetry: MCPServer[];

    if (failedOnly) {
      serversToRetry = uniqueServers(this.failedServers);
    } else {
      serversToRetry = [...this.allServers];
      this.failedServers = [];
      this.failedServerSet = new Set();
      this.errorsByServer = new Map();
      this.suppressedAbortFailures = new Set();
    }

    logger.debug(
      `Reconnecting MCP servers (failedOnly=${failedOnly}) with ${serversToRetry.length} target(s).`,
    );
    if (this.connectInParallel) {
      await this.connectAllParallel(serversToRetry);
    } else {
      for (const server of serversToRetry) {
        await this.attemptConnect(server);
      }
    }

    this.refreshActiveServers();
    return this.active;
  }

  async close(): Promise<void> {
    await this.closeAll();
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
      this.activeServers = [];
      throw error;
    }

    this.refreshActiveServers();
    return this.active;
  }

  private async closeAll(): Promise<void> {
    for (const server of [...this.allServers].reverse()) {
      await this.closeServer(server);
    }
  }

  private async attemptConnect(server: MCPServer): Promise<void> {
    const raiseOnError = this.strict;
    try {
      logger.debug(`Connecting MCP server '${server.name}'.`);
      await this.runConnect(server);
      logger.debug(`Connected MCP server '${server.name}'.`);
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
    if (this.dropFailed) {
      const failed = new Set(this.failedServerSet);
      this.activeServers = this.allServers.filter(
        (server) => !failed.has(server),
      );
    } else {
      this.activeServers = [...this.allServers];
    }
    logger.debug(
      `Active MCP servers: ${this.activeServers.length}; failed: ${this.failedServers.length}.`,
    );
  }

  private recordFailure(server: MCPServer, error: Error, phase: string): void {
    logger.error(`Failed to ${phase} MCP server '${server.name}':`, error);
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
    await runWithTimeout(
      () => server.connect(),
      this.connectTimeoutMs,
      createTimeoutError('connect', server, this.connectTimeoutMs),
    );
  }

  private async closeServer(server: MCPServer): Promise<void> {
    try {
      logger.debug(`Closing MCP server '${server.name}'.`);
      await this.runClose(server);
      logger.debug(`Closed MCP server '${server.name}'.`);
    } catch (error) {
      const err = toError(error);
      if (isAbortError(err)) {
        if (!this.suppressAbortError) {
          throw err;
        }
        logger.debug(`Close cancelled for MCP server '${server.name}': ${err}`);
        this.errorsByServer.set(server, err);
        return;
      }
      logger.error(`Failed to close MCP server '${server.name}':`, err);
      this.errorsByServer.set(server, err);
    }
  }

  private async runClose(server: MCPServer): Promise<void> {
    if (this.connectInParallel && this.workers.has(server)) {
      const worker = this.workers.get(server);
      if (worker) {
        await worker.close();
        if (worker.isDone) {
          this.workers.delete(server);
        }
        return;
      }
    }
    await runWithTimeout(
      () => server.close(),
      this.closeTimeoutMs,
      createTimeoutError('close', server, this.closeTimeoutMs),
    );
  }

  private async closeServers(servers: MCPServer[]): Promise<void> {
    for (const server of [...servers].reverse()) {
      await this.closeServer(server);
    }
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
    if (this.strict && this.failedServers.length > 0) {
      const firstFailure = this.failedServers.find(
        (server) => !this.suppressedAbortFailures.has(server),
      );
      if (firstFailure) {
        const error = this.errorsByServer.get(firstFailure);
        if (error) {
          throw error;
        }
        throw new Error(`Failed to connect MCP server '${firstFailure.name}'.`);
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
    `MCP server ${action} timed out after ${timeoutMs}ms for '${server.name}'.`,
  );
  error.name = 'TimeoutError';
  return error;
}

function createClosedError(server: MCPServer): Error {
  const error = new Error(`MCP server '${server.name}' is closed.`);
  error.name = 'ClosedError';
  return error;
}

function createClosingError(server: MCPServer): Error {
  const error = new Error(`MCP server '${server.name}' is closing.`);
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
