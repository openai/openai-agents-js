import type { MCPTool } from './mcpShared';

export const cachedMcpTools: Record<string, MCPTool[]> = {};
export const cachedMcpToolKeysByServer: Record<string, Set<string>> = {};
type ActiveServerToolsCacheListing = {
  invalidated: boolean;
};
// Wrappers and transports cache separate lists. Dropping a server's set
// invalidates both layers without retaining the servers or their tool lists.
const localToolLists = new Map<string, WeakSet<MCPTool[]>>();

export function localToolsCache(server: {
  name: string;
  cacheToolsList: boolean;
}) {
  if (!server.cacheToolsList) return undefined;
  const name = server.name;
  const lists = localToolLists.get(name) ?? new WeakSet<MCPTool[]>();
  localToolLists.set(name, lists);
  return {
    has: (tools: MCPTool[]) => lists.has(tools),
    store(tools: MCPTool[]): MCPTool[] {
      if (localToolLists.get(name) !== lists) {
        throw new Error('MCP tool listing became stale before it completed.');
      }
      lists.add(tools);
      return tools;
    },
  };
}

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
  localToolLists.delete(serverName);
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
}
