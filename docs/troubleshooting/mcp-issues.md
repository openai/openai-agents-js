# MCP (Model Context Protocol) Troubleshooting Guide

This guide helps you diagnose and resolve common issues when working with MCP servers and tools in OpenAI Agents.

## Common MCP Connection Issues

### 1. Server Connection Failures

**Symptoms:**

- `MCPConnectionError: Failed to connect to server`
- `Error: ECONNREFUSED` when connecting to MCP server
- Timeout errors during server initialization

**Causes & Solutions:**

#### Server Not Running

```bash
# Check if the MCP server process is running
ps aux | grep mcp-server

# Start the server if not running
uvx your-mcp-server@latest
```

#### Incorrect Server Configuration

```typescript
// ❌ Incorrect configuration
const server = new MCPServerStdio({
  command: 'wrong-command', // Command doesn't exist
  args: ['--invalid-arg'], // Invalid arguments
  timeout: 1000, // Too short timeout
});

// ✅ Correct configuration
const server = new MCPServerStdio({
  command: 'uvx', // Correct command
  args: ['mcp-server-filesystem'], // Valid server package
  env: {
    // Add required environment variables
  },
});
```

#### Network/Firewall Issues

```bash
# Test connectivity
curl -v http://localhost:3001/health

# Check firewall rules (macOS)
sudo pfctl -sr | grep 3001

# Check if port is in use
lsof -i :3001
```

### 2. Tool Discovery Problems

**Symptoms:**

- `No tools found` error
- Tools not appearing in agent capabilities
- `Tool not found: toolName` errors

**Diagnostic Steps:**

```typescript
// Debug tool discovery
import { Agent, MCPServerStdio } from '@openai/agents';

async function debugToolDiscovery() {
  try {
    // Set up MCP server
    const server = new MCPServerStdio({
      command: 'uvx',
      args: ['mcp-server-filesystem'], // Replace with your MCP server
      env: {},
    });

    // Create test agent
    const agent = new Agent({
      name: 'debug-agent',
      instructions: 'List available tools and test basic functionality.',
      model: 'gpt-4',
      tools: [server],
    });

    console.log('✅ MCP server configured');

    // Test basic functionality
    const result = await agent.run('What tools do you have available?');
    console.log(
      'Agent response:',
      result.messages[result.messages.length - 1].content,
    );
  } catch (error) {
    console.error('❌ MCP Debug failed:', error);

    // Additional diagnostics
    if (error.message.includes('spawn')) {
      console.log(
        '💡 Server command failed to start. Check if the MCP server is installed.',
      );
    } else if (error.message.includes('timeout')) {
      console.log(
        '💡 Server startup timeout. Check server logs or increase timeout.',
      );
    } else if (error.message.includes('tool not found')) {
      console.log('💡 Tool registration issue. Check server tool definitions.');
    }
  }
}
```

### 3. Tool Execution Failures

**Symptoms:**

- Tools execute but return errors
- Inconsistent tool behavior
- Tool timeouts

**Common Solutions:**

#### Validate Tool Arguments

```typescript
// Add argument validation for MCP tools
const validateToolArgs = (toolName: string, args: any) => {
  const schemas = {
    file_read: {
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
      },
    },
  };

  const schema = schemas[toolName];
  if (!schema) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Validate required fields
  for (const field of schema.required) {
    if (!(field in args)) {
      throw new Error(`Missing required argument: ${field}`);
    }
  }

  return true;
};

// Use with MCP server
const server = new MCPServerStdio({
  command: 'uvx',
  args: ['mcp-server-filesystem'],
});

const agent = new Agent({
  name: 'file-agent',
  instructions:
    'Help users with file operations. Validate all arguments before use.',
  model: 'gpt-4',
  tools: [server], // MCP server handles tool execution automatically
});
```

#### Handle Tool Timeouts

```typescript
// Configure MCP server with timeout
const server = new MCPServerStdio({
  command: 'uvx',
  args: ['mcp-server-filesystem'],
  env: {
    MCP_TIMEOUT: '30000', // 30 second timeout
  },
});

// Use with agent that has timeout handling
const agent = new Agent({
  name: 'timeout-aware-agent',
  instructions: 'Use tools efficiently and handle timeouts gracefully.',
  model: 'gpt-4',
  tools: [server],
  maxTurns: 5, // Limit turns to prevent hanging
});

// Execute with overall timeout
const executeWithTimeout = async (input: string, timeoutMs = 60000) => {
  return Promise.race([
    agent.run(input),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`Agent execution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
};
```

## MCP Server Health Monitoring

### Health Check Implementation

```typescript
class MCPHealthMonitor {
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private server: MCPServerStdio;
  private testAgent: Agent;

  constructor(
    serverConfig: any,
    private checkIntervalMs = 30000,
  ) {
    this.server = new MCPServerStdio(serverConfig);
    this.testAgent = new Agent({
      name: 'health-check-agent',
      instructions: 'Perform health checks on MCP server.',
      model: 'gpt-4',
      tools: [this.server],
    });
  }

  startMonitoring() {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const startTime = Date.now();

        // Test server health by running a simple query
        await this.testAgent.run('What tools are available?', { maxTurns: 1 });

        const latency = Date.now() - startTime;
        console.log(`✅ MCP Health Check: OK (${latency}ms)`);

        if (latency > 10000) {
          console.warn(`⚠️ High latency detected: ${latency}ms`);
        }
      } catch (error) {
        console.error('❌ MCP Health Check failed:', error);
        await this.attemptRecovery();
      }
    }, this.checkIntervalMs);
  }

  stopMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async attemptRecovery() {
    console.log('🔄 Attempting MCP server recovery...');
    try {
      // Recreate the server and agent
      this.server = new MCPServerStdio(this.server);
      this.testAgent = new Agent({
        name: 'health-check-agent',
        instructions: 'Perform health checks on MCP server.',
        model: 'gpt-4',
        tools: [this.server],
      });
      console.log('✅ MCP server recovery successful');
    } catch (error) {
      console.error('❌ MCP server recovery failed:', error);
    }
  }
}
```

## Best Practices for MCP Integration

### 1. Connection Management

```typescript
// Use server pooling for multiple agents
class MCPServerPool {
  private servers = new Map<string, MCPServerStdio>();

  getServer(serverName: string, config: any): MCPServerStdio {
    if (!this.servers.has(serverName)) {
      const server = new MCPServerStdio(config);
      this.servers.set(serverName, server);
    }
    return this.servers.get(serverName)!;
  }

  createAgent(agentName: string, serverName: string, serverConfig: any) {
    const server = this.getServer(serverName, serverConfig);

    return new Agent({
      name: agentName,
      instructions: `Use ${serverName} MCP server tools to help users.`,
      model: 'gpt-4',
      tools: [server],
    });
  }

  cleanup() {
    // MCP servers are cleaned up automatically
    this.servers.clear();
  }
}
```

### 2. Error Recovery Strategies

```typescript
const createResilientMCPAgent = (serverConfig: any) => {
  const maxRetries = 3;

  const executeWithRetry = async (input: string, attempt = 1): Promise<any> => {
    try {
      const server = new MCPServerStdio(serverConfig);
      const agent = new Agent({
        name: 'resilient-mcp-agent',
        instructions: 'Use MCP tools to help users. Handle errors gracefully.',
        model: 'gpt-4',
        tools: [server],
      });

      return await agent.run(input);
    } catch (error) {
      if (attempt < maxRetries) {
        console.warn(`Attempt ${attempt} failed, retrying...`, error.message);

        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        return executeWithRetry(input, attempt + 1);
      } else {
        throw new Error(
          `MCP operation failed after ${maxRetries} attempts: ${error.message}`,
        );
      }
    }
  };

  return { executeWithRetry };
};
```

### 3. Logging and Debugging

```typescript
// Enable detailed MCP logging
import { Agent, MCPServerStdio, withTrace } from '@openai/agents';

const server = new MCPServerStdio({
  command: 'uvx',
  args: ['mcp-server-filesystem'],
  env: {
    DEBUG: '1', // Enable debug logging in MCP server
    MCP_LOG_LEVEL: 'debug',
  },
});

const agent = new Agent({
  name: 'debug-mcp-agent',
  instructions: 'Use MCP tools with detailed logging.',
  model: 'gpt-4',
  tools: [server],
});

// Use with tracing for detailed logs
const result = await withTrace('mcp-debug-session', async () => {
  return await agent.run('List files in current directory');
});

console.log('MCP operation completed with tracing');
```

## Quick Diagnostic Checklist

When experiencing MCP issues, check these items in order:

1. **Server Status**
   - [ ] MCP server process is running
   - [ ] Server is listening on correct port
   - [ ] Server logs show no errors

2. **Network Connectivity**
   - [ ] Can connect to server URL from browser/curl
   - [ ] No firewall blocking the port
   - [ ] Correct server URL in configuration

3. **Tool Configuration**
   - [ ] Tools are properly registered on server
   - [ ] Tool schemas match expected arguments
   - [ ] Tool permissions are correctly set

4. **Client Configuration**
   - [ ] Timeout values are reasonable (>30s)
   - [ ] Retry logic is implemented
   - [ ] Error handling is comprehensive

5. **Resource Constraints**
   - [ ] Server has sufficient memory/CPU
   - [ ] No resource limits being hit
   - [ ] Concurrent connection limits not exceeded

## Getting Help

If you're still experiencing issues:

1. Enable debug logging and capture the full error trace
2. Check the MCP server logs for additional context
3. Test with a minimal reproduction case
4. Consult the MCP server documentation for server-specific issues
5. Report bugs with full diagnostic information
