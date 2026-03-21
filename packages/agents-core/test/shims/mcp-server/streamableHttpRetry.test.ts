import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types';
import { MCPServerStreamableHttp } from '../../../src/mcp';
import type { Logger } from '../../../src/logger';
import { NodeMCPServerStreamableHttp } from '../../../src/shims/mcp-server/node';

const TEST_URL = 'https://example.invalid/mcp';
const TEST_PROTOCOL_VERSION = '2025-06-18';
const silentLogger: Logger = {
  namespace: 'openai-agents:test:mcp-streamable-http-retry',
  debug: () => {},
  error: () => {},
  warn: () => {},
  dontLogModelData: false,
  dontLogToolData: false,
};

type MockTool = {
  description?: string;
  execution?: {
    taskSupport?: 'forbidden' | 'optional' | 'required';
  };
  inputSchema?: Record<string, unknown>;
  name: string;
  outputSchema?: {
    properties?: Record<string, { type?: string }>;
    required?: string[];
    type?: string;
  };
};

class MockStreamableHTTPError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
    this.name = 'StreamableHTTPError';
    this.code = code;
  }
}

class MockStreamableHTTPClientTransport {
  static instances: MockStreamableHTTPClientTransport[] = [];

  readonly instanceIndex: number;
  url: URL;
  options: {
    authProvider?: any;
    fetch?: any;
    reconnectionOptions?: any;
    requestInit?: any;
    sessionId?: string;
  };
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  aborted = false;
  closeMock = vi.fn().mockResolvedValue(undefined);
  terminateSessionMock = vi.fn().mockResolvedValue(undefined);

  constructor(
    url: URL,
    options: {
      authProvider?: any;
      fetch?: any;
      reconnectionOptions?: any;
      requestInit?: any;
      sessionId?: string;
    },
  ) {
    this.instanceIndex = MockStreamableHTTPClientTransport.instances.length;
    this.url = url;
    this.options = options;
    this.sessionId = options.sessionId;
    MockStreamableHTTPClientTransport.instances.push(this);
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async start(): Promise<void> {}

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.aborted = true;
    await this.closeMock();
  }

  async terminateSession(): Promise<void> {
    if (this.aborted) {
      throw new Error('Transport aborted');
    }
    await this.terminateSessionMock();
  }
}

class MockClient {
  static instances: MockClient[] = [];
  static connectHandlers: Array<
    ((this: MockClient) => Promise<void>) | undefined
  > = [];
  static listToolsResults: Array<MockTool[] | undefined> = [];
  static sessionIdAssignments: Array<string | null | undefined> = [];
  static notificationHandlers: Array<
    | ((
        this: MockClient,
        notification: {
          method: string;
          params?: Record<string, unknown>;
        },
      ) => Promise<void>)
    | undefined
  > = [];
  static callToolHandlers: Array<
    | ((
        this: MockClient,
        params: {
          name: string;
          arguments: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        },
      ) => Promise<any>)
    | undefined
  > = [];

  readonly instanceIndex: number;
  transport: MockStreamableHTTPClientTransport | null = null;
  connectMock = vi.fn().mockResolvedValue(undefined);
  closeMock = vi.fn().mockResolvedValue(undefined);
  notificationMock = vi.fn().mockResolvedValue(undefined);
  private cachedRequiredTaskTools = new Set<string>();
  private cachedToolOutputSchemas = new Map<
    string,
    NonNullable<MockTool['outputSchema']>
  >();

  constructor(_options: { name: string; version: string }) {
    this.instanceIndex = MockClient.instances.length;
    MockClient.instances.push(this);
  }

  private get transportIndex(): number {
    return this.transport?.instanceIndex ?? 0;
  }

  cacheToolMetadata(tools: MockTool[]): void {
    this.cachedRequiredTaskTools.clear();
    this.cachedToolOutputSchemas.clear();

    for (const tool of tools) {
      if (tool.execution?.taskSupport === 'required') {
        this.cachedRequiredTaskTools.add(tool.name);
      }

      if (tool.outputSchema) {
        this.cachedToolOutputSchemas.set(tool.name, tool.outputSchema);
      }
    }
  }

  async connect(
    transport: MockStreamableHTTPClientTransport,
    _options?: unknown,
  ): Promise<void> {
    this.transport = transport;
    const assignedSessionId =
      MockClient.sessionIdAssignments[transport.instanceIndex];
    if (assignedSessionId !== undefined) {
      transport.sessionId = assignedSessionId ?? undefined;
      if (transport.sessionId !== undefined) {
        transport.setProtocolVersion(TEST_PROTOCOL_VERSION);
      }
    }
    const handler = MockClient.connectHandlers[transport.instanceIndex];
    if (handler) {
      await handler.call(this);
    } else {
      await this.connectMock();
    }

    if (
      transport.sessionId === undefined &&
      MockClient.sessionIdAssignments[transport.instanceIndex] === undefined
    ) {
      transport.sessionId = `generated-session-${transport.instanceIndex}`;
      transport.setProtocolVersion(TEST_PROTOCOL_VERSION);
    }
  }

  async listTools(): Promise<{ tools: MockTool[] }> {
    const tools = MockClient.listToolsResults[this.transportIndex] ?? [];
    this.cacheToolMetadata(tools);
    return { tools };
  }

  async notification(notification: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<void> {
    const handler = MockClient.notificationHandlers[this.transportIndex];
    if (handler) {
      await handler.call(this, notification);
      return;
    }

    await this.notificationMock(notification);
  }

  async callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<any> {
    if (this.cachedRequiredTaskTools.has(params.name)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool "${params.name}" requires task-based execution.`,
      );
    }

    const handler = MockClient.callToolHandlers[this.transportIndex];
    const result = handler
      ? await handler.call(this, params)
      : {
          content: [
            {
              type: 'text',
              text: `ok:${this.instanceIndex}:${this.transportIndex}`,
            },
          ],
        };

    this.validateStructuredContent(params.name, result);
    return result;
  }

  private validateStructuredContent(toolName: string, result: any): void {
    const outputSchema = this.cachedToolOutputSchemas.get(toolName);
    if (!outputSchema) {
      return;
    }

    if (result.isError) {
      return;
    }

    if (!result.structuredContent) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool ${toolName} has an output schema but did not return structured content`,
      );
    }

    if (
      outputSchema.type !== 'object' ||
      typeof result.structuredContent !== 'object' ||
      result.structuredContent === null ||
      Array.isArray(result.structuredContent)
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Structured content does not match the tool's output schema.`,
      );
    }

    const structuredContent = result.structuredContent as Record<
      string,
      unknown
    >;

    for (const key of outputSchema.required ?? []) {
      if (!(key in structuredContent)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Structured content does not match the tool's output schema.`,
        );
      }
    }

    for (const [key, propertySchema] of Object.entries(
      outputSchema.properties ?? {},
    )) {
      if (
        propertySchema.type === 'string' &&
        key in structuredContent &&
        typeof structuredContent[key] !== 'string'
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Structured content does not match the tool's output schema.`,
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.closeMock();
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
}

vi.mock(
  '@modelcontextprotocol/sdk/client/streamableHttp.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
    StreamableHTTPError: MockStreamableHTTPError,
  }),
);

vi.mock(
  '@modelcontextprotocol/sdk/client/index.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    Client: MockClient,
  }),
);

function createServer(
  name: string,
  overrides: Record<string, unknown> = {},
): NodeMCPServerStreamableHttp {
  return new NodeMCPServerStreamableHttp({
    url: TEST_URL,
    name,
    logger: silentLogger,
    fetch: vi.fn(async () => {
      throw new Error(
        'Unexpected network request in streamableHttpRetry.test.',
      );
    }),
    ...overrides,
  });
}

function createPublicServer(
  name: string,
  overrides: Record<string, unknown> = {},
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    url: TEST_URL,
    name,
    logger: silentLogger,
    fetch: vi.fn(async () => {
      throw new Error(
        'Unexpected network request in streamableHttpRetry.test.',
      );
    }),
    ...overrides,
  });
}

function throwProtocolNotConnected(this: MockClient): never {
  this.transport = null;
  throw new Error('Not connected');
}

describe('NodeMCPServerStreamableHttp closed-session recovery', () => {
  beforeAll(() => {
    MockClient.instances = [];
    MockClient.connectHandlers = [];
    MockClient.listToolsResults = [];
    MockClient.sessionIdAssignments = [];
    MockClient.notificationHandlers = [];
    MockClient.callToolHandlers = [];
    MockStreamableHTTPClientTransport.instances = [];
  });

  beforeEach(() => {
    MockClient.instances = [];
    MockClient.connectHandlers = [];
    MockClient.listToolsResults = [];
    MockClient.sessionIdAssignments = [];
    MockClient.notificationHandlers = [];
    MockClient.callToolHandlers = [];
    MockStreamableHTTPClientTransport.instances = [];
  });

  it('heals closed streamable HTTP sessions for follow-up calls on the existing client', async () => {
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async (params) => ({
        content: [{ type: 'text', text: `recovered:${params.name}` }],
      }),
    ];

    const server = createServer('retry-server');
    await server.connect();

    try {
      await expect(
        server.callTool('mock-tool', { foo: 'bar' }),
      ).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      expect(server.sessionId).toBe('generated-session-0');
      expect(
        MockStreamableHTTPClientTransport.instances[1].options.sessionId,
      ).toBe('generated-session-0');
      expect(
        MockStreamableHTTPClientTransport.instances[1].protocolVersion,
      ).toBe(TEST_PROTOCOL_VERSION);
      expect(MockClient.instances[0].notificationMock).toHaveBeenCalledWith({
        method: 'notifications/initialized',
      });
      expect(MockClient.instances[0].closeMock).toHaveBeenCalledTimes(1);
      expect(
        MockStreamableHTTPClientTransport.instances[0].closeMock,
      ).toHaveBeenCalledTimes(1);

      const followUp = await server.callTool('follow-up-tool', { baz: 'qux' });

      expect(followUp).toEqual([
        { type: 'text', text: 'recovered:follow-up-tool' },
      ]);
      expect(MockClient.instances).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('preserves tool metadata after healing the shared client', async () => {
    MockClient.listToolsResults = [
      [
        {
          name: 'regular-tool',
          description: 'Regular tool',
          inputSchema: { type: 'object' },
        },
        {
          name: 'required-task-tool',
          description: 'Task-only tool',
          execution: { taskSupport: 'required' },
          inputSchema: { type: 'object' },
        },
        {
          name: 'schema-tool',
          description: 'Schema tool',
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            required: ['message'],
            properties: {
              message: { type: 'string' },
            },
          },
        },
      ],
    ];
    MockClient.callToolHandlers = [
      async ({ name }) => {
        if (name === 'regular-tool') {
          throw new McpError(
            ErrorCode.ConnectionClosed,
            'shared session closed',
          );
        }

        return {
          content: [{ type: 'text', text: `unexpected-initial:${name}` }],
        };
      },
      async ({ name }) => {
        if (name === 'regular-tool') {
          return {
            content: [{ type: 'text', text: 'recovered-regular-tool' }],
          };
        }

        if (name === 'schema-tool') {
          return {
            content: [{ type: 'text', text: 'bad-structured-content' }],
            structuredContent: { message: 123 },
          };
        }

        return {
          content: [{ type: 'text', text: `unexpected-recovered:${name}` }],
        };
      },
    ];

    const server = createServer('metadata-server');
    await server.connect();

    try {
      expect(await server.listTools()).toHaveLength(3);
      await expect(server.callTool('regular-tool', null)).rejects.toMatchObject(
        {
          name: 'McpError',
          code: ErrorCode.ConnectionClosed,
        },
      );

      await expect(
        server.callTool('required-task-tool', null),
      ).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.InvalidRequest,
      });
      await expect(server.callTool('schema-tool', null)).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.InvalidParams,
      });
      expect(await server.callTool('regular-tool', null)).toEqual([
        { type: 'text', text: 'recovered-regular-tool' },
      ]);
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('reconnects when the shared client is already disconnected', async () => {
    MockClient.callToolHandlers = [
      async function (this: MockClient) {
        throwProtocolNotConnected.call(this);
      },
      async () => ({
        content: [{ type: 'text', text: 'reconnected-after-disconnect' }],
      }),
    ];

    const server = createServer('abort-retry-server');
    await server.connect();

    try {
      const result = await server.callTool('mock-tool', { foo: 'bar' });

      expect(result).toEqual([
        { type: 'text', text: 'reconnected-after-disconnect' },
      ]);
      expect(MockClient.instances).toHaveLength(1);
      expect(
        MockStreamableHTTPClientTransport.instances[1].options.sessionId,
      ).toBe('generated-session-0');
    } finally {
      await server.close();
    }
  });

  it('does not reconnect when a healthy client hook throws Error("Not connected")', async () => {
    let firstFailure = true;
    MockClient.callToolHandlers = [
      async () => {
        if (firstFailure) {
          firstFailure = false;
          throw new Error('Not connected');
        }

        return {
          content: [{ type: 'text', text: 'healthy-session-follow-up' }],
        };
      },
    ];

    const server = createServer('not-connected-hook-error-server');
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toThrow(
        'Not connected',
      );
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
      expect(server.sessionId).toBe('generated-session-0');

      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'healthy-session-follow-up' },
      ]);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('resets the public tools cache when connect() publishes a new session', async () => {
    MockClient.listToolsResults = [
      [
        {
          name: 'first-tool',
          description: 'First tool',
          inputSchema: { type: 'object' },
        },
      ],
      [
        {
          name: 'second-tool',
          description: 'Second tool',
          inputSchema: { type: 'object' },
        },
      ],
    ];

    const server = createPublicServer('public-cache-reset-server');
    await server.connect();

    try {
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'first-tool',
      ]);

      await server.connect();

      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'second-tool',
      ]);
      expect(MockClient.instances).toHaveLength(2);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it('refreshes cached tool metadata after a sessionless reconnect', async () => {
    MockClient.sessionIdAssignments = [null, null];
    MockClient.listToolsResults = [
      [
        {
          name: 'schema-tool',
          description: 'Schema tool',
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            required: ['message'],
            properties: {
              message: { type: 'string' },
            },
          },
        },
      ],
    ];
    MockClient.callToolHandlers = [
      async function (this: MockClient) {
        throwProtocolNotConnected.call(this);
      },
      async ({ name }) => ({
        content: [{ type: 'text', text: `recovered:${name}` }],
      }),
    ];

    const server = createServer('sessionless-metadata-reset-server');
    await server.connect();

    try {
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'schema-tool',
      ]);

      await expect(server.callTool('schema-tool', null)).resolves.toEqual([
        { type: 'text', text: 'recovered:schema-tool' },
      ]);
      expect(server.sessionId).toBeUndefined();
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('refreshes cached tool lists after a sessionless reconnect', async () => {
    MockClient.sessionIdAssignments = [null, null];
    MockClient.listToolsResults = [
      [
        {
          name: 'first-tool',
          description: 'First tool',
          inputSchema: { type: 'object' },
        },
      ],
      [
        {
          name: 'second-tool',
          description: 'Second tool',
          inputSchema: { type: 'object' },
        },
      ],
    ];
    MockClient.callToolHandlers = [
      async function (this: MockClient) {
        throwProtocolNotConnected.call(this);
      },
      async () => ({
        content: [{ type: 'text', text: 'reconnected-after-disconnect' }],
      }),
    ];

    const server = createServer('sessionless-tool-cache-reset-server', {
      cacheToolsList: true,
    });
    await server.connect();

    try {
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'first-tool',
      ]);

      await expect(server.callTool('mock-tool', null)).resolves.toEqual([
        { type: 'text', text: 'reconnected-after-disconnect' },
      ]);

      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'second-tool',
      ]);
      expect(server.sessionId).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('refreshes the public tools cache after a sessionless reconnect', async () => {
    MockClient.sessionIdAssignments = [null, null];
    MockClient.listToolsResults = [
      [
        {
          name: 'first-tool',
          description: 'First tool',
          inputSchema: { type: 'object' },
        },
      ],
      [
        {
          name: 'second-tool',
          description: 'Second tool',
          inputSchema: { type: 'object' },
        },
      ],
    ];
    MockClient.callToolHandlers = [
      async function (this: MockClient) {
        throwProtocolNotConnected.call(this);
      },
      async () => ({
        content: [{ type: 'text', text: 'reconnected-after-disconnect' }],
      }),
    ];

    const server = createPublicServer(
      'public-sessionless-tool-cache-reset-server',
      {
        cacheToolsList: true,
      },
    );
    await server.connect();

    try {
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'first-tool',
      ]);

      await expect(server.callTool('mock-tool', null)).resolves.toEqual([
        { type: 'text', text: 'reconnected-after-disconnect' },
      ]);

      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'second-tool',
      ]);
      expect(server.sessionId).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('refreshes the public tools cache after a sessionful reconnect changes the session id', async () => {
    MockClient.sessionIdAssignments = ['session-a', 'session-b'];
    MockClient.listToolsResults = [
      [
        {
          name: 'first-tool',
          description: 'First tool',
          inputSchema: { type: 'object' },
        },
      ],
      [
        {
          name: 'second-tool',
          description: 'Second tool',
          inputSchema: { type: 'object' },
        },
      ],
    ];
    MockClient.callToolHandlers = [
      async function (this: MockClient) {
        throwProtocolNotConnected.call(this);
      },
      async () => ({
        content: [{ type: 'text', text: 'reconnected-after-session-change' }],
      }),
    ];

    const server = createPublicServer(
      'public-sessionful-tool-cache-reset-server',
      {
        cacheToolsList: true,
      },
    );
    await server.connect();

    try {
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'first-tool',
      ]);

      await expect(server.callTool('mock-tool', null)).resolves.toEqual([
        { type: 'text', text: 'reconnected-after-session-change' },
      ]);

      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'second-tool',
      ]);
      expect(server.sessionId).toBe('session-b');
    } finally {
      await server.close();
    }
  });

  it('coalesces concurrent reconnects onto one recovered client', async () => {
    let sharedFailureCallCount = 0;
    let firstSharedFailureStarted!: () => void;
    let secondSharedFailureStarted!: () => void;
    let reconnectStarted!: () => void;
    let releaseSharedFailures!: () => void;
    const firstSharedFailureStartedPromise = new Promise<void>((resolve) => {
      firstSharedFailureStarted = resolve;
    });
    const secondSharedFailureStartedPromise = new Promise<void>((resolve) => {
      secondSharedFailureStarted = resolve;
    });
    const reconnectStartedPromise = new Promise<void>((resolve) => {
      reconnectStarted = resolve;
    });
    const sharedFailuresReleased = new Promise<void>((resolve) => {
      releaseSharedFailures = resolve;
    });

    MockClient.connectHandlers = [
      undefined,
      async () => {
        reconnectStarted();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        sharedFailureCallCount += 1;
        if (sharedFailureCallCount === 1) {
          firstSharedFailureStarted();
        } else if (sharedFailureCallCount === 2) {
          secondSharedFailureStarted();
        }
        await sharedFailuresReleased;
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async (params) => ({
        content: [{ type: 'text', text: `recovered:${params.name}` }],
      }),
    ];

    const server = createServer('concurrent-reconnect-server');
    await server.connect();

    try {
      const firstCallPromise = server.callTool('first-tool', null);
      void firstCallPromise.catch(() => {});
      await firstSharedFailureStartedPromise;

      const secondCallPromise = server.callTool('second-tool', null);
      void secondCallPromise.catch(() => {});

      await secondSharedFailureStartedPromise;
      releaseSharedFailures();
      await reconnectStartedPromise;
      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      });

      await Promise.all([
        expect(firstCallPromise).rejects.toMatchObject({
          name: 'McpError',
          code: ErrorCode.ConnectionClosed,
        }),
        expect(secondCallPromise).rejects.toMatchObject({
          name: 'McpError',
          code: ErrorCode.ConnectionClosed,
        }),
      ]);
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      expect(MockClient.instances[0].notificationMock).toHaveBeenCalledWith({
        method: 'notifications/initialized',
      });
      expect(MockClient.instances[0].closeMock).toHaveBeenCalledTimes(1);
      expect(
        MockStreamableHTTPClientTransport.instances[0].closeMock,
      ).toHaveBeenCalledTimes(1);

      const followUp = await server.callTool('follow-up-tool', null);

      expect(followUp).toEqual([
        { type: 'text', text: 'recovered:follow-up-tool' },
      ]);
      expect(MockClient.instances).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('does not restore a client after close wins the race with reconnect', async () => {
    let releaseReconnect!: () => void;
    const reconnectStarted = new Promise<void>((resolve) => {
      releaseReconnect = () => resolve();
    });

    MockClient.connectHandlers = [
      undefined,
      async () => {
        await reconnectStarted;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
    ];

    const server = createServer('close-during-reconnect-server');
    await server.connect();

    const pendingCall = server.callTool('mock-tool', null);
    void pendingCall.catch(() => {});

    await vi.waitFor(() => {
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
    });

    const closePromise = server.close();
    releaseReconnect();

    await closePromise;
    await expect(pendingCall).rejects.toThrow(
      'Streamable HTTP MCP server was closed during reconnect.',
    );
    expect(server.sessionId).toBeUndefined();
    expect(MockClient.instances).toHaveLength(1);
    expect(
      MockClient.instances[0].closeMock.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      MockStreamableHTTPClientTransport.instances[1].closeMock.mock.calls
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('does not let close tear down a newer connect while reconnect settles', async () => {
    let releaseReconnect!: () => void;
    const reconnectBlocked = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        return;
      },
      async () => {
        await reconnectBlocked;
      },
      async () => {
        return;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async () => ({
        content: [{ type: 'text', text: 'stale-reconnect-client' }],
      }),
      async () => ({
        content: [{ type: 'text', text: 'fresh-connect-client' }],
      }),
    ];

    const server = createServer('close-does-not-tear-down-connect-server');
    await server.connect();

    try {
      const pendingCall = server.callTool('reconnect-tool', null);
      void pendingCall.catch(() => {});

      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      });

      const closePromise = server.close();
      const pendingConnect = server.connect();
      await pendingConnect;
      releaseReconnect();

      await expect(pendingCall).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });
      await closePromise;
      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'fresh-connect-client' },
      ]);
      expect(server.sessionId).toBe('generated-session-2');
      expect(MockClient.instances).toHaveLength(2);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(3);
      expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not let a stale reconnect overwrite a newer connect', async () => {
    let releaseReconnect!: () => void;
    const reconnectBlocked = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        return;
      },
      async () => {
        await reconnectBlocked;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        await Promise.resolve();
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async () => ({
        content: [{ type: 'text', text: 'stale-reconnect-client' }],
      }),
      async () => ({
        content: [{ type: 'text', text: 'fresh-connect-client' }],
      }),
    ];

    const server = createServer('connect-wins-server');
    await server.connect();

    try {
      const pendingCall = server.callTool('stale-tool', null);
      void pendingCall.catch(() => {});

      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      });

      await server.connect();
      releaseReconnect();

      await expect(pendingCall).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });
      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'fresh-connect-client' },
      ]);
      expect(MockClient.instances).toHaveLength(2);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(4);
      expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not let a reconnect get overwritten by an older in-flight connect', async () => {
    let releaseStaleConnect!: () => void;
    const staleConnectBlocked = new Promise<void>((resolve) => {
      releaseStaleConnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        return;
      },
      async () => {
        await staleConnectBlocked;
      },
      async () => {
        return;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async () => ({
        content: [{ type: 'text', text: 'stale-overlapping-connect-client' }],
      }),
      async () => ({
        content: [{ type: 'text', text: 'recovered-after-reconnect' }],
      }),
    ];

    const server = createServer('reconnect-wins-server');
    await server.connect();

    try {
      const staleConnect = server.connect();
      void staleConnect.catch(() => {});

      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      });

      const pendingCall = server.callTool('reconnect-tool', null);
      void pendingCall.catch(() => {});

      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(3);
      });

      await expect(pendingCall).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });

      releaseStaleConnect();

      await expect(staleConnect).rejects.toThrow(
        'Streamable HTTP MCP server changed during connect.',
      );
      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'recovered-after-reconnect' },
      ]);
      expect(server.sessionId).toBe('generated-session-0');
      expect(MockClient.instances).toHaveLength(2);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(4);
      expect(MockClient.instances[1].closeMock).toHaveBeenCalledTimes(1);
      expect(
        MockStreamableHTTPClientTransport.instances[1].closeMock,
      ).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('reuses a newer session for follow-up calls instead of reconnecting it after a failed call', async () => {
    MockClient.connectHandlers = [
      async () => {
        return;
      },
      async () => {
        return;
      },
      async () => {
        return;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        await server.connect();
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async () => ({
        content: [{ type: 'text', text: 'fresh-connect-client' }],
      }),
      async () => ({
        content: [{ type: 'text', text: 'unexpected-reconnect-client' }],
      }),
    ];

    const server = createServer('reuse-newer-session-server');
    await server.connect();

    try {
      await expect(server.callTool('reuse-tool', null)).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });
      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'fresh-connect-client' },
      ]);
      expect(server.sessionId).toBe('generated-session-1');
      expect(MockClient.instances).toHaveLength(2);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(3);
      expect(
        MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
      ).not.toHaveBeenCalled();
      expect(
        MockStreamableHTTPClientTransport.instances[2].terminateSessionMock,
      ).toHaveBeenCalledTimes(1);
      expect(
        MockStreamableHTTPClientTransport.instances[0].closeMock,
      ).toHaveBeenCalledTimes(1);
      expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not reuse a stale reconnect promise for a newer failed session', async () => {
    let releaseOldReconnect!: () => void;
    const oldReconnectBlocked = new Promise<void>((resolve) => {
      releaseOldReconnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        return;
      },
      async () => {
        await oldReconnectBlocked;
      },
      async () => {
        return;
      },
      async () => {
        return;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
      async () => ({
        content: [{ type: 'text', text: 'stale-old-reconnect-client' }],
      }),
      async () => {
        throw new McpError(
          ErrorCode.ConnectionClosed,
          'new shared session closed',
        );
      },
      undefined,
      async () => ({
        content: [{ type: 'text', text: 'reconnected-new-session-client' }],
      }),
    ];

    const server = createServer('reconnect-targeted-by-session-server');
    await server.connect();

    try {
      const oldPendingCall = server.callTool('old-tool', null);
      void oldPendingCall.catch(() => {});

      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
      });

      await server.connect();
      const newPendingCall = server.callTool('new-tool', null);
      void newPendingCall.catch(() => {});

      await vi.waitFor(() => {
        expect(MockStreamableHTTPClientTransport.instances).toHaveLength(4);
      });

      await expect(newPendingCall).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });

      releaseOldReconnect();

      await expect(oldPendingCall).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });
      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'reconnected-new-session-client' },
      ]);
      expect(server.sessionId).toBe('generated-session-2');
      expect(MockClient.instances).toHaveLength(2);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(5);
    } finally {
      await server.close();
    }
  });

  it('does not let connect resurrect a server that was closed in flight', async () => {
    let releaseConnect!: () => void;
    const connectBlocked = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        await connectBlocked;
      },
    ];

    const server = createServer('close-during-connect-server');
    const pendingConnect = server.connect();

    await vi.waitFor(() => {
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    });

    const closePromise = server.close();
    releaseConnect();

    await closePromise;
    await expect(pendingConnect).rejects.toThrow(
      'Streamable HTTP MCP server was closed during connect.',
    );
    expect(server.sessionId).toBeUndefined();
    expect(MockClient.instances).toHaveLength(1);
    expect(
      MockClient.instances[0].closeMock.mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      MockStreamableHTTPClientTransport.instances[0].closeMock.mock.calls
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('does not let a stale overlapping connect close the newer session', async () => {
    let releaseFirstConnect!: () => void;
    const firstConnectBlocked = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        await firstConnectBlocked;
      },
      async () => {
        return;
      },
    ];
    MockClient.callToolHandlers = [
      async () => ({
        content: [{ type: 'text', text: 'stale-first-connect-client' }],
      }),
      async () => ({
        content: [{ type: 'text', text: 'winning-second-connect-client' }],
      }),
    ];

    const server = createServer('overlapping-connect-server');
    const firstConnect = server.connect();

    await vi.waitFor(() => {
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    });

    await server.connect();
    releaseFirstConnect();

    await expect(firstConnect).rejects.toThrow(
      'Streamable HTTP MCP server changed during connect.',
    );
    await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
      { type: 'text', text: 'winning-second-connect-client' },
    ]);
    expect(server.sessionId).toBe('generated-session-1');
    expect(MockClient.instances).toHaveLength(2);
    expect(MockClient.instances[0].closeMock).toHaveBeenCalledTimes(1);
    expect(
      MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
    ).not.toHaveBeenCalled();
    expect(MockStreamableHTTPClientTransport.instances).toHaveLength(3);
    expect(
      MockStreamableHTTPClientTransport.instances[2].options.sessionId,
    ).toBe('generated-session-0');
    expect(
      MockStreamableHTTPClientTransport.instances[2].terminateSessionMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      MockStreamableHTTPClientTransport.instances[0].closeMock,
    ).toHaveBeenCalledTimes(1);
    expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();

    await server.close();
  });

  it('does not terminate the winning shared session when a stale pinned connect loses the race', async () => {
    let sharedSessionTerminated = false;
    let releaseFirstConnect!: () => void;
    const firstConnectBlocked = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve;
    });

    MockClient.connectHandlers = [
      async () => {
        await firstConnectBlocked;
      },
      async () => {
        return;
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new Error('unexpected-stale-client-call');
      },
      async () => {
        if (sharedSessionTerminated) {
          throw new McpError(
            ErrorCode.ConnectionClosed,
            'shared pinned session terminated',
          );
        }

        return {
          content: [{ type: 'text', text: 'winning-pinned-session-client' }],
        };
      },
    ];

    const server = createServer('overlapping-pinned-connect-server', {
      sessionId: 'pinned-shared-session',
    });
    const firstConnect = server.connect();

    await vi.waitFor(() => {
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    });

    await server.connect();
    MockStreamableHTTPClientTransport.instances[0].terminateSessionMock.mockImplementation(
      async () => {
        sharedSessionTerminated = true;
      },
    );
    releaseFirstConnect();

    await expect(firstConnect).rejects.toThrow(
      'Streamable HTTP MCP server changed during connect.',
    );
    await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
      { type: 'text', text: 'winning-pinned-session-client' },
    ]);
    expect(server.sessionId).toBe('pinned-shared-session');
    expect(MockClient.instances).toHaveLength(2);
    expect(MockClient.instances[0].closeMock).toHaveBeenCalledTimes(1);
    expect(
      MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
    ).not.toHaveBeenCalled();
    expect(
      MockStreamableHTTPClientTransport.instances[0].closeMock,
    ).toHaveBeenCalledTimes(1);
    expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();

    await server.close();
  });

  it('does not terminate a pinned shared session when connect() replaces the transport', async () => {
    MockClient.callToolHandlers = [
      async () => ({
        content: [{ type: 'text', text: 'first-pinned-client' }],
      }),
      async () => ({
        content: [{ type: 'text', text: 'second-pinned-client' }],
      }),
    ];

    const server = createServer('replace-pinned-connect-server', {
      sessionId: 'pinned-shared-session',
    });
    await server.connect();

    try {
      await server.connect();

      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'second-pinned-client' },
      ]);
      expect(server.sessionId).toBe('pinned-shared-session');
      expect(MockClient.instances).toHaveLength(2);
      expect(MockClient.instances[0].closeMock).toHaveBeenCalledTimes(1);
      expect(
        MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
      ).not.toHaveBeenCalled();
      expect(
        MockStreamableHTTPClientTransport.instances[0].closeMock,
      ).toHaveBeenCalledTimes(1);
      expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not terminate a pinned shared session when close() loses to a newer connect', async () => {
    let releaseOldClose!: () => void;
    const oldCloseBlocked = new Promise<void>((resolve) => {
      releaseOldClose = resolve;
    });
    let sharedSessionTerminated = false;

    MockClient.callToolHandlers = [
      async () => {
        throw new Error('unexpected-stale-client-call');
      },
      async () => {
        if (sharedSessionTerminated) {
          throw new McpError(
            ErrorCode.ConnectionClosed,
            'shared pinned session terminated',
          );
        }

        return {
          content: [{ type: 'text', text: 'winning-pinned-session-client' }],
        };
      },
    ];

    const server = createServer('close-loses-to-pinned-connect-server', {
      sessionId: 'pinned-shared-session',
    });
    await server.connect();

    try {
      MockClient.instances[0].closeMock.mockImplementation(async () => {
        await oldCloseBlocked;
      });
      MockStreamableHTTPClientTransport.instances[0].terminateSessionMock.mockImplementation(
        async () => {
          sharedSessionTerminated = true;
        },
      );

      const closePromise = server.close();

      await vi.waitFor(() => {
        expect(MockClient.instances[0].closeMock).toHaveBeenCalledTimes(1);
      });

      await server.connect();
      releaseOldClose();
      await closePromise;

      await expect(server.callTool('follow-up-tool', null)).resolves.toEqual([
        { type: 'text', text: 'winning-pinned-session-client' },
      ]);
      expect(server.sessionId).toBe('pinned-shared-session');
      expect(MockClient.instances).toHaveLength(2);
      expect(
        MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
      ).not.toHaveBeenCalled();
      expect(MockClient.instances[1].closeMock).not.toHaveBeenCalled();
    } finally {
      releaseOldClose();
      await server.close();
    }
  });

  it('terminates partially created sessions when connect() fails after session allocation', async () => {
    MockClient.sessionIdAssignments = ['partially-created-session'];
    MockClient.connectHandlers = [
      async function (this: MockClient) {
        await this.close();
        throw new Error('connect failed after session allocation');
      },
    ];

    const server = createServer('failed-connect-session-cleanup-server');

    await expect(server.connect()).rejects.toThrow(
      'connect failed after session allocation',
    );
    expect(MockClient.instances).toHaveLength(1);
    expect(MockStreamableHTTPClientTransport.instances).toHaveLength(2);
    expect(
      MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
    ).not.toHaveBeenCalled();
    expect(
      MockStreamableHTTPClientTransport.instances[1].options.sessionId,
    ).toBe('partially-created-session');
    expect(
      MockStreamableHTTPClientTransport.instances[1].terminateSessionMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      MockStreamableHTTPClientTransport.instances[0].closeMock.mock.calls
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      MockStreamableHTTPClientTransport.instances[1].closeMock,
    ).toHaveBeenCalledTimes(1);
  });

  it('terminates partially created sessions when reconnect() fails after session allocation', async () => {
    MockClient.sessionIdAssignments = [null, 'replacement-session'];
    MockClient.connectHandlers = [
      undefined,
      async function (this: MockClient) {
        await this.close();
        throw new Error('reconnect failed after session allocation');
      },
    ];
    MockClient.callToolHandlers = [
      async function (this: MockClient) {
        throwProtocolNotConnected.call(this);
      },
    ];

    const server = createServer('failed-reconnect-session-cleanup-server');
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toThrow(
        'reconnect failed after session allocation',
      );
      expect(server.sessionId).toBeUndefined();
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(3);
      expect(
        MockStreamableHTTPClientTransport.instances[1].terminateSessionMock,
      ).not.toHaveBeenCalled();
      expect(
        MockStreamableHTTPClientTransport.instances[2].options.sessionId,
      ).toBe('replacement-session');
      expect(
        MockStreamableHTTPClientTransport.instances[2].terminateSessionMock,
      ).toHaveBeenCalledTimes(1);
      expect(
        MockStreamableHTTPClientTransport.instances[1].closeMock.mock.calls
          .length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        MockStreamableHTTPClientTransport.instances[2].closeMock,
      ).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('does not replay ambiguous 5xx failures', async () => {
    MockClient.callToolHandlers = [
      async () => {
        throw new MockStreamableHTTPError(503, 'upstream unavailable');
      },
    ];

    const server = createServer('no-retry-server');
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toMatchObject({
        name: 'StreamableHTTPError',
        code: 503,
      });
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('does not replay timed out tool calls', async () => {
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.RequestTimeout, 'shared timeout');
      },
    ];

    const server = createServer('timeout-server');
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.RequestTimeout,
      });
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('does not recover pinned sessions automatically', async () => {
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'pinned session closed');
      },
    ];

    const server = createServer('pinned-session-server', {
      sessionId: 'pinned-session',
    });
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toMatchObject({
        name: 'McpError',
        code: ErrorCode.ConnectionClosed,
      });
      expect(MockClient.instances).toHaveLength(1);
      expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
      expect(server.sessionId).toBe('pinned-session');
    } finally {
      await server.close();
    }
  });

  it('surfaces reconnect failures with the shared-session error as cause', async () => {
    MockClient.notificationHandlers = [
      undefined,
      async () => {
        throw new MockStreamableHTTPError(
          503,
          'failed to reopen shared stream',
        );
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
    ];

    const server = createServer('failed-retry-server');
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toMatchObject({
        name: 'StreamableHTTPError',
        code: 503,
        cause: expect.objectContaining({
          name: 'McpError',
          code: ErrorCode.ConnectionClosed,
        }),
      });
      expect(server.sessionId).toBeUndefined();
      await expect(server.listTools()).rejects.toThrow(
        'Server not initialized. Make sure you call connect() first.',
      );
      expect(MockClient.instances).toHaveLength(1);
      expect(
        MockStreamableHTTPClientTransport.instances[1].options.sessionId,
      ).toBe('generated-session-0');
    } finally {
      await server.close();
    }
  });

  it('times out stalled shared-session reopen notifications', async () => {
    MockClient.notificationHandlers = [
      undefined,
      async () => {
        await new Promise(() => {});
      },
    ];
    MockClient.callToolHandlers = [
      async () => {
        throw new McpError(ErrorCode.ConnectionClosed, 'shared session closed');
      },
    ];

    const server = createServer('timed-out-reopen-server', {
      clientSessionTimeoutSeconds: 0.01,
    });
    await server.connect();

    try {
      await expect(server.callTool('mock-tool', null)).rejects.toMatchObject({
        message: 'Timed out reopening shared streamable HTTP MCP session.',
        cause: expect.objectContaining({
          name: 'McpError',
          code: ErrorCode.ConnectionClosed,
        }),
      });
      expect(server.sessionId).toBeUndefined();
      await expect(server.listTools()).rejects.toThrow(
        'Server not initialized. Make sure you call connect() first.',
      );
    } finally {
      await server.close();
    }
  });

  afterAll(() => {
    vi.clearAllMocks();
  });
});
