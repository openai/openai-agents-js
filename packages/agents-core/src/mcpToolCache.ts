import type { MCPTool } from './mcpShared';

export const cachedMcpTools: Record<string, MCPTool[]> = {};
export const cachedMcpToolKeysByServer: Record<string, Set<string>> = {};
const cacheGenerationByServer = new Map<string, number>();

export function getServerToolsCacheGeneration(serverName: string): number {
  return cacheGenerationByServer.get(serverName) ?? 0;
}

/**
 * Remove cached tools for the given server so the next lookup fetches fresh data.
 *
 * @param serverName - Name of the MCP server whose cache should be cleared.
 */
export async function invalidateServerToolsCache(serverName: string) {
  cacheGenerationByServer.set(
    serverName,
    getServerToolsCacheGeneration(serverName) + 1,
  );
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
