import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResultContent, MCPServer, MCPTool } from '../src/mcp';

const mcpLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  dontLogModelData: false,
  dontLogToolData: false,
}));

vi.mock('../src/logger', async () => {
  const actual =
    await vi.importActual<typeof import('../src/logger')>('../src/logger');
  return {
    ...actual,
    getLogger: (namespace?: string) => {
      const base = actual.getLogger(namespace);
      return {
        ...base,
        debug: mcpLogger.debug,
        error: mcpLogger.error,
        warn: mcpLogger.warn,
        get dontLogModelData() {
          return mcpLogger.dontLogModelData;
        },
        get dontLogToolData() {
          return mcpLogger.dontLogToolData;
        },
      };
    },
  };
});

import { connectMcpServers } from '../src/mcpServers';

class BaseTestServer implements MCPServer {
  public cacheToolsList = false;
  public toolFilter = undefined;
  public connectCalls = 0;
  public closeCalls = 0;
  public cleaned = false;

  constructor(public readonly name: string) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.cleaned = true;
  }

  async listTools(): Promise<MCPTool[]> {
    return [];
  }

  async callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    return [] as CallToolResultContent;
  }

  async invalidateToolsCache(): Promise<void> {
    return;
  }
}

class FlakyServer extends BaseTestServer {
  constructor(
    name: string,
    private failures: number,
  ) {
    super(name);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('connect failed');
    }
  }
}

class FailingConnectServer extends BaseTestServer {
  async connect(): Promise<void> {
    await super.connect();
    throw new Error('connect failed');
  }
}

class FixedErrorConnectServer extends BaseTestServer {
  constructor(
    name: string,
    readonly error: Error,
  ) {
    super(name);
  }

  async connect(): Promise<void> {
    await super.connect();
    throw this.error;
  }
}

class HangingConnectServer extends BaseTestServer {
  async connect(): Promise<void> {
    await super.connect();
    await new Promise<void>(() => {});
  }
}

class AbortConnectServer extends BaseTestServer {
  async connect(): Promise<void> {
    await super.connect();
    const error = new Error('connect aborted');
    error.name = 'AbortError';
    throw error;
  }
}

class AbortCloseServer extends BaseTestServer {
  async close(): Promise<void> {
    this.closeCalls += 1;
    const error = new Error('close aborted');
    error.name = 'AbortError';
    throw error;
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'];
  let reject: Deferred<T>['reject'];
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

class SlowCloseServer extends BaseTestServer {
  constructor(
    name: string,
    private readonly closeGate: Deferred<void>,
    private readonly closeStarted?: Deferred<void>,
  ) {
    super(name);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closeStarted?.resolve();
    await this.closeGate.promise;
    this.cleaned = true;
  }
}

class SequencedCloseServer extends BaseTestServer {
  constructor(
    name: string,
    private readonly closeGates: Deferred<void>[],
  ) {
    super(name);
  }

  async close(): Promise<void> {
    const closeGate = this.closeGates[this.closeCalls];
    this.closeCalls += 1;
    if (closeGate) {
      await closeGate.promise;
    }
    this.cleaned = true;
  }
}

class FlakyCloseServer extends BaseTestServer {
  constructor(
    name: string,
    private failures: number,
  ) {
    super(name);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('close failed');
    }
    this.cleaned = true;
  }
}

class ResourceTrackingServer extends BaseTestServer {
  public resourceOpen = false;
  public failClose: boolean;

  constructor(
    name: string,
    private readonly lifecycleEvents: string[],
    options: { failConnectCall?: number; failClose?: boolean } = {},
  ) {
    super(name);
    this.failConnectCall = options.failConnectCall;
    this.failClose = options.failClose ?? false;
  }

  private readonly failConnectCall: number | undefined;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.lifecycleEvents.push(`${this.name}:connect`);
    if (this.resourceOpen) {
      throw new Error('connect called before cleanup');
    }
    this.resourceOpen = true;
    if (this.connectCalls === this.failConnectCall) {
      throw new Error('connect failed after opening resource');
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.lifecycleEvents.push(`${this.name}:close`);
    if (this.failClose) {
      throw new Error('close failed');
    }
    this.resourceOpen = false;
    this.cleaned = true;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe('MCPServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpLogger.dontLogModelData = false;
    mcpLogger.dontLogToolData = false;
  });

  it('uses fixed messages for URL-derived server names when connecting fails in redacted mode', async () => {
    const serverName =
      'streamable-http: https://example.test/mcp/SECRET_MCP_PATH_123?token=SECRET_MCP_QUERY_123';
    const server = new FlakyServer(serverName, 1);
    mcpLogger.dontLogToolData = true;

    const session = await connectMcpServers([server], {
      connectTimeoutMs: null,
      closeTimeoutMs: null,
    });

    expect(session.failed).toEqual([server]);
    expect(mcpLogger.error).toHaveBeenCalledWith(
      'Failed to connect MCP server:',
      'object',
    );
    const calls = JSON.stringify([
      ...mcpLogger.debug.mock.calls,
      ...mcpLogger.error.mock.calls,
    ]);
    expect(calls).not.toContain('SECRET_MCP_PATH_123');
    expect(calls).not.toContain('SECRET_MCP_QUERY_123');
  });

  it('uses fixed messages for custom server names when closing fails in redacted mode', async () => {
    const serverName = 'SECRET_CUSTOM_MCP_SERVER_123';
    const server = new FlakyCloseServer(serverName, 1);
    mcpLogger.dontLogToolData = true;
    const session = await connectMcpServers([server], {
      connectTimeoutMs: null,
      closeTimeoutMs: null,
    });

    await session.close();

    expect(mcpLogger.error).toHaveBeenCalledWith(
      'Failed to close MCP server:',
      'object',
    );
    const calls = JSON.stringify([
      ...mcpLogger.debug.mock.calls,
      ...mcpLogger.error.mock.calls,
    ]);
    expect(calls).not.toContain(serverName);
  });

  it('uses fixed messages when closing is cancelled in redacted mode', async () => {
    const serverName = 'SECRET_CANCELLED_MCP_SERVER_123';
    const server = new AbortCloseServer(serverName);
    mcpLogger.dontLogToolData = true;
    const session = await connectMcpServers([server], {
      connectTimeoutMs: null,
      closeTimeoutMs: null,
    });

    await session.close();

    expect(mcpLogger.debug).toHaveBeenCalledWith(
      'Close cancelled for MCP server:',
      'object',
    );
    expect(session.errors.get(server)?.name).toBe('AbortError');
    const calls = JSON.stringify([
      ...mcpLogger.debug.mock.calls,
      ...mcpLogger.error.mock.calls,
    ]);
    expect(calls).not.toContain(serverName);
  });

  it('does not read server names while formatting redacted logs', async () => {
    const server = new FlakyServer('unused', 1);
    let nameReads = 0;
    Object.defineProperty(server, 'name', {
      configurable: true,
      get: () => {
        nameReads += 1;
        return 'SECRET_MCP_GETTER_NAME_123';
      },
    });
    mcpLogger.dontLogToolData = true;

    const session = await connectMcpServers([server], {
      connectTimeoutMs: null,
      closeTimeoutMs: null,
    });

    expect(session.failed).toEqual([server]);
    expect(nameReads).toBe(0);
    expect(mcpLogger.error).toHaveBeenCalledWith(
      'Failed to connect MCP server:',
      'object',
    );
  });

  it('preserves MCP server failure diagnostics when tool logging is enabled', async () => {
    const serverName = 'diagnostic-server';
    const server = new FlakyServer(serverName, 1);

    await connectMcpServers([server], {
      connectTimeoutMs: null,
      closeTimeoutMs: null,
    });

    expect(mcpLogger.error).toHaveBeenCalledWith(
      `Failed to connect MCP server '${serverName}':`,
      expect.any(Error),
    );
  });

  it('preserves arbitrary errors from custom MCP servers', async () => {
    const error = new Error('custom server password_marker detail');
    const server = new FixedErrorConnectServer('custom-server', error);

    const session = await connectMcpServers([server], {
      connectTimeoutMs: null,
      closeTimeoutMs: null,
    });

    expect(session.errors.get(server)).toBe(error);
  });

  it('removes credentials from URL-derived lifecycle timeout errors', async () => {
    const endpoint = new URL('https://example.test/mcp');
    endpoint.username = 'user_marker';
    endpoint.password = 'password_marker';
    endpoint.searchParams.set('token', 'query_marker');
    endpoint.hash = 'fragment_marker';
    const server = new HangingConnectServer(
      `streamable-http: ${endpoint.toString()}`,
    );

    const session = await connectMcpServers([server], {
      connectTimeoutMs: 1,
      closeTimeoutMs: null,
    });

    const error = session.errors.get(server);
    expect(error?.message).toContain('https://example.test/mcp');
    expect(error?.message).not.toContain('user_marker');
    expect(error?.message).not.toContain('password_marker');
    expect(error?.message).not.toContain('query_marker');
    expect(error?.message).not.toContain('fragment_marker');
    await session.close();
  });

  it('removes credentials from malformed URL-derived lifecycle errors', async () => {
    const server = new HangingConnectServer(
      `streamable-http: https://${['user_marker', 'password_marker'].join(
        ':',
      )}@`,
    );

    const session = await connectMcpServers([server], {
      connectTimeoutMs: 1,
      closeTimeoutMs: null,
    });

    const error = session.errors.get(server);
    expect(error?.message).toContain('streamable-http: <redacted endpoint>');
    expect(error?.message).not.toContain('user_marker');
    expect(error?.message).not.toContain('password_marker');
    await session.close();
  });

  it.each([false, true])(
    'owns repeated server instances once while preserving order (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const first = new ResourceTrackingServer('first', lifecycleEvents);
      const second = new ResourceTrackingServer('second', lifecycleEvents);
      const session = await connectMcpServers([first, second, first], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
      });

      expect(session.all).toEqual([first, second]);
      expect(session.active).toEqual([first, second]);
      expect(first.connectCalls).toBe(1);
      expect(second.connectCalls).toBe(1);

      lifecycleEvents.length = 0;
      await session.close();

      expect(lifecycleEvents).toEqual(['second:close', 'first:close']);
      expect(first.closeCalls).toBe(1);
      expect(second.closeCalls).toBe(1);
      expect(session.active).toEqual([]);
    },
  );

  it.each([false, true])(
    'keeps servers inactive after close until reconnecting all (parallel=%s)',
    async (connectInParallel) => {
      const server = new BaseTestServer('server');
      const session = await connectMcpServers([server], {
        connectInParallel,
      });

      await session.close();

      expect(session.active).toEqual([]);
      await expect(session.reconnect()).resolves.toEqual([]);
      expect(server.connectCalls).toBe(1);

      await expect(session.reconnect({ failedOnly: false })).resolves.toEqual([
        server,
      ]);
      expect(session.active).toEqual([server]);
      expect(server.connectCalls).toBe(2);

      await session.close();
    },
  );

  it.each(['close', 'reconnect'] as const)(
    'updates active servers while a later %s cleanup is pending',
    async (operation) => {
      const closeGate = createDeferred<void>();
      const closeStarted = createDeferred<void>();
      const slow = new SlowCloseServer('slow', closeGate, closeStarted);
      const fast = new BaseTestServer('fast');
      const session = await connectMcpServers([slow, fast], {
        closeTimeoutMs: null,
      });

      const operationPromise =
        operation === 'close'
          ? session.close()
          : session.reconnect({ failedOnly: false });
      await closeStarted.promise;

      expect(fast.cleaned).toBe(true);
      expect(session.active).toEqual([slow]);

      closeGate.resolve();
      await operationPromise;

      if (operation === 'close') {
        expect(session.active).toEqual([]);
      } else {
        expect(session.active).toEqual([slow, fast]);
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'serializes overlapping close calls (parallel=%s)',
    async (connectInParallel) => {
      const closeGate = createDeferred<void>();
      const server = new SlowCloseServer('slow', closeGate);
      const session = await connectMcpServers([server], {
        connectInParallel,
        closeTimeoutMs: null,
      });

      const firstClose = session.close();
      const secondClose = session.close();
      await Promise.resolve();

      expect(server.closeCalls).toBe(1);

      closeGate.resolve();
      await Promise.all([firstClose, secondClose]);

      expect(server.closeCalls).toBe(1);
      expect(session.errors.size).toBe(0);
    },
  );

  it.each([false, true])(
    'waits for an overlapping close before reconnecting all servers (parallel=%s)',
    async (connectInParallel) => {
      const closeGate = createDeferred<void>();
      const server = new SlowCloseServer('slow', closeGate);
      const session = await connectMcpServers([server], {
        connectInParallel,
        closeTimeoutMs: null,
      });

      const closePromise = session.close();
      const reconnectPromise = session.reconnect({ failedOnly: false });
      await Promise.resolve();

      expect(server.closeCalls).toBe(1);
      expect(server.connectCalls).toBe(1);

      closeGate.resolve();
      await closePromise;
      await expect(reconnectPromise).resolves.toEqual([server]);

      expect(server.closeCalls).toBe(1);
      expect(server.connectCalls).toBe(2);
      expect(session.active).toEqual([server]);
      expect(session.failed).toEqual([]);
      expect(session.errors.size).toBe(0);

      await session.close();
    },
  );

  it.each([false, true])(
    'serializes overlapping full reconnects across multiple servers (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const first = new ResourceTrackingServer('first', lifecycleEvents);
      const second = new ResourceTrackingServer('second', lifecycleEvents);
      const session = await connectMcpServers([first, second], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
      });
      lifecycleEvents.length = 0;

      const firstReconnect = session.reconnect({ failedOnly: false });
      const secondReconnect = session.reconnect({ failedOnly: false });
      await Promise.all([firstReconnect, secondReconnect]);

      expect(lifecycleEvents).toEqual([
        'second:close',
        'first:close',
        'first:connect',
        'second:connect',
        'second:close',
        'first:close',
        'first:connect',
        'second:connect',
      ]);
      expect(first.connectCalls).toBe(3);
      expect(second.connectCalls).toBe(3);
      expect(first.closeCalls).toBe(2);
      expect(second.closeCalls).toBe(2);
      expect(session.active).toEqual([first, second]);
      expect(session.failed).toEqual([]);
      expect(session.errors.size).toBe(0);

      await session.close();
    },
  );

  it.each([false, true])(
    'bounds later waiters and reconnects after a timed-out close succeeds (parallel=%s)',
    async (connectInParallel) => {
      const closeGate = createDeferred<void>();
      const server = new SlowCloseServer('slow', closeGate);
      const session = await connectMcpServers([server], {
        connectInParallel,
        closeTimeoutMs: 10,
      });

      await withTimeout(session.close(), 500);
      expect(session.errors.get(server)?.name).toBe('TimeoutError');
      expect(session.active).toEqual([]);

      await expect(
        withTimeout(session.reconnect({ failedOnly: false }), 500),
      ).resolves.toEqual([]);
      expect(server.closeCalls).toBe(1);
      expect(server.connectCalls).toBe(1);
      expect(session.active).toEqual([]);
      expect(session.failed).toEqual([server]);
      expect(session.errors.get(server)?.name).toBe('TimeoutError');

      closeGate.resolve();
      await closeGate.promise;
      await Promise.resolve();

      await expect(session.reconnect({ failedOnly: false })).resolves.toEqual([
        server,
      ]);
      expect(server.closeCalls).toBe(1);
      expect(server.connectCalls).toBe(2);
      expect(session.active).toEqual([server]);
      expect(session.failed).toEqual([]);
      expect(session.errors.size).toBe(0);

      await session.close();
    },
  );

  it.each([false, true])(
    'preserves a late close failure and permits a later retry (parallel=%s)',
    async (connectInParallel) => {
      const firstCloseGate = createDeferred<void>();
      const secondCloseGate = createDeferred<void>();
      secondCloseGate.resolve();
      const server = new SequencedCloseServer('sequenced', [
        firstCloseGate,
        secondCloseGate,
      ]);
      const session = await connectMcpServers([server], {
        connectInParallel,
        closeTimeoutMs: 10,
      });
      const lateError = new Error('late close failed');

      await withTimeout(session.close(), 500);
      expect(session.errors.get(server)?.name).toBe('TimeoutError');

      firstCloseGate.reject(lateError);
      await Promise.resolve();
      await Promise.resolve();

      expect(session.errors.get(server)).toBe(lateError);

      await expect(session.reconnect({ failedOnly: false })).resolves.toEqual([
        server,
      ]);
      expect(server.closeCalls).toBe(2);
      expect(server.connectCalls).toBe(2);
      expect(session.active).toEqual([server]);
      expect(session.failed).toEqual([]);
      expect(session.errors.size).toBe(0);

      await session.close();
    },
  );

  it.each([false, true])(
    'continues queued lifecycle work after a strict reconnect failure (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const server = new ResourceTrackingServer('strict', lifecycleEvents, {
        failConnectCall: 2,
      });
      const session = await connectMcpServers([server], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
        strict: true,
      });

      const reconnectPromise = session.reconnect({ failedOnly: false });
      const closePromise = session.close();

      await expect(reconnectPromise).rejects.toThrow(
        'connect failed after opening resource',
      );
      await expect(closePromise).resolves.toBeUndefined();

      expect(server.resourceOpen).toBe(false);
      expect(server.connectCalls).toBe(2);
      expect(server.closeCalls).toBe(2);
      expect(session.failed).toEqual([server]);
      expect(session.errors.get(server)?.message).toBe(
        'connect failed after opening resource',
      );
    },
  );

  it('reconnects failed servers only by default', async () => {
    const server = new FlakyServer('flaky', 1);
    const session = await connectMcpServers([server]);

    expect(session.active).toEqual([]);
    expect(session.failed).toEqual([server]);

    await session.reconnect();
    expect(session.active).toEqual([server]);
    expect(session.failed).toEqual([]);
  });

  it.each([false, true])(
    'cleans a partially opened server before reconnecting (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const healthy = new BaseTestServer('healthy');
      const failed = new ResourceTrackingServer('failed', lifecycleEvents, {
        failConnectCall: 1,
      });
      const session = await connectMcpServers([healthy, failed], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
      });

      try {
        expect(session.active).toEqual([healthy]);
        expect(session.failed).toEqual([failed]);

        await session.reconnect();

        expect(lifecycleEvents).toEqual([
          'failed:connect',
          'failed:close',
          'failed:connect',
        ]);
        expect(failed.resourceOpen).toBe(true);
        expect(session.active).toEqual([healthy, failed]);
        expect(session.failed).toEqual([]);
        expect(session.errors.has(failed)).toBe(false);
        expect(healthy.connectCalls).toBe(1);
        expect(healthy.closeCalls).toBe(0);
      } finally {
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'does not reconnect after cleanup fails (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const server = new ResourceTrackingServer('failed', lifecycleEvents, {
        failConnectCall: 1,
        failClose: true,
      });
      const session = await connectMcpServers([server], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
      });

      await session.reconnect();

      expect(lifecycleEvents).toEqual(['failed:connect', 'failed:close']);
      expect(server.connectCalls).toBe(1);
      expect(server.resourceOpen).toBe(true);
      expect(session.active).toEqual([]);
      expect(session.failed).toEqual([server]);
      expect(session.errors.get(server)?.message).toBe('close failed');

      server.failClose = false;
      await session.close();
    },
  );

  it('deduplicates failures across reconnect attempts', async () => {
    const server = new FlakyServer('flaky', 2);
    const session = await connectMcpServers([server], {
      connectInParallel: true,
    });

    expect(session.active).toEqual([]);
    expect(session.failed).toEqual([server]);
    expect(server.connectCalls).toBe(1);

    await session.reconnect();
    expect(session.active).toEqual([]);
    expect(session.failed).toEqual([server]);
    expect(server.connectCalls).toBe(2);

    await session.reconnect();
    expect(session.active).toEqual([server]);
    expect(session.failed).toEqual([]);
    expect(server.connectCalls).toBe(3);
  });

  it('retries all servers when failedOnly is false', async () => {
    const server = new FlakyServer('flaky', 1);
    const session = await connectMcpServers([server]);

    expect(session.active).toEqual([]);
    expect(session.failed).toEqual([server]);
    expect(server.connectCalls).toBe(1);

    await session.reconnect({ failedOnly: false });
    expect(session.active).toEqual([server]);
    expect(session.failed).toEqual([]);
    expect(server.connectCalls).toBe(2);
  });

  it.each([false, true])(
    'cleans every reconnect-all target before reconnecting successful cleanups (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const cleanupFailure = new ResourceTrackingServer(
        'cleanup-failure',
        lifecycleEvents,
        { failClose: true },
      );
      const reconnectable = new ResourceTrackingServer(
        'reconnectable',
        lifecycleEvents,
      );
      const session = await connectMcpServers([cleanupFailure, reconnectable], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
      });
      lifecycleEvents.length = 0;

      await session.reconnect({ failedOnly: false });

      expect(lifecycleEvents).toEqual([
        'reconnectable:close',
        'cleanup-failure:close',
        'reconnectable:connect',
      ]);
      expect(cleanupFailure.connectCalls).toBe(1);
      expect(reconnectable.connectCalls).toBe(2);
      expect(session.active).toEqual([reconnectable]);
      expect(session.failed).toEqual([cleanupFailure]);
      expect(session.errors.get(cleanupFailure)?.message).toBe('close failed');

      cleanupFailure.failClose = false;
      await session.close();
    },
  );

  it.each([false, true])(
    'keeps closed servers inactive when strict reconnect-all fails (parallel=%s)',
    async (connectInParallel) => {
      const lifecycleEvents: string[] = [];
      const reconnectFailure = new ResourceTrackingServer(
        'reconnect-failure',
        lifecycleEvents,
        { failConnectCall: 2 },
      );
      const peer = new ResourceTrackingServer('peer', lifecycleEvents);
      const session = await connectMcpServers([reconnectFailure, peer], {
        connectInParallel,
        connectTimeoutMs: null,
        closeTimeoutMs: null,
        strict: true,
      });
      lifecycleEvents.length = 0;

      await expect(session.reconnect({ failedOnly: false })).rejects.toThrow(
        'connect failed after opening resource',
      );

      expect(session.failed).toContain(reconnectFailure);
      expect(session.active).not.toContain(reconnectFailure);
      if (connectInParallel) {
        expect(session.active).toEqual([peer]);
        expect(session.failed).not.toContain(peer);
      } else {
        expect(session.active).toEqual([]);
        expect(session.failed).toContain(peer);
        expect(session.errors.get(peer)?.name).toBe('ClosedError');
      }

      await session.close();
    },
  );

  it('keeps failed servers active when dropFailed is false', async () => {
    const server = new FlakyServer('flaky', 1);
    const session = await connectMcpServers([server], { dropFailed: false });

    expect(session.active).toEqual([server]);
    expect(session.failed).toEqual([server]);
    expect(session.errors.get(server)?.message).toBe('connect failed');
  });

  it('keeps cleaned servers active when dropFailed is false', async () => {
    const server = new BaseTestServer('server');
    const session = await connectMcpServers([server], { dropFailed: false });

    await session.close();

    expect(session.active).toEqual([server]);
  });

  it('cleans up connected servers on strict connect failure', async () => {
    const connected = new BaseTestServer('connected');
    const failing = new FlakyServer('failing', 1);

    await expect(
      connectMcpServers([connected, failing], { strict: true }),
    ).rejects.toThrow('connect failed');

    expect(connected.cleaned).toBe(true);
  });

  it('cleans up failing servers on strict connect failure', async () => {
    const failing = new FailingConnectServer('failing');

    await expect(
      connectMcpServers([failing], { strict: true }),
    ).rejects.toThrow('connect failed');

    expect(failing.cleaned).toBe(true);
  });

  it('cleans up failing servers in parallel strict mode', async () => {
    const failing = new FailingConnectServer('failing');

    await expect(
      connectMcpServers([failing], { strict: true, connectInParallel: true }),
    ).rejects.toThrow('connect failed');

    expect(failing.cleaned).toBe(true);
  });

  it('bubbles abort errors in parallel when suppressAbortError is false', async () => {
    const aborting = new AbortConnectServer('aborting');

    await expect(
      connectMcpServers([aborting], {
        connectInParallel: true,
        suppressAbortError: false,
      }),
    ).rejects.toThrow('connect aborted');

    expect(aborting.cleaned).toBe(true);
  });

  it('does not throw for suppressed aborts in parallel strict mode', async () => {
    const aborting = new AbortConnectServer('aborting');
    const session = await connectMcpServers([aborting], {
      connectInParallel: true,
      strict: true,
      suppressAbortError: true,
    });

    expect(session.active).toEqual([]);
    expect(session.failed).toEqual([aborting]);
    expect(session.errors.get(aborting)?.name).toBe('AbortError');
  });

  it('cleans up aborting servers in serial when suppressAbortError is false', async () => {
    const aborting = new AbortConnectServer('aborting');

    await expect(
      connectMcpServers([aborting], { suppressAbortError: false }),
    ).rejects.toThrow('connect aborted');

    expect(aborting.cleaned).toBe(true);
  });

  it.each([false, true])(
    'keeps reconnect-all targets inactive when cleanup aborts (parallel=%s)',
    async (connectInParallel) => {
      const aborting = new AbortCloseServer('aborting');
      const session = await connectMcpServers([aborting], {
        connectInParallel,
        suppressAbortError: false,
      });

      await expect(session.reconnect({ failedOnly: false })).rejects.toThrow(
        'close aborted',
      );

      expect(session.active).toEqual([]);
      expect(session.failed).toEqual([aborting]);
      expect(session.errors.get(aborting)?.name).toBe('AbortError');
      expect(aborting.connectCalls).toBe(1);
    },
  );

  it.each([false, true])(
    'refreshes active servers when close abort propagates (parallel=%s)',
    async (connectInParallel) => {
      const aborting = new AbortCloseServer('aborting');
      const session = await connectMcpServers([aborting], {
        connectInParallel,
        suppressAbortError: false,
      });

      await expect(session.close()).rejects.toThrow('close aborted');

      expect(session.active).toEqual([]);
      expect(aborting.closeCalls).toBe(1);
    },
  );

  it.each([false, true])(
    'skips reconnect-all targets after suppressed cleanup aborts (parallel=%s)',
    async (connectInParallel) => {
      const aborting = new AbortCloseServer('aborting');
      const session = await connectMcpServers([aborting], {
        connectInParallel,
      });

      await expect(session.reconnect({ failedOnly: false })).resolves.toEqual(
        [],
      );

      expect(session.failed).toEqual([aborting]);
      expect(session.errors.get(aborting)?.name).toBe('AbortError');
      expect(aborting.connectCalls).toBe(1);
    },
  );

  it.each([false, true])(
    'bounds commands while a timed-out close is still in flight (parallel=%s)',
    async (connectInParallel) => {
      const closeGate = createDeferred<void>();
      const server = new SlowCloseServer('slow', closeGate);
      const session = await connectMcpServers([server], {
        connectInParallel,
        closeTimeoutMs: 1,
      });

      await session.close();
      expect(session.active).toEqual([]);
      const reconnectPromise = session.reconnect({ failedOnly: false });
      await expect(withTimeout(reconnectPromise, 500)).resolves.toEqual([]);
      expect(session.failed).toEqual([server]);
      expect(session.errors.get(server)?.name).toBe('TimeoutError');
      closeGate.resolve();
    },
  );

  it.each([false, true])(
    'allows retrying close after a failure (parallel=%s)',
    async (connectInParallel) => {
      const server = new FlakyCloseServer('flaky', 1);
      const session = await connectMcpServers([server], {
        connectInParallel,
      });

      await session.close();
      expect(server.cleaned).toBe(false);
      expect(server.closeCalls).toBe(1);
      expect(session.active).toEqual([]);

      await session.close();
      expect(server.cleaned).toBe(true);
      expect(server.closeCalls).toBe(2);
      expect(session.active).toEqual([]);
    },
  );

  it('attaches async dispose when supported', async () => {
    const server = new BaseTestServer('server');
    const session = await connectMcpServers([server]);
    const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;

    if (asyncDispose) {
      const target = session as unknown as Record<symbol, unknown>;
      expect(typeof target[asyncDispose]).toBe('function');
    }

    await session.close();
  });
});
