import type { MCPServer } from '@openai/agents-core';
export type MCPTool = Awaited<ReturnType<MCPServer['listTools']>>[number];
import { vi } from 'vitest';

export function borrowedDeclaration(name = 'lookup'): MCPTool {
  return {
    name,
    description: `Execute ${name}`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 2 } },
      required: ['value'],
      additionalProperties: false,
    },
  };
}

/** An application-owned server; only the model/native dispatch is a wire fixture. */
export class BorrowedPeer implements MCPServer {
  name = 'application-server';
  cacheToolsList = true;
  declarations = [borrowedDeclaration()];
  toolFilter?: MCPServer['toolFilter'];
  callToolResult?: MCPServer['callToolResult'];
  connect = vi.fn(async () => {});
  close = vi.fn(async () => {});
  invalidateToolsCache = vi.fn(async () => {});
  listTools = vi.fn<MCPServer['listTools']>(async () => this.declarations);
  callTool = vi.fn<MCPServer['callTool']>(async (name, args) => [
    { type: 'text', text: JSON.stringify({ name, args }) },
  ]);
}
