import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAllMcpTools,
  invalidateServerToolsCache,
  type MCPServer,
  type MCPTool,
} from '../src/mcp';

const serversToInvalidate = new Set<string>();

function createCachingServer(name: string) {
  const listTools = vi.fn(async (): Promise<MCPTool[]> => [
    {
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]);
  const server = {
    cacheToolsList: true,
    name,
    connect: async () => {},
    close: async () => {},
    listTools,
    callTool: async () => [],
    invalidateToolsCache: async () => {},
  } satisfies MCPServer;
  serversToInvalidate.add(name);
  return { server, listTools };
}

afterEach(async () => {
  for (const serverName of serversToInvalidate) {
    await invalidateServerToolsCache(serverName);
  }
  serversToInvalidate.clear();
});

describe('MCP shared cache keys', () => {
  it.each(['__proto__', 'constructor'])(
    'caches a public custom key named %s without prototype collisions',
    async (cacheKey) => {
      const { server, listTools } = createCachingServer(`server-${cacheKey}`);
      const options = {
        mcpServers: [server],
        generateMCPToolCacheKey: () => cacheKey,
      };

      await expect(getAllMcpTools(options)).resolves.toHaveLength(1);
      await expect(getAllMcpTools(options)).resolves.toHaveLength(1);
      expect(listTools).toHaveBeenCalledTimes(1);

      await invalidateServerToolsCache(server.name);
      await expect(getAllMcpTools(options)).resolves.toHaveLength(1);
      expect(listTools).toHaveBeenCalledTimes(2);
    },
  );

  it('tracks a server named __proto__ without colliding with Object.prototype', async () => {
    const { server, listTools } = createCachingServer('__proto__');
    const options = {
      mcpServers: [server],
      generateMCPToolCacheKey: () => 'safe-cache-key',
    };

    await expect(getAllMcpTools(options)).resolves.toHaveLength(1);
    await expect(getAllMcpTools(options)).resolves.toHaveLength(1);
    expect(listTools).toHaveBeenCalledTimes(1);

    await invalidateServerToolsCache(server.name);
    await expect(getAllMcpTools(options)).resolves.toHaveLength(1);
    expect(listTools).toHaveBeenCalledTimes(2);
  });
});
