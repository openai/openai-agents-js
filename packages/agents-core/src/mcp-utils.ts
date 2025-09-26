import { MCPServer } from './mcp';
// Import types only when needed

/**
 * Health status of an MCP server.
 */
export interface MCPServerHealth {
  /** Current status of the server */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** Response latency in milliseconds */
  latency: number;
  /** Error rate as a percentage (0-100) */
  errorRate: number;
  /** Timestamp of the last health check */
  lastCheck: Date;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Last error message if any */
  lastError?: string;
}

/**
 * Configuration for MCP server health monitoring.
 */
export interface MCPHealthMonitorConfig {
  /** Interval between health checks in milliseconds */
  checkInterval: number;
  /** Timeout for health check operations in milliseconds */
  timeout: number;
  /** Number of consecutive failures before marking as unhealthy */
  failureThreshold: number;
  /** Number of consecutive successes needed to recover from unhealthy state */
  recoveryThreshold: number;
  /** Whether to automatically attempt reconnection on failures */
  autoReconnect: boolean;
}

/**
 * Default health monitor configuration.
 */
export const DEFAULT_HEALTH_MONITOR_CONFIG: MCPHealthMonitorConfig = {
  checkInterval: 30000, // 30 seconds
  timeout: 5000, // 5 seconds
  failureThreshold: 3,
  recoveryThreshold: 2,
  autoReconnect: true,
};

/**
 * Manages health monitoring and connection management for MCP servers.
 */
export class MCPConnectionManager {
  private servers = new Map<string, MCPServer>();
  private healthStatus = new Map<string, MCPServerHealth>();
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();
  private config: MCPHealthMonitorConfig;

  constructor(config: Partial<MCPHealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_MONITOR_CONFIG, ...config };
  }

  /**
   * Adds a server to the connection manager.
   */
  addServer(server: MCPServer): void {
    this.servers.set(server.name, server);
    this.healthStatus.set(server.name, {
      status: 'unknown',
      latency: 0,
      errorRate: 0,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    });

    // Start health monitoring
    this.startHealthMonitoring(server.name);
  }

  /**
   * Removes a server from the connection manager.
   */
  async removeServer(serverName: string): Promise<void> {
    const server = this.servers.get(serverName);
    if (server) {
      await server.close();
      this.servers.delete(serverName);
    }

    this.stopHealthMonitoring(serverName);
    this.healthStatus.delete(serverName);
  }

  /**
   * Gets the health status of a server.
   */
  getServerHealth(serverName: string): MCPServerHealth | undefined {
    return this.healthStatus.get(serverName);
  }

  /**
   * Gets all servers and their health status.
   */
  getAllServersHealth(): Map<string, MCPServerHealth> {
    return new Map(this.healthStatus);
  }

  /**
   * Manually triggers a health check for a specific server.
   */
  async checkServerHealth(serverName: string): Promise<MCPServerHealth> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server "${serverName}" not found`);
    }

    const startTime = Date.now();
    let health = this.healthStatus.get(serverName) || {
      status: 'unknown' as const,
      latency: 0,
      errorRate: 0,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    };

    try {
      // Perform health check by listing tools (lightweight operation)
      await Promise.race([
        server.listTools(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Health check timeout')),
            this.config.timeout,
          ),
        ),
      ]);

      const latency = Math.max(1, Date.now() - startTime); // Ensure latency is at least 1ms

      // Update health status on success
      health = {
        ...health,
        status: health.consecutiveFailures > 0 ? 'degraded' : 'healthy',
        latency,
        lastCheck: new Date(),
        consecutiveFailures: 0,
        lastError: undefined,
      };

      // If we were unhealthy and have enough consecutive successes, mark as healthy
      if (health.status === 'degraded') {
        const successCount = this.getConsecutiveSuccesses(serverName);
        if (successCount >= this.config.recoveryThreshold) {
          health.status = 'healthy';
        }
      }
    } catch (error) {
      const latency = Math.max(1, Date.now() - startTime); // Ensure latency is at least 1ms
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const newFailureCount = health.consecutiveFailures + 1;

      health = {
        ...health,
        status:
          newFailureCount >= this.config.failureThreshold
            ? 'unhealthy'
            : 'degraded',
        latency,
        lastCheck: new Date(),
        consecutiveFailures: newFailureCount,
        lastError: errorMessage,
      };

      // Attempt auto-reconnection if enabled and server is unhealthy
      if (this.config.autoReconnect && health.status === 'unhealthy') {
        try {
          await server.connect();
          health.status = 'degraded'; // Mark as degraded after reconnection
          health.consecutiveFailures = 0;
        } catch (_reconnectError) {
          // Reconnection failed, keep as unhealthy
        }
      }
    }

    this.healthStatus.set(serverName, health);
    return health;
  }

  /**
   * Starts health monitoring for a server.
   */
  private startHealthMonitoring(serverName: string): void {
    // Clear any existing interval
    this.stopHealthMonitoring(serverName);

    const interval = setInterval(async () => {
      try {
        await this.checkServerHealth(serverName);
      } catch (error) {
        console.warn(`Health check failed for server "${serverName}":`, error);
      }
    }, this.config.checkInterval);

    this.healthCheckIntervals.set(serverName, interval);

    // Perform initial health check
    setTimeout(() => this.checkServerHealth(serverName), 1000);
  }

  /**
   * Stops health monitoring for a server.
   */
  private stopHealthMonitoring(serverName: string): void {
    const interval = this.healthCheckIntervals.get(serverName);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(serverName);
    }
  }

  /**
   * Gets the number of consecutive successes for a server (for recovery tracking).
   */
  private getConsecutiveSuccesses(serverName: string): number {
    // This is a simplified implementation
    // In a real implementation, you might want to track this more precisely
    const health = this.healthStatus.get(serverName);
    return health?.consecutiveFailures === 0 ? 1 : 0;
  }

  /**
   * Updates the health monitor configuration.
   */
  updateConfig(config: Partial<MCPHealthMonitorConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart health monitoring with new config
    for (const serverName of this.servers.keys()) {
      this.startHealthMonitoring(serverName);
    }
  }

  /**
   * Closes all servers and stops monitoring.
   */
  async close(): Promise<void> {
    // Stop all health monitoring
    for (const serverName of this.servers.keys()) {
      this.stopHealthMonitoring(serverName);
    }

    // Close all servers
    const closePromises = Array.from(this.servers.values()).map((server) =>
      server.close(),
    );
    await Promise.allSettled(closePromises);

    // Clear all data
    this.servers.clear();
    this.healthStatus.clear();
    this.healthCheckIntervals.clear();
  }
}

/**
 * Utility function to create an MCP connection manager with multiple servers.
 */
export function createMCPConnectionManager(
  servers: MCPServer[],
  config?: Partial<MCPHealthMonitorConfig>,
): MCPConnectionManager {
  const manager = new MCPConnectionManager(config);

  for (const server of servers) {
    manager.addServer(server);
  }

  return manager;
}

/**
 * Utility function to test MCP server connectivity.
 */
export async function testMCPServerConnection(
  server: MCPServer,
  timeout: number = 5000,
): Promise<{
  success: boolean;
  latency: number;
  error?: string;
  toolCount?: number;
}> {
  const startTime = Date.now();

  try {
    // Test connection
    await server.connect();

    // Test tool listing
    const tools = await Promise.race([
      server.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection test timeout')), timeout),
      ),
    ]);

    const latency = Math.max(1, Date.now() - startTime); // Ensure latency is at least 1ms

    return {
      success: true,
      latency,
      toolCount: tools.length,
    };
  } catch (error) {
    const latency = Math.max(1, Date.now() - startTime); // Ensure latency is at least 1ms

    return {
      success: false,
      latency,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Utility function to get detailed connection troubleshooting information.
 */
export function getMCPConnectionTroubleshootingInfo(
  serverName: string,
  serverType: 'stdio' | 'sse' | 'streamable-http',
  connectionDetails: Record<string, any>,
  error?: Error,
): string {
  const info = [
    `=== MCP Connection Troubleshooting ===`,
    `Server: ${serverName}`,
    `Type: ${serverType}`,
    `Timestamp: ${new Date().toISOString()}`,
    '',
  ];

  if (error) {
    info.push(`Error: ${error.message}`);
    if (error.stack) {
      info.push(`Stack: ${error.stack}`);
    }
    info.push('');
  }

  info.push(`Connection Details:`);
  Object.entries(connectionDetails).forEach(([key, value]) => {
    info.push(`  ${key}: ${JSON.stringify(value)}`);
  });
  info.push('');

  info.push(`Troubleshooting Steps:`);
  switch (serverType) {
    case 'stdio':
      info.push(
        `1. Verify command exists and is executable:`,
        `   which ${connectionDetails.command || 'COMMAND'}`,
        `   ${connectionDetails.command || 'COMMAND'} --help`,
        ``,
        `2. Test command manually:`,
        `   ${connectionDetails.command || 'COMMAND'} ${(connectionDetails.args || []).join(' ')}`,
        ``,
        `3. Check working directory:`,
        `   ls -la ${connectionDetails.cwd || process.cwd()}`,
        ``,
        `4. Verify environment variables:`,
        `   env | grep -E '${Object.keys(connectionDetails.env || {}).join('|') || 'RELEVANT_VAR'}'`,
        ``,
        `5. Check file permissions and PATH`,
      );
      break;

    case 'sse':
    case 'streamable-http':
      info.push(
        `1. Test URL accessibility:`,
        `   curl -I "${connectionDetails.url || 'URL'}"`,
        `   ping $(echo "${connectionDetails.url || 'URL'}" | sed 's|.*://||' | sed 's|/.*||')`,
        ``,
        `2. Check network connectivity:`,
        `   nslookup $(echo "${connectionDetails.url || 'URL'}" | sed 's|.*://||' | sed 's|/.*||')`,
        `   telnet $(echo "${connectionDetails.url || 'URL'}" | sed 's|.*://||' | sed 's|:.*||') $(echo "${connectionDetails.url || 'URL'}" | sed 's|.*:||' | sed 's|/.*||')`,
        ``,
        `3. Verify server is running:`,
        `   Check server logs and status`,
        `   Verify the MCP server process is active`,
        ``,
        `4. Check authentication:`,
        `   Verify API keys, tokens, or credentials`,
        `   Check request headers and authorization`,
        ``,
        `5. Test with different client:`,
        `   Try connecting with a different MCP client`,
        `   Use debugging tools like Postman or curl`,
      );
      break;
  }

  info.push(
    ``,
    `Common Issues:`,
    `- Server not started or crashed`,
    `- Network connectivity problems`,
    `- Authentication/authorization failures`,
    `- Firewall or proxy blocking connections`,
    `- Incorrect server configuration`,
    `- Resource limitations (memory, CPU, disk)`,
    ``,
    `=== End Troubleshooting Info ===`,
  );

  return info.join('\n');
}
