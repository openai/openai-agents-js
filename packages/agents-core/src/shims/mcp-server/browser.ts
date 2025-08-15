import {
  BaseMCPServerSSE,
  BaseMCPServerStdio,
  BaseMCPServerStreamableHttp,
  CallToolResultContent,
  MCPServerSSEOptions,
  MCPServerStdioOptions,
  MCPServerStreamableHttpOptions,
  MCPTool,
} from '../../mcp';

export class MCPServerStdio extends BaseMCPServerStdio {
  constructor(params: MCPServerStdioOptions) {
    super(params);
  }
  get name(): string {
    return 'MCPServerStdio';
  }
  connect(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  close(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  listTools(): Promise<MCPTool[]> {
    throw new Error('Method not implemented.');
  }
  callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    throw new Error('Method not implemented.');
  }
  invalidateToolsCache(): Promise<void> {
    throw new Error('Method not implemented.');
  }
}

export class MCPServerStreamableHttp extends BaseMCPServerStreamableHttp {
  constructor(params: MCPServerStreamableHttpOptions) {
    super(params);
  }
  get name(): string {
    return 'MCPServerStdio';
  }
  connect(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  close(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  listTools(): Promise<MCPTool[]> {
    throw new Error('Method not implemented.');
  }
  callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    throw new Error('Method not implemented.');
  }
  invalidateToolsCache(): Promise<void> {
    throw new Error('Method not implemented.');
  }
}

export class MCPServerSSE extends BaseMCPServerSSE {
  constructor(params: MCPServerSSEOptions) {
    super(params);
  }

  get name(): string {
    return 'MCPServerSSE';
  }
  connect(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  close(): Promise<void> {
    throw new Error('Method not implemented.');
  }

  listTools(): Promise<MCPTool[]> {
    throw new Error('Method not implemented.');
  }
  callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    throw new Error('Method not implemented.');
  }

  invalidateToolsCache(): Promise<void> {
    throw new Error('Method not implemented.');
  }
}
