import { describe, it, expect } from 'vitest';

import {
  BACKGROUND_RESULT_SYMBOL,
  RealtimeTool,
  backgroundResult,
  isBackgroundResult,
  isValidRealtimeTool,
  toRealtimeToolDefinition,
} from '../src/tool';
import { RealtimeToolDefinition } from '../src/clientMessages';

const functionTool: RealtimeTool = {
  type: 'function',
  name: 'echo',
  description: 'echo input',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
  invoke: async () => 'ok',
  needsApproval: async () => false,
  isEnabled: async () => true,
};

const hostedMcpTool: RealtimeTool = {
  type: 'hosted_tool',
  name: 'hosted_mcp',
  providerData: {
    type: 'mcp',
    server_label: 'my-mcp',
    server_url: 'https://example.com',
    headers: { Authorization: 'Bearer token' },
    allowed_tools: ['one', 'two'],
    require_approval: 'never',
  },
};

describe('realtime tool helpers', () => {
  it('creates and detects background results', () => {
    const payload = backgroundResult({ value: 42 });
    expect(payload[BACKGROUND_RESULT_SYMBOL]).toBe(true);
    expect(isBackgroundResult(payload)).toBe(true);
    expect(isBackgroundResult({ value: 42 })).toBe(false);
  });

  it('validates realtime tool shapes', () => {
    expect(isValidRealtimeTool(functionTool)).toBe(true);
    expect(isValidRealtimeTool(hostedMcpTool)).toBe(true);
    expect(
      isValidRealtimeTool({
        ...hostedMcpTool,
        name: 'other',
        type: 'hosted_tool',
      }),
    ).toBe(false);
    expect(isValidRealtimeTool({ type: 'computer' } as any)).toBe(false);
  });

  it('converts realtime tools to wire definitions', () => {
    const funcDef = toRealtimeToolDefinition(functionTool);
    expect(funcDef).toEqual(functionTool);

    const mcpDef = toRealtimeToolDefinition(hostedMcpTool);
    if (mcpDef.type !== 'mcp') {
      throw new Error('Expected mcp definition');
    }
    const expected: RealtimeToolDefinition = {
      type: 'mcp',
      server_label: 'my-mcp',
      server_url: 'https://example.com',
      headers: { Authorization: 'Bearer token' },
      allowed_tools: ['one', 'two'],
      require_approval: 'never',
    };
    expect(mcpDef).toEqual(expected);

    const withoutUrl = toRealtimeToolDefinition({
      ...hostedMcpTool,
      providerData: { ...hostedMcpTool.providerData, server_url: '' },
    });
    if (withoutUrl.type !== 'mcp') {
      throw new Error('Expected mcp definition');
    }
    expect(withoutUrl.server_url).toBeUndefined();

    expect(() =>
      toRealtimeToolDefinition({ ...functionTool, type: 'computer' } as any),
    ).toThrowError(/Invalid tool type/);
  });
});
