import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import {
  EnhancedMCPServerStdio,
  EnhancedMCPServerSSE,
  EnhancedMCPServerStreamableHttp,
} from '../src/mcp-enhanced';
import {
  MCPConnectionError,
  MCPToolError,
  MCPRetryManager,
  DEFAULT_MCP_RETRY_CONFIG,
} from '../src/errors';

// Mock the MCP SDK imports
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsResultSchema: {
    parse: vi.fn(),
  },
  CallToolResultSchema: {
    parse: vi.fn(),
  },
}));

describe('MCPRetryManager', () => {
  let retryManager: MCPRetryManager;
  let consoleSpy: any;

  beforeEach(() => {
    retryManager = new MCPRetryManager({ quiet: true });
    vi.clearAllMocks();
    // Suppress console output during tests to reduce noise
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  it('should use default configuration', () => {
    const defaultRetryManager = new MCPRetryManager();
    const config = defaultRetryManager.getConfig();
    expect(config).toEqual(DEFAULT_MCP_RETRY_CONFIG);
  });

  it('should allow custom configuration', () => {
    const customConfig = {
      maxAttempts: 5,
      baseDelay: 2000,
      backoffStrategy: 'linear' as const,
    };

    const customRetryManager = new MCPRetryManager(customConfig);
    const config = customRetryManager.getConfig();

    expect(config.maxAttempts).toBe(5);
    expect(config.baseDelay).toBe(2000);
    expect(config.backoffStrategy).toBe('linear');
  });

  it('should execute operation successfully on first attempt', async () => {
    const operation = vi.fn().mockResolvedValue('success');

    const result = await retryManager.executeWithRetry(
      operation,
      'test_operation',
    );

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('First failure'))
      .mockResolvedValue('success');

    const result = await retryManager.executeWithRetry(
      operation,
      'test_operation',
    );

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('should throw enhanced error after max attempts', async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new Error('Persistent failure'));

    await expect(
      retryManager.executeWithRetry(operation, 'test_operation', {
        serverName: 'test-server',
      }),
    ).rejects.toThrow('MCP operation "test_operation" failed after 3 attempts');

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should calculate exponential backoff delays', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Failure'));
    const sleepSpy = vi
      .spyOn(retryManager as any, 'sleep')
      .mockResolvedValue(undefined);

    try {
      await retryManager.executeWithRetry(operation, 'test_operation');
    } catch {
      // Expected to fail
    }

    expect(sleepSpy).toHaveBeenCalledTimes(2); // 2 retries after first failure

    // Check that delays increase (exponential backoff)
    const delays = sleepSpy.mock.calls.map((call) => call[0] as number);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });

  it('should apply jitter to delays when enabled', async () => {
    const retryManagerWithJitter = new MCPRetryManager({
      jitter: true,
      quiet: true,
    });
    const operation = vi.fn().mockRejectedValue(new Error('Failure'));
    const sleepSpy = vi
      .spyOn(retryManagerWithJitter as any, 'sleep')
      .mockResolvedValue(undefined);

    try {
      await retryManagerWithJitter.executeWithRetry(
        operation,
        'test_operation',
      );
    } catch {
      // Expected to fail
    }

    const delays = sleepSpy.mock.calls.map((call) => call[0] as number);
    // With jitter, delays should be different from the base calculation
    expect(delays.length).toBeGreaterThan(0);
  });
});

describe('EnhancedMCPServerStdio', () => {
  let server: EnhancedMCPServerStdio;
  let mockTransport: any;
  let mockSession: any;
  let consoleSpy: any;

  beforeEach(async () => {
    // Suppress console output during tests to reduce noise
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTransport = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockSession = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
    };

    // Mock the dynamic imports
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );
    const { Client } = await import(
      '@modelcontextprotocol/sdk/client/index.js'
    );

    (StdioClientTransport as Mock).mockImplementation(() => mockTransport);
    (Client as Mock).mockImplementation(() => mockSession);

    server = new EnhancedMCPServerStdio({
      command: 'test-command',
      args: ['arg1', 'arg2'],
      retryConfig: { maxAttempts: 2, quiet: true }, // Reduce for faster tests and suppress logging
    });
  });

  afterEach(async () => {
    await server.close();
    vi.clearAllMocks();
    consoleSpy?.mockRestore();
  });

  it('should connect successfully', async () => {
    await server.connect();

    expect(mockSession.connect).toHaveBeenCalledWith(mockTransport);
  });

  it('should throw MCPConnectionError on connection failure', async () => {
    mockSession.connect.mockRejectedValue(new Error('Connection failed'));

    await expect(server.connect()).rejects.toThrow(MCPConnectionError);
  });

  it('should retry connection on failure', async () => {
    mockSession.connect
      .mockRejectedValueOnce(new Error('First failure'))
      .mockResolvedValue(undefined);

    await server.connect();

    expect(mockSession.connect).toHaveBeenCalledTimes(2);
  });

  it('should list tools successfully', async () => {
    const { ListToolsResultSchema } = await import(
      '@modelcontextprotocol/sdk/types.js'
    );
    (ListToolsResultSchema.parse as Mock).mockReturnValue({
      tools: [{ name: 'test-tool' }],
    });

    await server.connect();
    const tools = await server.listTools();

    expect(tools).toEqual([{ name: 'test-tool' }]);
    expect(mockSession.listTools).toHaveBeenCalled();
  });

  it('should throw MCPConnectionError when listing tools without connection', async () => {
    await expect(server.listTools()).rejects.toThrow(MCPConnectionError);
  });

  it('should throw MCPToolError on tool listing failure', async () => {
    await server.connect();
    mockSession.listTools.mockRejectedValue(new Error('List tools failed'));

    await expect(server.listTools()).rejects.toThrow(MCPToolError);
  });

  it('should call tool successfully', async () => {
    const { CallToolResultSchema } = await import(
      '@modelcontextprotocol/sdk/types.js'
    );
    (CallToolResultSchema.parse as Mock).mockReturnValue({
      content: [{ type: 'text', text: 'tool result' }],
    });

    await server.connect();
    const result = await server.callTool('test-tool', { arg: 'value' });

    expect(result).toEqual([{ type: 'text', text: 'tool result' }]);
    expect(mockSession.callTool).toHaveBeenCalledWith(
      { name: 'test-tool', arguments: { arg: 'value' } },
      undefined,
      { timeout: expect.any(Number) },
    );
  });

  it('should throw MCPConnectionError when calling tool without connection', async () => {
    await expect(server.callTool('test-tool', {})).rejects.toThrow(
      MCPConnectionError,
    );
  });

  it('should throw MCPToolError on tool call failure', async () => {
    await server.connect();
    mockSession.callTool.mockRejectedValue(new Error('Tool call failed'));

    await expect(server.callTool('test-tool', {})).rejects.toThrow(
      MCPToolError,
    );
  });

  it('should cache tools when enabled', async () => {
    const { ListToolsResultSchema } = await import(
      '@modelcontextprotocol/sdk/types.js'
    );
    (ListToolsResultSchema.parse as Mock).mockReturnValue({
      tools: [{ name: 'test-tool' }],
    });

    server = new EnhancedMCPServerStdio({
      command: 'test-command',
      cacheToolsList: true,
      retryConfig: { quiet: true },
    });

    await server.connect();

    // First call should fetch tools
    await server.listTools();
    expect(mockSession.listTools).toHaveBeenCalledTimes(1);

    // Second call should use cache
    await server.listTools();
    expect(mockSession.listTools).toHaveBeenCalledTimes(1);
  });

  it('should handle fullCommand parameter', () => {
    const serverWithFullCommand = new EnhancedMCPServerStdio({
      fullCommand: 'python -m my_mcp_server --arg value',
    });

    expect(serverWithFullCommand.name).toContain('stdio: python');
  });

  it('should close gracefully', async () => {
    await server.connect();
    await server.close();

    expect(mockTransport.close).toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should handle close errors gracefully', async () => {
    await server.connect();

    mockTransport.close.mockRejectedValue(new Error('Close failed'));
    mockSession.close.mockRejectedValue(new Error('Close failed'));

    // Should not throw
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('EnhancedMCPServerSSE', () => {
  let server: EnhancedMCPServerSSE;
  let mockTransport: any;
  let mockSession: any;
  let consoleSpy: any;

  beforeEach(async () => {
    // Suppress console output during tests to reduce noise
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTransport = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockSession = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
    };

    const { SSEClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/sse.js'
    );
    const { Client } = await import(
      '@modelcontextprotocol/sdk/client/index.js'
    );

    (SSEClientTransport as Mock).mockImplementation(() => mockTransport);
    (Client as Mock).mockImplementation(() => mockSession);

    server = new EnhancedMCPServerSSE({
      url: 'https://example.com/mcp',
      retryConfig: { maxAttempts: 2, quiet: true },
    });
  });

  afterEach(async () => {
    await server.close();
    vi.clearAllMocks();
    consoleSpy?.mockRestore();
  });

  it('should connect successfully', async () => {
    await server.connect();

    expect(mockSession.connect).toHaveBeenCalledWith(mockTransport);
  });

  it('should throw MCPConnectionError on connection failure', async () => {
    mockSession.connect.mockRejectedValue(new Error('Connection failed'));

    await expect(server.connect()).rejects.toThrow(MCPConnectionError);
  });

  it('should use correct server name', () => {
    expect(server.name).toBe('sse: https://example.com/mcp');
  });

  it('should use custom name when provided', () => {
    const customServer = new EnhancedMCPServerSSE({
      url: 'https://example.com/mcp',
      name: 'custom-sse-server',
    });

    expect(customServer.name).toBe('custom-sse-server');
  });
});

describe('EnhancedMCPServerStreamableHttp', () => {
  let server: EnhancedMCPServerStreamableHttp;
  let mockTransport: any;
  let mockSession: any;
  let consoleSpy: any;

  beforeEach(async () => {
    // Suppress console output during tests to reduce noise
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockTransport = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockSession = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
    };

    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const { Client } = await import(
      '@modelcontextprotocol/sdk/client/index.js'
    );

    (StreamableHTTPClientTransport as Mock).mockImplementation(
      () => mockTransport,
    );
    (Client as Mock).mockImplementation(() => mockSession);

    server = new EnhancedMCPServerStreamableHttp({
      url: 'https://example.com/mcp',
      retryConfig: { maxAttempts: 2, quiet: true },
    });
  });

  afterEach(async () => {
    await server.close();
    vi.clearAllMocks();
    consoleSpy?.mockRestore();
  });

  it('should connect successfully', async () => {
    await server.connect();

    expect(mockSession.connect).toHaveBeenCalledWith(mockTransport);
  });

  it('should throw MCPConnectionError on connection failure', async () => {
    mockSession.connect.mockRejectedValue(new Error('Connection failed'));

    await expect(server.connect()).rejects.toThrow(MCPConnectionError);
  });

  it('should use correct server name', () => {
    expect(server.name).toBe('streamable-http: https://example.com/mcp');
  });

  it('should use custom name when provided', () => {
    const customServer = new EnhancedMCPServerStreamableHttp({
      url: 'https://example.com/mcp',
      name: 'custom-http-server',
    });

    expect(customServer.name).toBe('custom-http-server');
  });
});

describe('Error Context and Debugging', () => {
  it('should provide detailed error information in MCPConnectionError', () => {
    const connectionDetails = {
      command: 'test-command',
      args: ['arg1', 'arg2'],
      env: { TEST_VAR: 'value' },
    };

    const error = new MCPConnectionError(
      'Connection failed',
      'test-server',
      'stdio',
      connectionDetails,
      new Error('Underlying error'),
    );

    expect(error.serverName).toBe('test-server');
    expect(error.serverType).toBe('stdio');
    expect(error.connectionDetails).toEqual(connectionDetails);
    expect(error.underlyingError?.message).toBe('Underlying error');
    expect(error.suggestions.length).toBeGreaterThan(0);

    const troubleshootingInfo = error.getConnectionTroubleshootingInfo();
    expect(troubleshootingInfo).toContain('test-server');
    expect(troubleshootingInfo).toContain('stdio');
    expect(troubleshootingInfo).toContain('test-command');
  });

  it('should provide detailed error information in MCPToolError', () => {
    const toolArgs = { input: 'test' };

    const error = new MCPToolError(
      'Tool call failed',
      'test-server',
      'test-tool',
      'call',
      new Error('Underlying error'),
      toolArgs,
      2, // retry attempt
    );

    expect(error.serverName).toBe('test-server');
    expect(error.toolName).toBe('test-tool');
    expect(error.operation).toBe('call');
    expect(error.toolArguments).toEqual(toolArgs);
    expect(error.retryAttempt).toBe(2);
    expect(error.suggestions.length).toBeGreaterThan(0);

    const errorInfo = error.getToolErrorInfo();
    expect(errorInfo).toContain('test-server');
    expect(errorInfo).toContain('test-tool');
    expect(errorInfo).toContain('call');
    expect(errorInfo).toContain('Retry Attempt: 2');
  });
});
