/**
 * Example demonstrating enhanced MCP server with improved error handling and retry logic.
 *
 * This example shows how to use the enhanced MCP servers that provide:
 * - Detailed error messages for connection and tool failures
 * - Configurable retry logic with exponential backoff
 * - Connection health monitoring
 * - Comprehensive troubleshooting information
 */

// This example demonstrates enhanced MCP functionality
// In a real implementation, you would import from the enhanced MCP module

// Mock implementations for the example
class EnhancedMCPServerStdio {
  constructor(public options: any) {}
  async connect() {
    console.log('Connected to stdio server');
  }
  async listTools() {
    return [{ name: 'git_status' }];
  }
  async callTool(_name: string, _args: any) {
    return [{ type: 'text', text: 'Mock result' }];
  }
  async close() {
    console.log('Closed stdio server');
  }
  get name() {
    return this.options.name || 'stdio-server';
  }
}

class EnhancedMCPServerSSE {
  constructor(public options: any) {}
  async connect() {
    console.log('Connected to SSE server');
  }
  async close() {
    console.log('Closed SSE server');
  }
  get name() {
    return this.options.name || 'sse-server';
  }
}

class MCPConnectionManager {
  constructor(public config: any) {}
  addServer(server: any) {
    console.log(`Added server: ${server.name}`);
  }
  async checkServerHealth(_name: string) {
    return {
      status: 'healthy',
      latency: 10,
      consecutiveFailures: 0,
      lastCheck: new Date(),
      lastError: undefined,
    };
  }
  getAllServersHealth() {
    return new Map([
      [
        'test-server',
        {
          status: 'healthy',
          latency: 10,
          consecutiveFailures: 0,
          lastCheck: new Date(),
          lastError: undefined,
        },
      ],
    ]);
  }
  async close() {
    console.log('Connection manager closed');
  }
}

async function testMCPServerConnection(_server: any, _timeout?: number) {
  return { success: true, latency: 50, toolCount: 1, error: undefined };
}

function getMCPConnectionTroubleshootingInfo(
  name: string,
  type: string,
  details: any,
  error?: Error,
) {
  return `Troubleshooting info for ${name} (${type}): ${error?.message || 'No error'}`;
}

async function demonstrateEnhancedMCPStdio() {
  console.log('=== Enhanced MCP Stdio Server Example ===');

  // Create an enhanced MCP server with custom retry configuration
  const server = new EnhancedMCPServerStdio({
    command: 'uvx',
    args: ['mcp-server-git'],
    retryConfig: {
      maxAttempts: 5,
      baseDelay: 1000,
      backoffStrategy: 'exponential',
      jitter: true,
    },
    name: 'enhanced-git-server',
  });

  try {
    console.log('Connecting to MCP server...');
    await server.connect();
    console.log('✅ Connected successfully');

    console.log('Listing available tools...');
    const tools = await server.listTools();
    console.log(
      `📋 Found ${tools.length} tools:`,
      tools.map((t: any) => t.name),
    );

    // Example tool call (if git_status tool exists)
    if (tools.some((t: any) => t.name === 'git_status')) {
      console.log('Calling git_status tool...');
      const result = await server.callTool('git_status', {});
      console.log('📊 Git status result:', result);
    }
  } catch (error) {
    console.error('❌ Error occurred:', error);

    // Enhanced error handling provides detailed troubleshooting info
    if (error instanceof Error) {
      console.log('\n🔍 Troubleshooting Information:');
      if ('getConnectionTroubleshootingInfo' in error) {
        console.log((error as any).getConnectionTroubleshootingInfo());
      } else if ('getToolErrorInfo' in error) {
        console.log((error as any).getToolErrorInfo());
      }
    }
  } finally {
    await server.close();
    console.log('🔌 Server connection closed');
  }
}

async function demonstrateEnhancedMCPSSE() {
  console.log('\n=== Enhanced MCP SSE Server Example ===');

  // Create an enhanced SSE MCP server
  const server = new EnhancedMCPServerSSE({
    url: 'https://api.example.com/mcp',
    retryConfig: {
      maxAttempts: 3,
      baseDelay: 2000,
      backoffStrategy: 'linear',
    },
    name: 'enhanced-sse-server',
  });

  try {
    console.log('Testing server connection...');
    const testResult = await testMCPServerConnection(server, 10000);

    if (testResult.success) {
      console.log(
        `✅ Connection test passed (${testResult.latency}ms, ${testResult.toolCount} tools)`,
      );
    } else {
      console.log(`❌ Connection test failed: ${testResult.error}`);

      // Get detailed troubleshooting information
      const troubleshootingInfo = getMCPConnectionTroubleshootingInfo(
        'enhanced-sse-server',
        'sse',
        { url: 'https://api.example.com/mcp' },
        new Error(testResult.error || 'Unknown error'),
      );
      console.log('\n🔍 Troubleshooting Information:');
      console.log(troubleshootingInfo);
    }
  } catch (error) {
    console.error('❌ Error during connection test:', error);
  } finally {
    await server.close();
  }
}

async function demonstrateConnectionManager() {
  console.log('\n=== MCP Connection Manager Example ===');

  // Create multiple servers
  const servers = [
    new EnhancedMCPServerStdio({
      command: 'uvx',
      args: ['mcp-server-filesystem'],
      name: 'filesystem-server',
      retryConfig: { maxAttempts: 3 },
    }),
    new EnhancedMCPServerStdio({
      command: 'uvx',
      args: ['mcp-server-git'],
      name: 'git-server',
      retryConfig: { maxAttempts: 3 },
    }),
  ];

  // Create connection manager with health monitoring
  const manager = new MCPConnectionManager({
    checkInterval: 30000, // 30 seconds
    timeout: 5000,
    failureThreshold: 3,
    autoReconnect: true,
  });

  try {
    // Add servers to manager
    for (const server of servers) {
      manager.addServer(server);
      console.log(`📡 Added server: ${server.name}`);
    }

    // Wait a bit for initial health checks
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check health status of all servers
    console.log('\n📊 Server Health Status:');
    const healthStatuses = manager.getAllServersHealth();

    for (const [serverName, health] of healthStatuses) {
      console.log(`  ${serverName}:`);
      console.log(`    Status: ${health.status}`);
      console.log(`    Latency: ${health.latency}ms`);
      console.log(`    Consecutive Failures: ${health.consecutiveFailures}`);
      console.log(`    Last Check: ${health.lastCheck.toISOString()}`);
      if (health.lastError) {
        console.log(`    Last Error: ${health.lastError}`);
      }
    }

    // Manually trigger health check for a specific server
    console.log('\n🔍 Manual health check for filesystem-server:');
    const health = await manager.checkServerHealth('filesystem-server');
    console.log(`Status: ${health.status}, Latency: ${health.latency}ms`);
  } catch (error) {
    console.error('❌ Error in connection manager:', error);
  } finally {
    await manager.close();
    console.log('🔌 Connection manager closed');
  }
}

async function main() {
  console.log('🚀 Enhanced MCP Examples\n');

  try {
    await demonstrateEnhancedMCPStdio();
    await demonstrateEnhancedMCPSSE();
    await demonstrateConnectionManager();
  } catch (error) {
    console.error('❌ Unexpected error:', error);
  }

  console.log('\n✨ Examples completed');
}

// Run the examples
if (require.main === module) {
  main().catch(console.error);
}

export {
  demonstrateEnhancedMCPStdio,
  demonstrateEnhancedMCPSSE,
  demonstrateConnectionManager,
};
