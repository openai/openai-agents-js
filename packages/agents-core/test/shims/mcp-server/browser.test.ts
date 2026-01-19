import { describe, test, expect } from 'vitest';
import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  MCPServerSSE,
} from '../../../src/shims/mcp-server/browser';

describe('MCPServerStdio', () => {
  test('should be available', async () => {
    const server = new MCPServerStdio({
      name: 'test',
      fullCommand: 'test',
      cacheToolsList: true,
    });
    expect(server).toBeDefined();
    await expect(() => server.connect()).toThrow();
  });
});

describe('MCPServerStreamableHttp', () => {
  test('throws for unimplemented methods', () => {
    const server = new MCPServerStreamableHttp({
      name: 'test',
      url: 'https://example.com',
    });
    expect(server.name).toBeDefined();
    expect(() => server.connect()).toThrow();
    expect(() => server.close()).toThrow();
    expect(() => server.listTools()).toThrow();
    expect(() => server.callTool('tool', {})).toThrow();
    expect(() => server.invalidateToolsCache()).toThrow();
  });
});

describe('MCPServerSSE', () => {
  test('throws for unimplemented methods', () => {
    const server = new MCPServerSSE({
      name: 'test',
      url: 'https://example.com/sse',
    });
    expect(server.name).toBeDefined();
    expect(() => server.connect()).toThrow();
    expect(() => server.close()).toThrow();
    expect(() => server.listTools()).toThrow();
    expect(() => server.callTool('tool', {})).toThrow();
    expect(() => server.invalidateToolsCache()).toThrow();
  });
});
