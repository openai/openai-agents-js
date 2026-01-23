import { describe, expect, it, vi } from 'vitest';
import type { CallToolResultContent, MCPServer, MCPTool } from '../src/mcp';

vi.mock('../src/logger', async () => {
  const actual =
    await vi.importActual<typeof import('../src/logger')>('../src/logger');
  return {
    ...actual,
    getLogger: (namespace?: string) => {
      const base = actual.getLogger(namespace);
      return {
        ...base,
        error: () => {},
        warn: () => {},
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

class AbortConnectServer extends BaseTestServer {
  async connect(): Promise<void> {
    await super.connect();
    const error = new Error('connect aborted');
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
  ) {
    super(name);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeGate.promise;
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
  it('reconnects failed servers only by default', async () => {
    const server = new FlakyServer('flaky', 1);
    const session = await connectMcpServers([server]);

    expect(session.active).toEqual([]);
    expect(session.failed).toEqual([server]);

    await session.reconnect();
    expect(session.active).toEqual([server]);
    expect(session.failed).toEqual([]);
  });

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

  it('keeps failed servers active when dropFailed is false', async () => {
    const server = new FlakyServer('flaky', 1);
    const session = await connectMcpServers([server], { dropFailed: false });

    expect(session.active).toEqual([server]);
    expect(session.failed).toEqual([server]);
    expect(session.errors.get(server)?.message).toBe('connect failed');
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

  it('rejects commands while a timed-out close is still in flight', async () => {
    const closeGate = createDeferred<void>();
    const server = new SlowCloseServer('slow', closeGate);
    const session = await connectMcpServers([server], {
      connectInParallel: true,
      closeTimeoutMs: 1,
    });

    await session.close();
    const reconnectPromise = session.reconnect({ failedOnly: false });
    await expect(withTimeout(reconnectPromise, 500)).resolves.toEqual([]);
    expect(session.failed).toEqual([server]);
    expect(session.errors.get(server)?.name).toBe('ClosingError');
    closeGate.resolve();
  });

  it('allows retrying close after a failure in parallel workers', async () => {
    const server = new FlakyCloseServer('flaky', 1);
    const session = await connectMcpServers([server], {
      connectInParallel: true,
    });

    await session.close();
    expect(server.cleaned).toBe(false);
    expect(server.closeCalls).toBe(1);

    await session.close();
    expect(server.cleaned).toBe(true);
    expect(server.closeCalls).toBe(2);
  });

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
