import { describe, expect, it } from 'vitest';
import {
  EXTENSION,
  VERSION,
  admitSelectedTool,
  encodeMcpName,
  makeRequest,
  parseResult,
  validateDiscovery,
  type TaskCreated,
  type ToolDeclaration,
} from '../../src/experimental/mcp-tasks/protocol';

const task = {
  resultType: 'task',
  taskId: 'private-task/雪',
  status: 'working',
  createdAt: '2026-11-01T00:00:00Z',
  lastUpdatedAt: '2026-11-01T00:00:00Z',
  ttlMs: null,
};
const discovery = {
  resultType: 'complete',
  supportedVersions: [VERSION],
  capabilities: { tools: {}, extensions: { [EXTENSION]: {} } },
};
const tool: ToolDeclaration = {
  name: 'render',
  inputSchema: { type: 'object' },
};

function listing(declaration = tool) {
  return {
    resultType: 'complete',
    ttlMs: 0,
    cacheScope: 'private',
    tools: [declaration],
  };
}

describe('MCP Tasks protocol', () => {
  it('stamps the modern envelope for only the six fixed methods', () => {
    for (const method of [
      'server/discover',
      'tools/list',
      'tools/call',
      'tasks/get',
      'tasks/update',
      'tasks/cancel',
    ] as const) {
      expect(
        makeRequest('id-1', method, {
          taskId: task.taskId,
          _meta: { untrusted: true },
        }),
      ).toEqual({
        jsonrpc: '2.0',
        id: 'id-1',
        method,
        params: {
          taskId: task.taskId,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'openai-agents-mcp-tasks',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { 'io.modelcontextprotocol/tasks': {} },
            },
          },
        },
      });
    }
  });

  it('requires modern discovery, tools and the exact empty Tasks extension', () => {
    expect(validateDiscovery(discovery)).toBe(discovery);
    for (const invalid of [
      { ...discovery, resultType: undefined },
      { ...discovery, supportedVersions: ['2025-11-25'] },
      { ...discovery, capabilities: { extensions: { [EXTENSION]: {} } } },
      {
        ...discovery,
        capabilities: {
          tools: {},
          extensions: { [EXTENSION]: { enabled: true } },
        },
      },
    ])
      expect(() => validateDiscovery(invalid)).toThrow(
        'selected Tasks profile',
      );
  });

  it('uses raw task discrimination before complete tool result validation', () => {
    const result = parseResult('tools/call', task) as TaskCreated;
    expect(result).toEqual({ ...task, pollIntervalMs: 0 });
    expect(() =>
      parseResult('tools/call', { ...task, ttlMs: false, content: [] }),
    ).toThrow();
    expect(() =>
      parseResult('tools/call', { resultType: 'input_required', content: [] }),
    ).toThrow();
    expect(() => parseResult('tools/call', { content: [] })).toThrow();
    expect(
      parseResult('tools/call', {
        resultType: 'complete',
        content: [],
        ttlMs: -0.5,
      }),
    ).toEqual({
      resultType: 'complete',
      content: [],
      ttlMs: -0.5,
    });
    expect(() =>
      parseResult('tools/call', { resultType: 'complete' }),
    ).toThrow();
  });

  it.each([null, -Number.MAX_SAFE_INTEGER, 0, 2.0, Number.MAX_SAFE_INTEGER])(
    'accepts nullable and safe integral task TTL %s',
    (ttlMs) => {
      expect(parseResult('tools/call', { ...task, ttlMs }).ttlMs).toBe(ttlMs);
    },
  );

  it.each([undefined, false, '60000', -0.5, 1.5, 2 ** 53])(
    'refuses malformed task TTL %s without falling through to complete',
    (ttlMs) => {
      expect(() =>
        parseResult('tools/call', { ...task, ttlMs, content: [] }),
      ).toThrow();
    },
  );

  it.each([null, false, '0', -1, 0.5, 2 ** 53])(
    'refuses malformed poll interval %s',
    (pollIntervalMs) => {
      expect(() =>
        parseResult('tools/call', { ...task, pollIntervalMs }),
      ).toThrow();
      expect(() =>
        parseResult('tasks/get', {
          ...task,
          resultType: 'complete',
          pollIntervalMs,
        }),
      ).toThrow();
    },
  );

  it('validates embedded complete results and preserves raw form constraints', () => {
    const request = {
      method: 'elicitation/create',
      params: {
        message: 'private prompt',
        requestedSchema: {
          type: 'object',
          properties: { color: { type: 'string', pattern: 'private-regex' } },
        },
      },
    };
    const detail = parseResult('tasks/get', {
      ...task,
      resultType: 'complete',
      status: 'input_required',
      inputRequests: { selected: request },
    });
    expect(detail.inputRequests?.selected).toBe(request);
    expect(() =>
      parseResult('tasks/get', {
        ...task,
        resultType: 'complete',
        result: { resultType: 'input_required', content: [] },
      }),
    ).toThrow();
    expect(() =>
      parseResult('tasks/get', { ...task, resultType: 'task' }),
    ).toThrow();
  });

  it('validates modern URL, roots and sampling requests without legacy fields', () => {
    const inputRequests = {
      url: {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Visit the private target',
          url: 'https://example.test/input',
        },
      },
      roots: { method: 'roots/list' },
      sampling: {
        method: 'sampling/createMessage',
        params: {
          messages: [
            {
              role: 'user',
              content: {
                type: 'tool_result',
                toolUseId: 'call',
                content: [],
                structuredContent: ['modern', 'array'],
              },
            },
          ],
          maxTokens: 10,
        },
      },
    };
    expect(
      parseResult('tasks/get', {
        ...task,
        resultType: 'complete',
        inputRequests,
      }).inputRequests,
    ).toBe(inputRequests);
    for (const request of [
      {
        method: 'elicitation/create',
        params: { mode: 'url', message: 'private', url: false },
      },
      { method: 'sampling/createMessage', params: {} },
      { method: 'roots/list', params: [] },
    ])
      expect(() =>
        parseResult('tasks/get', {
          ...task,
          resultType: 'complete',
          inputRequests: { key: request },
        }),
      ).toThrow();
  });

  it('requires complete acknowledgments and never treats them as task detail', () => {
    expect(parseResult('tasks/cancel', { resultType: 'complete' })).toEqual({
      resultType: 'complete',
    });
    expect(() => parseResult('tasks/update', { resultType: 'task' })).toThrow();
    expect(() =>
      parseResult('tasks/get', { resultType: 'complete' }),
    ).toThrow();
  });

  it('validates a raw finite listing without filtering declarations', () => {
    const duplicate = { ...listing(), nextCursor: 'next', tools: [tool, tool] };
    expect(parseResult('tools/list', duplicate)).toBe(duplicate);
    expect(() =>
      parseResult('tools/list', { ...listing(), tools: [{ name: 'render' }] }),
    ).toThrow();
    expect(() =>
      parseResult('tools/list', { ...listing(), ttlMs: -1 }),
    ).toThrow();
  });

  it('uses modern declaration shapes rather than legacy execution annotations', () => {
    const modern = {
      ...tool,
      execution: { taskSupport: 'obsolete-value' },
      inputSchema: { type: 'object', properties: false },
    };
    const raw = listing(modern);
    expect(parseResult('tools/list', raw)).toBe(raw);
  });

  it.each([
    ['plain/name', 'plain/name'],
    ['private-task/雪', '=?base64?cHJpdmF0ZS10YXNrL+mbqg==?='],
    [' leading', '=?base64?IGxlYWRpbmc=?='],
    ['=?base64?eA==?=', '=?base64?PT9iYXNlNjQ/ZUE9PT89?='],
    ['line\nbreak', '=?base64?bGluZQpicmVhaw==?='],
    ['', '=?base64??='],
    ['inner\ttab', 'inner\ttab'],
  ])('encodes unambiguous MCP name %j', (input, expected) => {
    expect(encodeMcpName(input)).toBe(expected);
  });

  it('does not execute peer output constraints and rejects references', () => {
    expect(() =>
      admitSelectedTool({ ...tool, outputSchema: { pattern: '(a+)+$' } }, {}),
    ).not.toThrow();
    for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
      expect(() =>
        admitSelectedTool(
          {
            ...tool,
            outputSchema: {
              properties: { field: { [key]: 'https://private.invalid' } },
            },
          },
          {},
        ),
      ).toThrow();
    }
  });

  it('refuses header-bearing values but permits valid absent/null declarations', () => {
    const selected = {
      ...tool,
      inputSchema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: { value: { type: 'string', 'x-mcp-header': 'Route' } },
          },
        },
      },
    };
    expect(() => admitSelectedTool(selected, {})).not.toThrow();
    expect(() =>
      admitSelectedTool(selected, { nested: { value: null } }),
    ).not.toThrow();
    for (const value of ['route', '', false, 0]) {
      expect(() =>
        admitSelectedTool(selected, { nested: { value } }),
      ).toThrow();
    }
  });

  it('refuses invalid header declarations even when the argument is absent', () => {
    for (const inputSchema of [
      {
        type: 'object',
        properties: { value: { type: 'string', 'x-mcp-header': 'bad header' } },
      },
      {
        type: 'object',
        properties: {
          a: { type: 'string', 'x-mcp-header': 'Route' },
          b: { type: 'string', 'x-mcp-header': 'route' },
        },
      },
      {
        type: 'object',
        properties: { value: { type: 'object', 'x-mcp-header': 'Route' } },
      },
      {
        type: 'object',
        oneOf: [
          {
            properties: { value: { type: 'string', 'x-mcp-header': 'Route' } },
          },
        ],
      },
      {
        type: 'object',
        properties: {
          list: {
            type: 'array',
            items: { type: 'string', 'x-mcp-header': 'Route' },
          },
        },
      },
    ])
      expect(() => admitSelectedTool({ ...tool, inputSchema }, {})).toThrow();
  });

  it('does not retain private peer data in protocol errors', () => {
    try {
      parseResult('tools/call', {
        resultType: 'private-frame-canary',
        content: [],
      });
      expect.fail('must reject');
    } catch (error) {
      expect(String(error)).not.toContain('private-frame-canary');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
