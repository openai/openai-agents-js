import type { MCPTool } from './mcpShared';

export const cachedMcpTools: Record<string, MCPTool[]> = {};
export const cachedMcpToolKeysByServer: Record<string, Set<string>> = {};

/**
 * Remove cached tools for the given server so the next lookup fetches fresh data.
 *
 * @param serverName - Name of the MCP server whose cache should be cleared.
 */
export async function invalidateServerToolsCache(serverName: string) {
  const cachedKeys = cachedMcpToolKeysByServer[serverName];
  if (cachedKeys) {
    for (const cacheKey of cachedKeys) {
      delete cachedMcpTools[cacheKey];
    }
    delete cachedMcpToolKeysByServer[serverName];
    return;
  }

  delete cachedMcpTools[serverName];
  for (const cacheKey of Object.keys(cachedMcpTools)) {
    if (cacheKey.startsWith(`${serverName}:`)) {
      delete cachedMcpTools[cacheKey];
    }
  }
}
