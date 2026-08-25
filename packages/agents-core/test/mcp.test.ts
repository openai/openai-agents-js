import { describe, test, expect } from 'vitest';
import {
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  ToolGuardrailFunctionOutputFactory,
} from '../src';

describe('MCPServerStdio', () => {
  test('should be available', () => {
    const server = new MCPServerStdio({
      name: 'test',
      fullCommand: 'test',
      cacheToolsList: true,
    });
    expect(server).toBeDefined();
    expect(server.name).toBe('test');
    expect(server.cacheToolsList).toBe(true);
  });

  test('transport constructors retain server-wide tool guardrails', () => {
    const inputGuardrails = [
      defineToolInputGuardrail({
        name: 'server-input',
        run: async () => ToolGuardrailFunctionOutputFactory.allow(),
      }),
    ];
    const outputGuardrails = [
      defineToolOutputGuardrail({
        name: 'server-output',
        run: async () => ToolGuardrailFunctionOutputFactory.allow(),
      }),
    ];
    const servers = [
      new MCPServerStdio({
        name: 'stdio',
        fullCommand: 'test',
        toolInputGuardrails: inputGuardrails,
        toolOutputGuardrails: outputGuardrails,
      }),
      new MCPServerStreamableHttp({
        name: 'streamable-http',
        url: 'https://example.test/mcp',
        toolInputGuardrails: inputGuardrails,
        toolOutputGuardrails: outputGuardrails,
      }),
      new MCPServerSSE({
        name: 'sse',
        url: 'https://example.test/sse',
        toolInputGuardrails: inputGuardrails,
        toolOutputGuardrails: outputGuardrails,
      }),
    ];

    for (const server of servers) {
      expect(server.toolInputGuardrails).toBe(inputGuardrails);
      expect(server.toolOutputGuardrails).toBe(outputGuardrails);
    }
  });
});
