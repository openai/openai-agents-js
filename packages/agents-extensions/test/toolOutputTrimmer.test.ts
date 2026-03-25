import { describe, it, expect } from 'vitest';
import { ToolOutputTrimmer } from '../src/toolOutputTrimmer';
import type {
  CallModelInputFilterArgs,
  AgentInputItem,
} from '@openai/agents-core';

function userMessage(text: string): AgentInputItem {
  return { role: 'user', content: text } as unknown as AgentInputItem;
}

function assistantMessage(text: string): AgentInputItem {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  } as unknown as AgentInputItem;
}

function functionCall(
  callId: string,
  name: string,
  namespace?: string,
): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name,
    ...(namespace ? { namespace } : {}),
  } as unknown as AgentInputItem;
}

function functionCallResult(callId: string, output: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'tool',
    status: 'completed',
    output,
  } as unknown as AgentInputItem;
}

function toolSearchOutput(tools: unknown[]): AgentInputItem {
  return {
    type: 'tool_search_output',
    tools,
  } as unknown as AgentInputItem;
}

function makeArgs(items: AgentInputItem[]): CallModelInputFilterArgs {
  return {
    modelData: { input: items },
    agent: {} as any,
    context: undefined,
  };
}

describe('ToolOutputTrimmer', () => {
  it('trims old function_call_result outputs exceeding maxOutputChars', () => {
    const largeOutput = 'x'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', largeOutput),
      userMessage('second question'),
      assistantMessage('response'),
      userMessage('third question'),
      assistantMessage('final response'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
      previewChars: 100,
    });

    const result = trimmer.filter(makeArgs(items));
    const trimmedItem = result.input[2] as Record<string, unknown>;
    expect(typeof trimmedItem.output).toBe('string');
    expect((trimmedItem.output as string).length).toBeLessThan(
      largeOutput.length,
    );
    expect(trimmedItem.output as string).toContain('[Trimmed:');
    expect(trimmedItem.output as string).toContain('search');
  });

  it('does not trim outputs shorter than maxOutputChars', () => {
    const smallOutput = 'x'.repeat(100);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', smallOutput),
      userMessage('second question'),
      assistantMessage('response'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
    });

    const result = trimmer.filter(makeArgs(items));
    const resultItem = result.input[2] as Record<string, unknown>;
    expect(resultItem.output).toBe(smallOutput);
  });

  it('does not trim items in the recent window', () => {
    const largeOutput = 'x'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      assistantMessage('response'),
      userMessage('second question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', largeOutput),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
    });

    const result = trimmer.filter(makeArgs(items));
    const resultItem = result.input[4] as Record<string, unknown>;
    expect(resultItem.output).toBe(largeOutput);
  });

  it('respects trimmableTools filter', () => {
    const largeOutput = 'x'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', largeOutput),
      functionCall('c2', 'execute_code'),
      functionCallResult('c2', largeOutput),
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
      trimmableTools: new Set(['search']),
    });

    const result = trimmer.filter(makeArgs(items));
    const searchResult = result.input[2] as Record<string, unknown>;
    const codeResult = result.input[4] as Record<string, unknown>;

    expect(searchResult.output as string).toContain('[Trimmed:');
    expect(codeResult.output).toBe(largeOutput);
  });

  it('trims all tools when trimmableTools is null', () => {
    const largeOutput = 'x'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', largeOutput),
      functionCall('c2', 'execute_code'),
      functionCallResult('c2', largeOutput),
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
      trimmableTools: null,
    });

    const result = trimmer.filter(makeArgs(items));
    const searchResult = result.input[2] as Record<string, unknown>;
    const codeResult = result.input[4] as Record<string, unknown>;

    expect(searchResult.output as string).toContain('[Trimmed:');
    expect(codeResult.output as string).toContain('[Trimmed:');
  });

  it('matches namespace-qualified tool names in trimmableTools', () => {
    const largeOutput = 'x'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search', 'mcp_server'),
      functionCallResult('c1', largeOutput),
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
      trimmableTools: new Set(['mcp_server.search']),
    });

    const result = trimmer.filter(makeArgs(items));
    const searchResult = result.input[2] as Record<string, unknown>;
    expect(searchResult.output as string).toContain('[Trimmed:');
  });

  it('trims tool_search_output items', () => {
    const longDesc = 'd'.repeat(1000);
    const tools = [
      {
        type: 'function',
        name: 'search',
        description: longDesc,
        parameters: {
          type: 'object',
          description: 'Search parameters',
          title: 'SearchParams',
          properties: { query: { type: 'string', description: 'The query' } },
        },
      },
    ];

    const items: AgentInputItem[] = [
      userMessage('first question'),
      toolSearchOutput(tools),
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 100,
      previewChars: 50,
    });

    const result = trimmer.filter(makeArgs(items));
    const resultItem = result.input[1] as Record<string, unknown>;
    const resultTools = resultItem.tools as Record<string, unknown>[];
    expect(resultTools[0].description).not.toBe(longDesc);
    // JSON schema prose fields should be stripped
    const params = resultTools[0].parameters as Record<string, unknown>;
    expect(params.description).toBeUndefined();
    expect(params.title).toBeUndefined();
  });

  it('truncates preview to previewChars', () => {
    const largeOutput = 'abcdefghij'.repeat(100);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', largeOutput),
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 100,
      previewChars: 50,
    });

    const result = trimmer.filter(makeArgs(items));
    const output = (result.input[2] as Record<string, unknown>)
      .output as string;
    expect(output).toContain(largeOutput.slice(0, 50));
    expect(output).toContain('...');
  });

  it('does not mutate original items', () => {
    const largeOutput = 'x'.repeat(1000);
    const original = functionCallResult('c1', largeOutput);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      original,
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
    });
    trimmer.filter(makeArgs(items));

    expect((original as Record<string, unknown>).output).toBe(largeOutput);
  });

  it('returns input unchanged when empty', () => {
    const trimmer = new ToolOutputTrimmer();
    const result = trimmer.filter(makeArgs([]));
    expect(result.input).toEqual([]);
  });

  it('returns input unchanged when all items are recent', () => {
    const largeOutput = 'x'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('only question'),
      functionCall('c1', 'search'),
      functionCallResult('c1', largeOutput),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
    });
    const result = trimmer.filter(makeArgs(items));
    const resultItem = result.input[2] as Record<string, unknown>;
    expect(resultItem.output).toBe(largeOutput);
  });

  it('throws when recentTurns < 1', () => {
    expect(() => new ToolOutputTrimmer({ recentTurns: 0 })).toThrow(
      'recentTurns must be >= 1',
    );
  });

  it('throws when maxOutputChars < 1', () => {
    expect(() => new ToolOutputTrimmer({ maxOutputChars: 0 })).toThrow(
      'maxOutputChars must be >= 1',
    );
  });

  it('throws when previewChars < 0', () => {
    expect(() => new ToolOutputTrimmer({ previewChars: -1 })).toThrow(
      'previewChars must be >= 0',
    );
  });

  it('trims structured (non-string) tool outputs by serialized size', () => {
    const structuredOutput = Array.from({ length: 100 }, (_, i) => ({
      type: 'text' as const,
      text: `Result line ${i}: ${'data'.repeat(50)}`,
    }));
    const items: AgentInputItem[] = [
      userMessage('first question'),
      functionCall('c1', 'search'),
      {
        type: 'function_call_result',
        callId: 'c1',
        name: 'search',
        status: 'completed',
        output: structuredOutput,
      } as unknown as AgentInputItem,
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 500,
      previewChars: 100,
    });

    const result = trimmer.filter(makeArgs(items));
    const trimmedItem = result.input[2] as Record<string, unknown>;
    expect(typeof trimmedItem.output).toBe('string');
    expect(trimmedItem.output as string).toContain('[Trimmed:');
  });

  it('resolves tool_search call IDs from providerData', () => {
    const longDesc = 'd'.repeat(1000);
    const items: AgentInputItem[] = [
      userMessage('first question'),
      {
        type: 'tool_search_call',
        providerData: { call_id: 'ts1' },
      } as unknown as AgentInputItem,
      {
        type: 'tool_search_output',
        providerData: { call_id: 'ts1' },
        tools: [{ type: 'function', name: 'search', description: longDesc }],
      } as unknown as AgentInputItem,
      userMessage('second question'),
      userMessage('third question'),
    ];

    const trimmer = new ToolOutputTrimmer({
      recentTurns: 2,
      maxOutputChars: 100,
      previewChars: 50,
      trimmableTools: new Set(['tool_search']),
    });

    const result = trimmer.filter(makeArgs(items));
    const resultItem = result.input[2] as Record<string, unknown>;
    const resultTools = resultItem.tools as Record<string, unknown>[];
    expect((resultTools[0].description as string).length).toBeLessThan(
      longDesc.length,
    );
  });

  it('can be passed directly as a callModelInputFilter', () => {
    const trimmer = new ToolOutputTrimmer();
    const filterFn = trimmer.filter;
    const result = filterFn(makeArgs([userMessage('hello')]));
    expect(result.input).toHaveLength(1);
  });

  it('accepts trimmableTools as an array', () => {
    const trimmer = new ToolOutputTrimmer({
      trimmableTools: ['search', 'execute_code'],
    });
    expect(trimmer.trimmableTools).toBeInstanceOf(Set);
    expect(trimmer.trimmableTools!.has('search')).toBe(true);
    expect(trimmer.trimmableTools!.has('execute_code')).toBe(true);
  });

  it('preserves instructions from modelData', () => {
    const items: AgentInputItem[] = [userMessage('hello')];
    const trimmer = new ToolOutputTrimmer();
    const result = trimmer.filter({
      modelData: { input: items, instructions: 'Be helpful' },
      agent: {} as any,
      context: undefined,
    });
    expect(result.instructions).toBe('Be helpful');
  });
});
