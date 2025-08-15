import { describe, it, expect, beforeAll } from 'vitest';
import { Agent, run, setDefaultModelProvider } from '../src';
import { mcpToFunctionTool } from '../src/mcp';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import { createMCPToolStaticFilter } from '../src/mcpUtil';
import { FakeModel, FakeModelProvider } from './stubs';
import { Usage } from '../src/usage';
import type { ModelResponse } from '../src';
import * as fs from 'node:fs';
import * as path from 'node:path';

class StubFilesystemServer extends NodeMCPServerStdio {
  private dir: string;
  public tools: any[];
  constructor(dir: string, filter: any) {
    super({ command: 'noop', name: 'stubfs', cacheToolsList: true });
    this.dir = dir;
    this.toolFilter = filter;
    this.tools = [
      {
        name: 'read_file',
        description: '',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_directory',
        description: '',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'write_file',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['path', 'text'],
          additionalProperties: false,
        },
      },
    ];
  }
  async connect() {}
  async close() {}
  async listTools() {
    return this.tools;
  }
  async callTool(name: string, args: any) {
    const blocked = (this.toolFilter as any)?.blockedToolNames ?? [];
    if (blocked.includes(name)) {
      return [
        { type: 'text', text: `Tool "${name}" is blocked by MCP filter` },
      ];
    }
    if (name === 'list_directory') {
      const files = fs.readdirSync(this.dir);
      return [{ type: 'text', text: files.join('\n') }];
    }
    if (name === 'read_file') {
      const text = fs.readFileSync(path.join(this.dir, args.path), 'utf8');
      return [{ type: 'text', text }];
    }
    if (name === 'write_file') {
      fs.writeFileSync(path.join(this.dir, args.path), args.text, 'utf8');
      return [{ type: 'text', text: 'ok' }];
    }
    return [];
  }
}

describe('MCP tool filter integration', () => {
  beforeAll(() => {
    setDefaultModelProvider(new FakeModelProvider());
  });
  const samplesDir = path.join(__dirname, '../../../examples/mcp/sample_files');
  const filter = createMCPToolStaticFilter({
    allowed: ['read_file', 'list_directory', 'write_file'],
    blocked: ['write_file'],
  });
  const server = new StubFilesystemServer(samplesDir, filter);
  const tools = server.tools.map((t) => mcpToFunctionTool(t, server, false));

  it('allows listing files', async () => {
    const modelResponses: ModelResponse[] = [
      {
        output: [
          {
            id: '1',
            type: 'function_call',
            name: 'list_directory',
            callId: '1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      },
    ];
    const agent = new Agent({
      name: 'Lister',
      toolUseBehavior: 'stop_on_first_tool',
      model: new FakeModel(modelResponses),
      tools,
    });
    const result = await run(agent, 'List files');
    expect(result.finalOutput).toContain('books.txt');
    expect(result.finalOutput).toContain('favorite_songs.txt');
  });

  it('blocks write_file', async () => {
    const modelResponses: ModelResponse[] = [
      {
        output: [
          {
            id: '1',
            type: 'function_call',
            name: 'write_file',
            callId: '1',
            status: 'completed',
            arguments: '{"path":"test.txt","text":"hello"}',
          },
        ],
        usage: new Usage(),
      },
    ];
    const agent = new Agent({
      name: 'Writer',
      toolUseBehavior: 'stop_on_first_tool',
      model: new FakeModel(modelResponses),
      tools,
    });
    const result = await run(agent, 'write');
    expect(result.finalOutput).toBe(
      JSON.stringify({
        type: 'text',
        text: 'Tool "write_file" is blocked by MCP filter',
      }),
    );
  });
});
