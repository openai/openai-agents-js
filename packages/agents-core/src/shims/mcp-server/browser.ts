import {
  BaseMCPServerStdio,
  BaseMCPServerStreamableHttp,
  CallToolResultContent,
  MCPServerStdioOptions,
  MCPServerStreamableHttpOptions,
  MCPTool,
} from '../../mcp';
import type { RunContext } from '../../runContext';
import type { Agent } from '../../agent';

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
  listTools(
    _runContext?: RunContext<any>,
    _agent?: Agent<any, any>,
  ): Promise<MCPTool[]> {
    throw new Error('Method not implemented.');
  }
  callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
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
  listTools(
    _runContext?: RunContext<any>,
    _agent?: Agent<any, any>,
  ): Promise<MCPTool[]> {
    throw new Error('Method not implemented.');
  }
  callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    throw new Error('Method not implemented.');
  }
}
