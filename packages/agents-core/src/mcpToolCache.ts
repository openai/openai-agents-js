import type { MCPTool } from './mcpShared';

export const cachedMcpTools: Record<string, MCPTool[]> = {};
export const cachedMcpToolKeysByServer: Record<string, Set<string>> = {};
type ActiveServerToolsCacheListing = {
  invalidated: boolean;
};
const activeServerToolsCacheListings = new Map<
  string,
  Set<ActiveServerToolsCacheListing>
>();

export function beginServerToolsCacheListing(serverName: string): {
  isCurrent: () => boolean;
  release: () => void;
} {
  const listing = { invalidated: false };
  let activeListings = activeServerToolsCacheListings.get(serverName);
  if (!activeListings) {
    activeListings = new Set();
    activeServerToolsCacheListings.set(serverName, activeListings);
  }
  activeListings.add(listing);

  let released = false;
  return {
    isCurrent: () => !listing.invalidated,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      activeListings.delete(listing);
      if (activeListings.size === 0) {
        activeServerToolsCacheListings.delete(serverName);
      }
    },
  };
}

/**
 * Remove cached tools for the given server so the next lookup fetches fresh data.
 *
 * @param serverName - Name of the MCP server whose cache should be cleared.
 */
export async function invalidateServerToolsCache(serverName: string) {
  const activeListings = activeServerToolsCacheListings.get(serverName);
  if (activeListings) {
    for (const listing of activeListings) {
      listing.invalidated = true;
    }
  }
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
