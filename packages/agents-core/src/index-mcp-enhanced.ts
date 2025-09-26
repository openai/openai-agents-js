/**
 * Enhanced MCP implementations with improved error handling and retry logic.
 *
 * This module provides enhanced versions of MCP servers with:
 * - Detailed error messages for connection and tool failures
 * - Configurable retry logic with exponential backoff
 * - Connection health monitoring and management
 * - Comprehensive troubleshooting utilities
 */

// Enhanced MCP server implementations
export {
  EnhancedMCPServerStdio,
  EnhancedMCPServerSSE,
  EnhancedMCPServerStreamableHttp,
  type EnhancedMCPServerStdioOptions,
  type EnhancedMCPServerStreamableHttpOptions,
  type EnhancedMCPServerSSEOptions,
} from './mcp-enhanced';

// MCP connection management and utilities
export {
  MCPConnectionManager,
  createMCPConnectionManager,
  testMCPServerConnection,
  getMCPConnectionTroubleshootingInfo,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  type MCPServerHealth,
  type MCPHealthMonitorConfig,
} from './mcp-utils';

// Enhanced error types and retry management
export {
  MCPConnectionError,
  MCPToolError,
  MCPRetryManager,
  DEFAULT_MCP_RETRY_CONFIG,
  type MCPRetryConfig,
} from './errors';

// Re-export base MCP types for convenience
export type {
  MCPServer,
  MCPTool,
  CallToolResultContent,
  MCPServerStdioOptions,
  MCPServerStreamableHttpOptions,
  MCPServerSSEOptions,
} from './mcp';
