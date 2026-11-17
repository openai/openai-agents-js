import {
  Agent,
  Runner,
  applyPatchTool,
  shellTool,
  tool,
  toolSearchTool,
  webSearchTool,
  type ModelRequest,
} from '@openai/agents';
import { beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { CodexProvider } from '../../../src/experimental/codex';

const boundary = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../src/experimental/codex/appServer', () => ({
  openCodexAppServer: boundary.open,
}));
type Event = { method: string; params: Record<string, unknown>; id?: number };
function server(events: Event[], overrides: Record<string, unknown> = {}) {
  const connection = {
    request: vi.fn(async (method: string) => {
      if (Object.prototype.hasOwnProperty.call(overrides, method)) {
        if (overrides[method] instanceof Error) throw overrides[method];
        return overrides[method];
      }
      if (method === 'thread/start')
        return {
          thread: { id: 'thread' },
          model: 'gpt-5.5',
          sandbox: { type: 'readOnly' },
        };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      if (method === 'config/read')
        return {
          config: {
            web_search: 'live',
            features: { standalone_web_search: false },
            tools: { web_search: { context_size: 'medium' } },
          },
        };
      if (method === 'modelProvider/capabilities/read')
        return { webSearch: true };
      if (method === 'configRequirements/read')
        return {
          requirements: { allowedWebSearchModes: ['cached', 'disabled'] },
        };
      return {};
    }),
    notify: vi.fn(),
    close: vi.fn(async () => {}),
    events: (async function* () {
      yield* events;
    })(),
  };
  boundary.open.mockResolvedValueOnce(connection);
  return connection;
}
function callback(name: string, args: unknown, namespace: string): Event[] {
  return [
    {
      id: 8,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace,
        tool: name,
        arguments: args,
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread',
        turn: { id: 'turn', status: 'interrupted' },
      },
    },
  ];
}
function final(): Event[] {
  return [
    {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'agentMessage', id: 'message', text: 'Done.' },
      },
    },
    {
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    },
  ];
}
function runner() {
  return new Runner({
    modelProvider: new CodexProvider(),
    tracingDisabled: true,
  });
}
function request(): ModelRequest {
  return {
    input: 'Hello.',
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: 'text',
    tracing: false,
  };
}
beforeEach(() => boundary.open.mockReset());

// Captured stock 0.166.0 discovery shape, including same-name namespaces for
// top-level deferred functions and client execution by Codex's search engine.
function discovery(): Event[] {
  return [
    {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'tool_search_call',
          id: 'search',
          call_id: 'search-call',
          execution: 'client',
          arguments: { query: 'lookup_weather' },
        },
      },
    },
    {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'tool_search_output',
          id: 'discovery',
          call_id: 'search-call',
          execution: 'client',
          status: 'completed',
          tools: [
            {
              type: 'namespace',
              name: 'lookup_weather',
              description: 'Weather.',
              tools: [
                {
                  type: 'function',
                  name: 'lookup_weather',
                  description: 'Weather.',
                  parameters: { type: 'object', properties: {} },
                  defer_loading: true,
                  strict: false,
                },
              ],
            },
            {
              type: 'namespace',
              name: 'native_mcp',
              description: 'Native Codex tools.',
              tools: [
                {
                  type: 'function',
                  name: 'unowned',
                  parameters: { type: 'object' },
                },
              ],
            },
          ],
        },
      },
    },
  ];
}

test('executes a discovered deferred SDK tool through the Runner', async () => {
  const execute = vi.fn(async () => 'Sunny.');
  const connection = server(
    [...discovery(), ...callback('lookup_weather', {}, 'lookup_weather')],
    {
      'config/read': {
        config: {
          features: {
            code_mode: {
              direct_only_tool_namespaces: [
                'keep_user_namespace',
                'lookup_weather',
              ],
            },
          },
        },
      },
    },
  );
  const agent = new Agent({
    name: 'Weather',
    tools: [
      tool({
        name: 'lookup_weather',
        description: 'Weather.',
        parameters: z.object({}),
        deferLoading: true,
        execute,
      }),
      toolSearchTool(),
    ],
    toolUseBehavior: 'stop_on_first_tool',
  });
  const result = await runner().run(agent, 'Check weather.');
  expect(result.finalOutput).toBe('Sunny.');
  expect(execute).toHaveBeenCalledOnce();
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      experimentalRawEvents: true,
      config: {
        'features.code_mode.direct_only_tool_namespaces': [
          'keep_user_namespace',
          'functions',
        ],
        'features.code_mode_tool_search': true,
      },
      dynamicTools: [
        {
          type: 'namespace',
          name: 'lookup_weather',
          description: 'Weather.',
          tools: [
            expect.objectContaining({
              name: 'lookup_weather',
              deferLoading: true,
            }),
          ],
        },
      ],
    }),
  );
  const output = result.rawResponses[0].output;
  expect(output).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_search_output',
        tools: [
          expect.objectContaining({
            name: 'lookup_weather',
            tools: [expect.objectContaining({ deferLoading: true })],
          }),
        ],
      }),
      expect.objectContaining({
        type: 'function_call',
        name: 'lookup_weather',
        providerData: {
          codexToolNamespace: 'lookup_weather',
          codexToolName: 'lookup_weather',
        },
      }),
    ]),
  );
  expect(
    output.some(
      (item) => item.type === 'function_call' && item.namespace !== undefined,
    ),
  ).toBe(false);
});

test('keeps local shell execution behind the SDK approval gate', async () => {
  const run = vi.fn(async () => ({ output: [] }));
  const connection = server(
    callback(
      'shell',
      {
        action: {
          commands: ['echo hello'],
          timeout_ms: 50,
          max_output_length: 100,
        },
      },
      'agents_sdk',
    ),
  );
  const agent = new Agent({
    name: 'Shell',
    tools: [
      shellTool({
        shell: { run },
        needsApproval: true,
        environment: {
          type: 'local',
          skills: [
            {
              name: 'audit',
              description: 'Inspect logs.',
              path: '/fixtures/audit',
            },
          ],
        },
      }),
    ],
  });
  const result = await runner().run(agent, 'Run echo.');
  expect(result.interruptions).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
  expect(result.rawResponses[0].output).toEqual([
    expect.objectContaining({
      type: 'shell_call',
      action: { commands: ['echo hello'], timeoutMs: 50, maxOutputLength: 100 },
      providerData: {
        codexToolNamespace: 'agents_sdk',
        codexToolName: 'shell',
      },
    }),
  ]);
  expect(connection.request).toHaveBeenCalledWith(
    'config/read',
    expect.any(Object),
  );
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      environments: [],
      config: {
        'features.code_mode.direct_only_tool_namespaces': ['agents_sdk'],
      },
      dynamicTools: [
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              description: expect.stringContaining('/fixtures/audit'),
            }),
          ],
        }),
      ],
    }),
  );
  expect(boundary.open.mock.calls[0][0].codexOptions.configOverrides).toContain(
    'features.apps=false',
  );
});

test('runs local patch operations through the configured SDK editor', async () => {
  const updateFile = vi.fn(async () => ({ output: 'Applied.' }));
  server(
    callback(
      'apply_patch',
      {
        operation: {
          type: 'update_file',
          path: 'old.txt',
          diff: '@@\n-old\n+new',
          move_to: 'new.txt',
        },
      },
      'agents_sdk',
    ),
  );
  server(final());
  const agent = new Agent({
    name: 'Editor',
    tools: [
      applyPatchTool({
        editor: { createFile: vi.fn(), updateFile, deleteFile: vi.fn() },
      }),
    ],
  });
  const result = await runner().run(agent, 'Update the file.');
  expect(result.finalOutput).toBe('Done.');
  expect(updateFile).toHaveBeenCalledWith(
    {
      type: 'update_file',
      path: 'old.txt',
      diff: '@@\n-old\n+new',
      moveTo: 'new.txt',
    },
    expect.any(Object),
  );
});

test.each([
  { toolChoice: 'none' },
  { toolChoice: 'required' },
  { toolChoice: 'lookup_weather' },
  { parallelToolCalls: false },
  { parallelToolCalls: true },
  { promptCacheOptions: { mode: 'explicit' as const, ttl: '30m' as const } },
  { reasoning: { mode: 'pro' } },
  { reasoning: { context: 'all_turns' as const } },
  { temperature: 0.1 },
  { topP: 0.5 },
  { maxTokens: 10 },
])(
  'rejects unsupported semantic controls before starting Codex: %j',
  async (settings) => {
    await expect(
      new CodexProvider()
        .getModel()
        .getResponse({ ...request(), modelSettings: settings }),
    ).rejects.toThrow('does not support modelSettings.');
    expect(boundary.open).not.toHaveBeenCalled();
  },
);

test('rejects hosted shell and customized client discovery before starting Codex', async () => {
  const model = new CodexProvider().getModel();
  await expect(
    model.getResponse({
      ...request(),
      tools: [shellTool({ environment: { type: 'container_auto' } })],
    }),
  ).rejects.toThrow('local SDK shell');
  await expect(
    model.getResponse({
      ...request(),
      tools: [toolSearchTool({ execution: 'client' })],
    }),
  ).rejects.toThrow('direct SDK function tools');
  expect(boundary.open).not.toHaveBeenCalled();
});

test('binds custom-named SDK shell execution and replay to the same engine', async () => {
  const run = vi.fn(async () => ({
    output: [
      {
        stdout: 'hello',
        stderr: '',
        outcome: { type: 'exit' as const, exitCode: 0 },
      },
    ],
  }));
  server(
    callback(
      'project_shell',
      { action: { commands: ['echo hello'] } },
      'agents_sdk',
    ),
  );
  const second = server(final());
  const agent = new Agent({
    name: 'Shell',
    tools: [shellTool({ name: 'project_shell', shell: { run } })],
  });
  const result = await runner().run(agent, 'Run echo.');
  expect(result.finalOutput).toBe('Done.');
  expect(run).toHaveBeenCalledWith({ commands: ['echo hello'] });
  expect(second.request).toHaveBeenCalledWith(
    'thread/inject_items',
    expect.objectContaining({
      items: expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          name: 'project_shell',
          namespace: 'agents_sdk',
        }),
      ]),
    }),
  );
});

test('rejects multiple local engines before any execution or approval', async () => {
  const model = new CodexProvider().getModel();
  const run = vi.fn();
  await expect(
    model.getResponse({
      ...request(),
      tools: [
        shellTool({ name: 'one', shell: { run } }),
        shellTool({ name: 'two', shell: { run } }),
      ],
    }),
  ).rejects.toThrow('supports one SDK shell tool');
  const editor = {
    createFile: vi.fn(),
    updateFile: vi.fn(),
    deleteFile: vi.fn(),
  };
  await expect(
    model.getResponse({
      ...request(),
      tools: [
        applyPatchTool({ name: 'one', editor }),
        applyPatchTool({ name: 'two', editor }),
      ],
    }),
  ).rejects.toThrow('supports one SDK apply_patch tool');
  expect(boundary.open).not.toHaveBeenCalled();
});

function webCall(): Event {
  return {
    method: 'rawResponseItem/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      item: {
        type: 'web_search_call',
        id: 'web',
        status: 'completed',
        action: { type: 'search', query: 'weather' },
        internal_chat_message_metadata_passthrough: {
          private: 'warehouse metadata',
        },
      },
    },
  };
}
test('forwards verified hosted web settings and returns real hosted call provenance', async () => {
  const connection = server([webCall(), ...final()], {
    'config/read': {
      config: {
        web_search: 'cached',
        features: { standalone_web_search: false },
        tools: {
          web_search: {
            context_size: 'high',
            allowed_domains: ['example.com'],
            location: { city: 'London' },
          },
        },
      },
    },
  });
  const agent = new Agent({
    name: 'Search',
    model: 'gpt-5.5',
    tools: [
      webSearchTool({
        externalWebAccess: false,
        searchContextSize: 'high',
        filters: { allowedDomains: ['example.com'] },
        userLocation: { type: 'approximate', city: 'London' },
        searchContentTypes: ['text', 'image'],
      }),
    ],
  });
  const result = await runner().run(agent, 'Find weather.');
  expect(result.finalOutput).toBe('Done.');
  expect(result.rawResponses[0].output).toContainEqual({
    type: 'hosted_tool_call',
    id: 'web',
    name: 'web_search_call',
    status: 'completed',
    providerData: {
      type: 'web_search_call',
      id: 'web',
      action: { type: 'search', query: 'weather' },
    },
  });
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ experimentalRawEvents: true }),
  );
  expect(boundary.open.mock.calls[0][0].codexOptions.configOverrides).toEqual(
    expect.arrayContaining([
      'features.standalone_web_search=false',
      'web_search="cached"',
      'tools.web_search.context_size="high"',
      'tools.web_search.allowed_domains=["example.com"]',
      'tools.web_search.location.city="London"',
    ]),
  );
});

test.each([
  { 'modelProvider/capabilities/read': { webSearch: false } },
  {
    'configRequirements/read': {
      requirements: { allowedWebSearchModes: ['disabled'] },
    },
  },
  {
    'configRequirements/read': {
      requirements: { allowedWebSearchModes: ['indexed', 'disabled'] },
    },
  },
  {
    'config/read': {
      config: {
        web_search: 'live',
        model_catalog_json: '/workspace/custom-models.json',
        features: { standalone_web_search: false },
      },
    },
  },
  {
    'config/read': {
      config: {
        web_search: 'disabled',
        features: { standalone_web_search: false },
      },
    },
  },
  {
    'config/read': {
      config: {
        web_search: 'cached',
        features: { standalone_web_search: true },
      },
    },
  },
])(
  'rejects hosted web when stock capability or managed policy removes it: %j',
  async (overrides) => {
    const connection = server(final(), overrides);
    await expect(
      new CodexProvider()
        .getModel('gpt-5.5')
        .getResponse({ ...request(), tools: [webSearchTool()] }),
    ).rejects.toThrow('could not enable hosted web search');
    expect(connection.request).not.toHaveBeenCalledWith(
      'turn/start',
      expect.anything(),
    );
    expect(connection.close).toHaveBeenCalledOnce();
  },
);

test('rejects a domain constraint that stock did not apply before searching', async () => {
  const connection = server(final());
  await expect(
    new CodexProvider().getModel('gpt-5.4').getResponse({
      ...request(),
      tools: [webSearchTool({ filters: { allowedDomains: ['example.com'] } })],
    }),
  ).rejects.toThrow('domains');
  expect(connection.request).not.toHaveBeenCalledWith(
    'turn/start',
    expect.anything(),
  );
});

test.each([
  { model: 'gpt-6.1-sol', sandbox: { type: 'readOnly' } },
  { model: 'gpt-5.5', sandbox: { type: 'dangerFullAccess' } },
])(
  'rejects hosted web model/mode combinations without equivalent stock semantics: %j',
  async (effective) => {
    const connection = server(final(), {
      'config/read': {
        config: {
          web_search: 'cached',
          features: { standalone_web_search: false },
          tools: { web_search: { context_size: 'medium' } },
        },
      },
      'thread/start': { thread: { id: 'thread' }, ...effective },
    });
    await expect(
      new CodexProvider().getModel(effective.model).getResponse({
        ...request(),
        tools: [webSearchTool({ externalWebAccess: false })],
      }),
    ).rejects.toThrow('verified stock model');
    expect(connection.request).not.toHaveBeenCalledWith(
      'turn/start',
      expect.anything(),
    );
  },
);

test('preserves requested encrypted reasoning without internal metadata or duplicate summary', async () => {
  const connection = server([
    {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'reasoning',
          id: 'reasoning',
          summary: [{ type: 'summary_text', text: 'A brief summary.' }],
          encrypted_content: 'opaque-real-provider-ciphertext',
          internal_chat_message_metadata_passthrough: {
            private: 'warehouse metadata',
          },
        },
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'reasoning',
          id: 'reasoning',
          summary: ['A brief summary.'],
        },
      },
    },
    ...final(),
  ]);
  const response = await new CodexProvider().getModel('gpt-5.5').getResponse({
    ...request(),
    modelSettings: {
      providerData: { include: ['reasoning.encrypted_content'] },
      reasoning: { summary: 'concise' },
    },
  });
  expect(response.output).toContainEqual({
    type: 'reasoning',
    id: 'reasoning',
    content: [{ type: 'input_text', text: 'A brief summary.' }],
    providerData: { encrypted_content: 'opaque-real-provider-ciphertext' },
  });
  expect(JSON.stringify(response.output)).not.toContain('warehouse metadata');
  expect(JSON.stringify(response.output)).not.toContain(
    'codexReasoningSummary',
  );
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ experimentalRawEvents: true }),
  );
});

function exitedDuringStartup() {
  return Object.assign(new Error('Codex App Server exited.'), {
    code: 'CODEX_APP_SERVER_EXITED',
  });
}

test('backs off a cold-start exit only after closing the failed initialization', async () => {
  const first = server([], { initialize: exitedDuringStartup() });
  const second = server(final());
  let finishClose!: () => void;
  first.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
  );
  const response = new CodexProvider().getModel().getResponse(request());
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
  expect(boundary.open).toHaveBeenCalledOnce();
  expect(first.request.mock.calls.map(([method]) => method)).toEqual([
    'initialize',
  ]);
  finishClose();
  expect((await response).output).toContainEqual(
    expect.objectContaining({ type: 'message' }),
  );
  expect(second.request.mock.calls.map(([method]) => method)).toEqual([
    'initialize',
    'thread/start',
    'turn/start',
  ]);
  expect(first.notify).not.toHaveBeenCalled();
});

test('bounds initialization retries and never retries protocol errors', async () => {
  const first = server([], { initialize: exitedDuringStartup() });
  const second = server([], { initialize: exitedDuringStartup() });
  const third = server([], { initialize: exitedDuringStartup() });
  const fourth = server([], { initialize: exitedDuringStartup() });
  await expect(
    new CodexProvider().getModel().getResponse(request()),
  ).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_EXITED' });
  expect(boundary.open).toHaveBeenCalledTimes(4);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(third.close).toHaveBeenCalledOnce();
  expect(fourth.close).toHaveBeenCalledOnce();
  boundary.open.mockReset();
  const protocolError = server([], {
    initialize: new Error('Codex App Server request failed.'),
  });
  await expect(
    new CodexProvider().getModel().getResponse(request()),
  ).rejects.toThrow('request failed');
  expect(boundary.open).toHaveBeenCalledOnce();
  expect(protocolError.close).toHaveBeenCalledOnce();
});

test('does not retry exits after initialization has completed', async () => {
  const connection = server([], { 'turn/start': exitedDuringStartup() });
  await expect(
    new CodexProvider().getModel().getResponse(request()),
  ).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_EXITED' });
  expect(boundary.open).toHaveBeenCalledOnce();
  expect(connection.close).toHaveBeenCalledOnce();
});

test('preserves cancellation between failed initialization and retry', async () => {
  const controller = new AbortController();
  const connection = server([], { initialize: exitedDuringStartup() });
  connection.close.mockImplementation(async () => {
    controller.abort();
  });
  await expect(
    new CodexProvider()
      .getModel()
      .getResponse({ ...request(), signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(boundary.open).toHaveBeenCalledOnce();
});

test('aborts during startup backoff without opening another process', async () => {
  const controller = new AbortController();
  const first = server([], { initialize: exitedDuringStartup() });
  const response = new CodexProvider()
    .getModel()
    .getResponse({ ...request(), signal: controller.signal });
  const rejected = expect(response).rejects.toMatchObject({
    name: 'AbortError',
  });
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(boundary.open).toHaveBeenCalledOnce();
});

test('keeps mixed deferred workspace namespaces deferred while preserving unrelated direct namespaces', async () => {
  const connection = server(final(), {
    'config/read': {
      config: {
        features: {
          code_mode: {
            direct_only_tool_namespaces: ['keep_user_namespace', 'agents_sdk'],
          },
        },
      },
    },
  });
  await new CodexProvider().getModel().getResponse({
    ...request(),
    tools: [
      shellTool({ shell: { run: vi.fn() } }),
      {
        type: 'function',
        name: 'inspect',
        description: 'Inspect workspace metadata.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: false,
        deferLoading: true,
        namespace: 'agents_sdk',
        namespaceDescription: 'SDK workspace tools.',
      },
    ],
  });
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      config: {
        'features.code_mode.direct_only_tool_namespaces': [
          'keep_user_namespace',
          'functions',
        ],
        'features.code_mode_tool_search': true,
      },
    }),
  );
});

test.each([undefined, 'functions'])(
  'rejects the reserved deferred discovery namespace before opening stock (%s)',
  async (namespace) => {
    const tools: ModelRequest['tools'] = [
      {
        type: 'function',
        name: namespace ? 'inspect' : 'functions',
        namespace,
        namespaceDescription: namespace ? 'Reserved namespace.' : undefined,
        deferLoading: true,
        description: 'Inspect metadata.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: false,
      },
    ];
    await expect(
      new CodexProvider().getModel().getResponse({ ...request(), tools }),
    ).rejects.toThrow('reserves the functions namespace');
    expect(boundary.open).not.toHaveBeenCalled();
  },
);

test.each(['gpt-5.4', 'gpt-5.4-mini'])(
  'supports the verified text-only hosted web fallback %s',
  async (model) => {
    server([webCall(), ...final()], {
      'thread/start': {
        thread: { id: 'thread' },
        model,
        sandbox: { type: 'readOnly' },
      },
    });
    const response = await new CodexProvider().getModel(model).getResponse({
      ...request(),
      tools: [webSearchTool({ searchContentTypes: ['text'] })],
    });
    expect(response.output).toContainEqual(
      expect.objectContaining({
        type: 'hosted_tool_call',
        name: 'web_search_call',
      }),
    );
  },
);

test('rejects hosted web content types that the effective stock model would change', async () => {
  const connection = server(final(), {
    'thread/start': {
      thread: { id: 'thread' },
      model: 'gpt-5.4',
      sandbox: { type: 'readOnly' },
    },
  });
  await expect(
    new CodexProvider().getModel('gpt-5.4').getResponse({
      ...request(),
      tools: [webSearchTool({ searchContentTypes: ['text', 'image'] })],
    }),
  ).rejects.toThrow('cannot preserve');
  expect(connection.request).not.toHaveBeenCalledWith(
    'turn/start',
    expect.anything(),
  );
});

test('streams public reasoning summary parts and preserves their item identity', async () => {
  const params = {
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'rs_summary',
    summaryIndex: 0,
  };
  server([
    { method: 'item/reasoning/summaryPartAdded', params },
    {
      method: 'item/reasoning/textDelta',
      params: { ...params, delta: 'private' },
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { ...params, delta: 'Public summary.' },
    },
    {
      method: 'item/completed',
      params: {
        ...params,
        item: {
          id: 'rs_summary',
          type: 'reasoning',
          summary: ['Public summary.'],
        },
      },
    },
    ...final(),
  ]);
  const stream = new CodexProvider().getModel('gpt-5.4').getStreamedResponse({
    ...request(),
    modelSettings: { reasoning: { summary: 'auto' } },
  });
  const events = [];
  for await (const event of stream) events.push(event);
  const raw = events.flatMap((event) =>
    event.type === 'model' ? [event.event] : [],
  );
  expect(raw).toEqual([
    expect.objectContaining({
      type: 'response.reasoning_summary_part.added',
      item_id: 'rs_summary',
      summary_index: 0,
    }),
    expect.objectContaining({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_summary',
      delta: 'Public summary.',
    }),
  ]);
});
