# Enhanced MCP Support

The OpenAI Agents SDK provides enhanced MCP (Model Context Protocol) implementations with improved error handling, retry logic, and connection management capabilities.

## Features

### 🔄 Retry Logic

- Configurable retry attempts with exponential, linear, or fixed backoff strategies
- Jitter support to prevent thundering herd problems
- Automatic retry on transient failures

### 🚨 Enhanced Error Handling

- Detailed error messages with contextual information
- Specific error types for connection and tool failures
- Built-in troubleshooting suggestions and recovery actions

### 📊 Health Monitoring

- Automatic health checks for MCP servers
- Connection status tracking and alerting
- Automatic reconnection on failures

### 🔧 Debugging Utilities

- Comprehensive error context with operation tracking
- Connection troubleshooting information
- Performance metrics and latency tracking

## Enhanced MCP Server Classes

### EnhancedMCPServerStdio

Enhanced version of the stdio MCP server with retry logic and better error handling.

```typescript
import { EnhancedMCPServerStdio } from '@openai/agents-core/mcpEnhanced';

const server = new EnhancedMCPServerStdio({
  command: 'uvx',
  args: ['mcp-server-git'],
  retryConfig: {
    maxAttempts: 5,
    baseDelay: 1000,
    backoffStrategy: 'exponential',
    jitter: true,
  },
  name: 'git-server',
});

try {
  await server.connect();
  const tools = await server.listTools();
  const result = await server.callTool('git_status', {});
} catch (error) {
  if (error instanceof MCPConnectionError) {
    console.log(error.getConnectionTroubleshootingInfo());
  }
} finally {
  await server.close();
}
```

### EnhancedMCPServerSSE

Enhanced version of the SSE MCP server.

```typescript
import { EnhancedMCPServerSSE } from '@openai/agents-core/mcpEnhanced';

const server = new EnhancedMCPServerSSE({
  url: 'https://api.example.com/mcp',
  retryConfig: {
    maxAttempts: 3,
    baseDelay: 2000,
    backoffStrategy: 'linear',
  },
});
```

### EnhancedMCPServerStreamableHttp

Enhanced version of the streamable HTTP MCP server.

```typescript
import { EnhancedMCPServerStreamableHttp } from '@openai/agents-core/mcpEnhanced';

const server = new EnhancedMCPServerStreamableHttp({
  url: 'https://api.example.com/mcp',
  retryConfig: {
    maxAttempts: 3,
    baseDelay: 1000,
    backoffStrategy: 'exponential',
  },
});
```

## Retry Configuration

Configure retry behavior for MCP operations:

```typescript
interface MCPRetryConfig {
  maxAttempts: number; // Maximum retry attempts (default: 3)
  baseDelay: number; // Base delay in milliseconds (default: 1000)
  maxDelay: number; // Maximum delay in milliseconds (default: 10000)
  backoffStrategy: 'exponential' | 'linear' | 'fixed'; // Default: 'exponential'
  backoffMultiplier: number; // Multiplier for exponential backoff (default: 2)
  jitter: boolean; // Add randomness to delays (default: true)
}
```

## Connection Management

### MCPConnectionManager

Manages multiple MCP servers with health monitoring:

```typescript
import { MCPConnectionManager } from '@openai/agents-core/mcpEnhanced';

const manager = new MCPConnectionManager({
  checkInterval: 30000, // Health check interval (30 seconds)
  timeout: 5000, // Health check timeout (5 seconds)
  failureThreshold: 3, // Failures before marking unhealthy
  recoveryThreshold: 2, // Successes needed to recover
  autoReconnect: true, // Automatic reconnection
});

// Add servers
manager.addServer(server1);
manager.addServer(server2);

// Check health
const health = await manager.checkServerHealth('server-name');
console.log(`Status: ${health.status}, Latency: ${health.latency}ms`);

// Get all server health
const allHealth = manager.getAllServersHealth();
```

### Health Status

Server health information:

```typescript
interface MCPServerHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  latency: number; // Response time in milliseconds
  errorRate: number; // Error rate percentage
  lastCheck: Date; // Last health check timestamp
  consecutiveFailures: number; // Number of consecutive failures
  lastError?: string; // Last error message
}
```

## Error Types

### MCPConnectionError

Thrown when MCP server connection fails:

```typescript
try {
  await server.connect();
} catch (error) {
  if (error instanceof MCPConnectionError) {
    console.log(`Server: ${error.serverName}`);
    console.log(`Type: ${error.serverType}`);
    console.log(`Details:`, error.connectionDetails);
    console.log(error.getConnectionTroubleshootingInfo());
  }
}
```

### MCPToolError

Thrown when MCP tool operations fail:

```typescript
try {
  const result = await server.callTool('tool-name', args);
} catch (error) {
  if (error instanceof MCPToolError) {
    console.log(`Server: ${error.serverName}`);
    console.log(`Tool: ${error.toolName}`);
    console.log(`Operation: ${error.operation}`);
    console.log(`Retry Attempt: ${error.retryAttempt}`);
    console.log(error.getToolErrorInfo());
  }
}
```

## Utility Functions

### testMCPServerConnection

Test MCP server connectivity:

```typescript
import { testMCPServerConnection } from '@openai/agents-core/mcpEnhanced';

const result = await testMCPServerConnection(server, 10000);

if (result.success) {
  console.log(
    `Connected in ${result.latency}ms, found ${result.toolCount} tools`,
  );
} else {
  console.log(`Connection failed: ${result.error}`);
}
```

### getMCPConnectionTroubleshootingInfo

Get detailed troubleshooting information:

```typescript
import { getMCPConnectionTroubleshootingInfo } from '@openai/agents-core/mcpEnhanced';

const info = getMCPConnectionTroubleshootingInfo(
  'server-name',
  'stdio',
  { command: 'uvx', args: ['mcp-server'] },
  error,
);

console.log(info);
```

## Best Practices

### 1. Configure Appropriate Retry Settings

```typescript
// For local stdio servers (faster retries)
const localRetryConfig = {
  maxAttempts: 5,
  baseDelay: 500,
  backoffStrategy: 'exponential' as const,
};

// For remote HTTP servers (slower retries)
const remoteRetryConfig = {
  maxAttempts: 3,
  baseDelay: 2000,
  backoffStrategy: 'linear' as const,
};
```

### 2. Use Connection Manager for Multiple Servers

```typescript
// Create manager with appropriate settings
const manager = new MCPConnectionManager({
  checkInterval: 60000, // Check every minute
  failureThreshold: 2, // Mark unhealthy after 2 failures
  autoReconnect: true, // Auto-reconnect on failures
});

// Add all your servers
servers.forEach((server) => manager.addServer(server));
```

### 3. Handle Errors Gracefully

```typescript
try {
  const result = await server.callTool('tool-name', args);
  return result;
} catch (error) {
  if (error instanceof MCPToolError) {
    // Log detailed error information
    console.error(error.getToolErrorInfo());

    // Try fallback or alternative approach
    return await fallbackOperation();
  }
  throw error;
}
```

### 4. Monitor Server Health

```typescript
// Set up periodic health monitoring
setInterval(async () => {
  const health = manager.getAllServersHealth();

  for (const [name, status] of health) {
    if (status.status === 'unhealthy') {
      console.warn(`Server ${name} is unhealthy: ${status.lastError}`);
      // Send alert or take corrective action
    }
  }
}, 300000); // Check every 5 minutes
```

## Migration from Standard MCP

To migrate from standard MCP servers to enhanced versions:

1. Replace import statements:

```typescript
// Before
import { MCPServerStdio } from '@openai/agents-core';

// After
import { EnhancedMCPServerStdio } from '@openai/agents-core/mcpEnhanced';
```

2. Update server instantiation:

```typescript
// Before
const server = new MCPServerStdio({ command: 'uvx', args: ['mcp-server'] });

// After
const server = new EnhancedMCPServerStdio({
  command: 'uvx',
  args: ['mcp-server'],
  retryConfig: { maxAttempts: 3 }, // Add retry configuration
});
```

3. Update error handling:

```typescript
// Before
try {
  await server.connect();
} catch (error) {
  console.error('Connection failed:', error.message);
}

// After
try {
  await server.connect();
} catch (error) {
  if (error instanceof MCPConnectionError) {
    console.error(error.getConnectionTroubleshootingInfo());
  } else {
    console.error('Connection failed:', error.message);
  }
}
```

The enhanced MCP implementations are fully backward compatible with existing code while providing additional reliability and debugging capabilities.
