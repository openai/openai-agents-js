import {
  Agent,
  Runner,
  RunState,
  OpenAIResponsesCompactionSession,
  UserError,
  handoff,
  shellTool,
  tool,
  webSearchTool,
  type HandoffInputData,
  type ModelRequest,
} from '@openai/agents';
import { removeAllTools } from '@openai/agents-core/extensions';
import { CodexProvider } from '../../../src/experimental/codex';
import { beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

const boundary = vi.hoisted(() => ({ open: vi.fn() }));

// Runner and the provider stay real; only the stock CLI process is replaced.
vi.mock('../../../src/experimental/codex/appServer', () => ({
  openCodexAppServer: boundary.open,
}));

type Event = { method: string; params: Record<string, unknown>; id?: number };
const localImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6uGQAAAAASUVORK5CYII=';
const tokenUsage = {
  total: {
    inputTokens: 17,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 12,
    reasoningOutputTokens: 4,
    totalTokens: 29,
  },
  modelContextWindow: 1024,
};
const usageUpdated: Event = {
  method: 'thread/tokenUsage/updated',
  params: { threadId: 'thread', turnId: 'turn', tokenUsage },
};

function agentMessage(
  text: string,
  phase: 'commentary' | 'final_answer',
): Event {
  return {
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      item: { type: 'agentMessage', id: 'message', text, phase },
    },
  };
}

function completed(text: string): Event[] {
  return [
    agentMessage(text, 'final_answer'),
    {
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    },
  ];
}

function callback(toolName: string, namespace: string | null = null): Event[] {
  return [
    {
      id: 7,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'sdk-call',
        namespace,
        tool: toolName,
        arguments: {},
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

function server(events: Event[] | AsyncIterable<Event>) {
  const connection = {
    request: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      if (method === 'config/read') return { config: {} };
      return {};
    }),
    notify: vi.fn(),
    close: vi.fn(async () => {}),
    events: Array.isArray(events)
      ? (async function* () {
          yield* events;
        })()
      : events,
  };
  boundary.open.mockResolvedValueOnce(connection);
  return connection;
}

function runner() {
  return new Runner({
    modelProvider: new CodexProvider(),
    tracingDisabled: true,
  });
}

beforeEach(() => {
  boundary.open.mockReset();
});

test('authenticates an explicit API key before opening a thread', async () => {
  const connection = server(completed('Authenticated.'));
  const sdk = new Runner({
    modelProvider: new CodexProvider({
      codexOptions: { apiKey: 'fixture-key' },
    }),
    tracingDisabled: true,
  });
  expect(
    (await sdk.run(new Agent({ name: 'test' }), 'Hello.')).finalOutput,
  ).toBe('Authenticated.');
  expect(
    connection.request.mock.calls.slice(0, 3).map(([method]) => method),
  ).toEqual(['initialize', 'account/login/start', 'thread/start']);
  expect(connection.request).toHaveBeenCalledWith('account/login/start', {
    type: 'apiKey',
    apiKey: 'fixture-key',
  });
});

function sandboxRequest(): ModelRequest & {
  _internal: { sdkSandbox: boolean };
} {
  return {
    input: 'Inspect the SDK sandbox.',
    modelSettings: {},
    tools: [
      {
        type: 'function',
        name: 'exec_command',
        description: 'Execute in the SDK sandbox.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
        namespace: 'agents_sdk',
        namespaceDescription: 'SDK sandbox tools.',
      },
    ],
    handoffs: [],
    outputType: 'text',
    tracing: false,
    _internal: { sdkSandbox: true },
  };
}

test('confines Codex native tools while preserving SDK sandbox callbacks', async () => {
  const connection = server(callback('exec_command', 'agents_sdk'));
  const model = new CodexProvider({
    codexOptions: {
      configOverrides: [
        'features.apps=true',
        'features.hooks=true',
        'notify=["ambient-command"]',
      ],
    },
    threadOptions: { webSearchMode: 'live' },
  }).getModel();
  const response = await model.getResponse(sandboxRequest());

  expect(response.output).toEqual([
    expect.objectContaining({
      type: 'function_call',
      name: 'exec_command',
      namespace: 'agents_sdk',
    }),
  ]);
  expect(connection.request).toHaveBeenCalledWith('config/read', {
    cwd: expect.any(String),
    includeLayers: false,
  });
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      environments: [],
      dynamicTools: [
        expect.objectContaining({
          type: 'namespace',
          name: 'agents_sdk',
          tools: [expect.objectContaining({ name: 'exec_command' })],
        }),
      ],
    }),
  );
  expect(connection.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ environments: [] }),
  );
  expect(boundary.open.mock.calls[0][0].codexOptions.configOverrides).toEqual([
    'features.apps=true',
    'features.hooks=true',
    'notify=["ambient-command"]',
    'web_search="live"',
    'features.apps=false',
    'features.shell_tool=false',
    'features.view_image=false',
    'features.plugins=false',
    'features.multi_agent=false',
    'features.multi_agent_v2=false',
    'features.hooks=false',
    'features.code_mode=false',
    'notify=[]',
    'web_search="disabled"',
  ]);
  expect(connection.close).toHaveBeenCalledOnce();
});

test.each([{}, { enabled: true }])(
  'rejects enabled ambient Codex MCP servers before starting a sandbox thread (%j)',
  async (entry) => {
    const connection = server(completed('unreachable'));
    connection.request.mockImplementation(async (method) =>
      method === 'config/read'
        ? { config: { mcp_servers: { ambient: entry } } }
        : {},
    );
    await expect(
      new CodexProvider().getModel().getResponse(sandboxRequest()),
    ).rejects.toThrow('requires Codex MCP servers to be disabled');
    expect(connection.request).not.toHaveBeenCalledWith(
      'thread/start',
      expect.anything(),
    );
    expect(connection.close).toHaveBeenCalledOnce();
  },
);

test('accepts explicitly disabled Codex MCP servers in SDK sandbox mode', async () => {
  const connection = server(completed('confined'));
  const original = connection.request.getMockImplementation()!;
  connection.request.mockImplementation(async (method, params) =>
    method === 'config/read'
      ? { config: { mcp_servers: { ambient: { enabled: false } } } }
      : original(method, params),
  );
  const response = await new CodexProvider()
    .getModel()
    .getResponse(sandboxRequest());
  expect(response.output).toEqual([
    expect.objectContaining({ type: 'message' }),
  ]);
});

test('parses structured output and forwards separate consecutive text and local-image user messages', async () => {
  const connection = server(completed('{"label":"diagram"}'));
  const image = localImage;
  const agent = new Agent({
    name: 'assistant',
    instructions: 'Describe the image.',
    outputType: z.object({ label: z.string() }),
  });

  const result = await runner().run(agent, [
    { role: 'user', content: 'Describe this image.' },
    { role: 'user', content: [{ type: 'input_image', image }] },
  ]);

  expect(result.finalOutput).toEqual({ label: 'diagram' });
  expect(connection.request).toHaveBeenCalledWith(
    'initialize',
    expect.objectContaining({
      capabilities: expect.objectContaining({ experimentalApi: true }),
    }),
  );
  expect(connection.notify).toHaveBeenCalledWith('initialized');
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ ephemeral: true }),
  );
  expect(connection.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({
      input: [
        expect.objectContaining({ type: 'text', text: 'Describe this image.' }),
        { type: 'image', url: image },
      ],
      outputSchema: expect.objectContaining({
        type: 'object',
        properties: { label: { type: 'string' } },
      }),
    }),
  );
  expect(connection.close).toHaveBeenCalledOnce();
});

test('honors explicit model controls and preserves reported summaries and raw usage', async () => {
  const connection = server([
    {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'reasoning',
          id: 'reasoning',
          summary: ['Identified the diagram.'],
          content: ['Reasoning content outside the requested summary.'],
        },
      },
    },
    agentMessage('I will identify the diagram.', 'commentary'),
    usageUpdated,
    ...completed('{"label":"diagram"}'),
  ]);
  const sdkRunner = new Runner({
    modelProvider: new CodexProvider({
      codexOptions: { config: { model_verbosity: 'high' } },
      threadOptions: { modelReasoningEffort: 'high' },
    }),
    modelSettings: {
      text: { verbosity: 'low' },
      retry: { maxRetries: 1 },
    },
    tracingDisabled: true,
  });
  const agent = new Agent({
    name: 'assistant',
    modelSettings: {
      reasoning: { effort: 'medium', summary: 'concise' },
      toolChoice: 'auto',
      store: false,
      preserveRawUsage: true,
    },
    outputType: z.object({ label: z.string() }),
  });
  const result = await sdkRunner.run(agent, 'Describe the diagram.');

  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ config: { model_verbosity: 'low' } }),
  );
  expect(connection.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ effort: 'medium', summary: 'concise' }),
  );
  expect(result.finalOutput).toEqual({ label: 'diagram' });
  expect(result.newItems).toContainEqual(
    expect.objectContaining({
      type: 'reasoning_item',
      rawItem: expect.objectContaining({
        content: [{ type: 'input_text', text: 'Identified the diagram.' }],
      }),
    }),
  );
  expect(result.rawResponses[0]?.output.at(-1)?.providerData).toEqual({
    codexReasoningSummary: ['Identified the diagram.'],
  });
  expect(result.rawResponses[0]?.rawUsage).toEqual(tokenUsage);
});

test.each([undefined, 'low'] as const)(
  'keeps Codex settings except for an explicit Runner verbosity of %s',
  async (verbosity) => {
    const connection = server([usageUpdated, ...completed('Hello.')]);
    const sdkRunner = new Runner({
      modelProvider: new CodexProvider({
        codexOptions: { config: { model_verbosity: 'high' } },
        threadOptions: { modelReasoningEffort: 'high' },
      }),
      modelSettings: verbosity ? { text: { verbosity } } : undefined,
      tracingDisabled: true,
    });
    const result = await sdkRunner.run(
      new Agent({ name: 'assistant' }),
      'Hello.',
    );

    const thread = connection.request.mock.calls.find(
      ([method]) => method === 'thread/start',
    );
    if (verbosity) {
      expect(thread?.[1]).toMatchObject({
        config: { model_verbosity: verbosity },
      });
    } else {
      expect(thread?.[1]).not.toHaveProperty('config');
    }
    expect(connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ effort: 'high' }),
    );
    expect(result.rawResponses[0]).not.toHaveProperty('rawUsage');
  },
);

test('delivers text deltas before completion without repeating final text and records usage', async () => {
  let release!: () => void;
  let finished = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = server(
    (async function* () {
      yield {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'message',
          delta: 'Hello ',
        },
      };
      await gate;
      yield {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'message',
          delta: 'world.',
        },
      };
      yield usageUpdated;
      finished = true;
      yield* completed('Hello world.');
    })(),
  );
  const result = await runner().run(
    new Agent({ name: 'assistant', modelSettings: { preserveRawUsage: true } }),
    'Hello.',
    { stream: true },
  );
  const deltas: string[] = [];
  const lifecycle: string[] = [];
  for await (const event of result) {
    if (event.type === 'raw_model_stream_event')
      lifecycle.push(event.data.type);
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      deltas.push(event.data.delta);
      if (deltas.length === 1) {
        expect(finished).toBe(false);
        release();
      }
    }
  }
  expect(deltas).toEqual(['Hello ', 'world.']);
  expect(lifecycle).toEqual([
    'response_started',
    'output_text_delta',
    'output_text_delta',
    'response_done',
  ]);
  expect(result.finalOutput).toBe('Hello world.');
  expect(result.rawResponses[0]?.rawUsage).toEqual(tokenUsage);
  expect(result.state.usage).toMatchObject({
    inputTokens: 17,
    outputTokens: 12,
    totalTokens: 29,
    inputTokensDetails: [{ cached_tokens: 3, cache_write_tokens: 2 }],
    outputTokensDetails: [{ reasoning_tokens: 4 }],
  });
  expect(connection.close).toHaveBeenCalledOnce();
});

test('lets Runner execute a function tool and replays its exact call ID into a fresh thread', async () => {
  const first = server([
    agentMessage('I will look up the account.', 'commentary'),
    ...callback('lookup'),
  ]);
  const second = server(completed('Account found.'));
  const execute = vi.fn(async () => 'account-42');
  const lookup = tool({
    name: 'lookup',
    description: 'Find an account.',
    parameters: z.object({}),
    execute,
  });
  const agent = new Agent({ name: 'assistant', tools: [lookup] });

  const result = await runner().run(agent, [
    { role: 'user', content: 'Find my account.' },
    { role: 'user', content: [{ type: 'input_image', image: localImage }] },
  ]);

  expect(result.finalOutput).toBe('Account found.');
  expect(result.newItems.map((item) => item.rawItem)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', phase: 'commentary' }),
      expect.objectContaining({ role: 'assistant', phase: 'final_answer' }),
    ]),
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(first.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      dynamicTools: [
        expect.objectContaining({
          type: 'function',
          name: 'lookup',
          inputSchema: expect.objectContaining({ type: 'object' }),
        }),
      ],
    }),
  );
  expect(first.request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: 'thread',
    turnId: 'turn',
  });
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.request).toHaveBeenCalledWith(
    'thread/inject_items',
    expect.objectContaining({
      items: expect.arrayContaining([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: localImage }],
        },
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [
            { type: 'output_text', text: 'I will look up the account.' },
          ],
        }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'sdk-call',
          name: 'lookup',
          arguments: '{}',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'sdk-call',
          output: [{ type: 'input_text', text: 'account-42' }],
        }),
      ]),
    }),
  );
  expect(second.close).toHaveBeenCalledOnce();
  expect(boundary.open).toHaveBeenCalledTimes(2);
});

test('streams the recognized function identity and exact arguments once per client callback', async () => {
  server(callback('lookup'));
  server(completed('Account found.'));
  const lookup = tool({
    name: 'lookup',
    description: 'Find the account.',
    parameters: z.object({}),
    execute: () => 'account',
  });
  const result = await runner().run(
    new Agent({ name: 'assistant', tools: [lookup] }),
    'Find my account.',
    { stream: true },
  );
  const inputs = [];
  for await (const item of result) {
    if (item.type === 'raw_model_stream_event' && item.data.type === 'model')
      inputs.push(item.data.toolInput);
  }
  expect(inputs).toEqual([
    { type: 'start', name: 'lookup', callId: 'sdk-call' },
    { type: 'delta', delta: '{}', callId: 'sdk-call' },
  ]);
  expect(result.finalOutput).toBe('Account found.');
});

test('returns non-strict structured output with optional and open fields', async () => {
  const connection = server(completed('{"name":"Ada","score":42}'));
  const agent = new Agent({
    name: 'assistant',
    instructions: 'Return the submitted record.',
    outputType: {
      type: 'json_schema',
      name: 'record',
      strict: false,
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: [],
        additionalProperties: true,
      },
    },
  });
  const result = await runner().run(agent, 'Use name Ada and score 42.');
  expect(result.finalOutput).toEqual({ name: 'Ada', score: 42 });
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      developerInstructions: expect.stringContaining(
        '"additionalProperties":true',
      ),
    }),
  );
  expect(connection.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({
      outputSchema: undefined,
    }),
  );
});

test.each(['base64', 'bytes'])(
  'replays inline %s images from SDK tool history',
  async (encoding) => {
    const connection = server(completed('Image received.'));
    const base64 = localImage.split(',')[1];
    const result = await runner().run(new Agent({ name: 'assistant' }), [
      {
        type: 'function_call',
        name: 'lookup_image',
        callId: 'image-call',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_result',
        name: 'lookup_image',
        callId: 'image-call',
        status: 'completed',
        output: {
          type: 'image',
          image: {
            data: encoding === 'bytes' ? Buffer.from(base64, 'base64') : base64,
            mediaType: 'image/png',
          },
        },
      },
      { role: 'user', content: 'Describe the image from the tool.' },
    ]);

    expect(result.finalOutput).toBe('Image received.');
    expect(connection.request).toHaveBeenCalledWith(
      'thread/inject_items',
      expect.objectContaining({
        items: expect.arrayContaining([
          {
            type: 'function_call_output',
            call_id: 'image-call',
            output: [{ type: 'input_image', image_url: localImage }],
          },
        ]),
      }),
    );
  },
);

test('closes the transport while SDK approval is pending and resumes serialized RunState', async () => {
  const first = server(callback('approve_lookup'));
  const execute = vi.fn(async () => 'approved account');
  const lookup = tool({
    name: 'approve_lookup',
    description: 'Find an account after approval.',
    parameters: z.object({}),
    needsApproval: true,
    execute,
  });
  const agent = new Agent({ name: 'assistant', tools: [lookup] });
  const sdkRunner = runner();

  const pending = await sdkRunner.run(agent, 'Find my account.');
  expect(pending.interruptions).toHaveLength(1);
  expect(execute).not.toHaveBeenCalled();
  expect(first.close).toHaveBeenCalledOnce();
  const restored = await RunState.fromString(agent, pending.state.toString());
  restored.approve(restored.getInterruptions()[0]!);
  const second = server(completed('Approved.'));
  const result = await sdkRunner.run(agent, restored);

  expect(result.finalOutput).toBe('Approved.');
  expect(execute).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(boundary.open).toHaveBeenCalledTimes(2);
});

test('lets Runner apply handoff filters and target instructions', async () => {
  const first = server([
    agentMessage('I will transfer this request.', 'commentary'),
    ...callback('transfer_to_specialist'),
  ]);
  const second = server(completed('Specialist answer.'));
  const specialist = new Agent({
    name: 'specialist',
    instructions: 'Answer as the specialist.',
  });
  const filter = vi.fn((data: HandoffInputData) =>
    removeAllTools({ ...data, inputHistory: 'Filtered task.' }),
  );
  const agent = new Agent({
    name: 'assistant',
    instructions: 'Route the request.',
    handoffs: [handoff(specialist, { inputFilter: filter })],
  });

  const result = await runner().run(agent, 'Private original task.');

  expect(result.finalOutput).toBe('Specialist answer.');
  expect(result.lastAgent).toBe(specialist);
  expect(filter).toHaveBeenCalledOnce();
  expect(second.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      developerInstructions: 'Answer as the specialist.',
    }),
  );
  const replay = second.request.mock.calls.find(
    ([method]) => method === 'thread/inject_items',
  );
  expect(JSON.stringify(replay)).toContain('Filtered task.');
  expect(JSON.stringify(replay)).not.toContain('Private original task.');
  expect(JSON.stringify(replay)).not.toContain('transfer_to_specialist');
  expect(second.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ input: [] }),
  );
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
});

test('rejects Responses IDs and unsupported hosted tool settings before opening the CLI', async () => {
  const sdkRunner = runner();
  await expect(
    sdkRunner.run(new Agent({ name: 'assistant' }), 'Continue.', {
      previousResponseId: 'resp_123',
    }),
  ).rejects.toThrow(UserError);
  await expect(
    sdkRunner.run(
      new Agent({
        name: 'assistant',
        tools: [webSearchTool({ imageSettings: { caption: true } })],
      }),
      'Search.',
    ),
  ).rejects.toThrow(UserError);
  expect(boundary.open).not.toHaveBeenCalled();
});

test('requires an SDK function call and lets Runner finish after executing it', async () => {
  const first = server(callback('lookup'));
  server(completed('Account found.'));
  const execute = vi.fn(async () => 'account');
  const agent = new Agent({
    name: 'assistant',
    modelSettings: { toolChoice: 'required' },
    tools: [
      tool({
        name: 'lookup',
        description: 'Find an account.',
        parameters: z.object({}),
        execute,
      }),
    ],
  });
  const result = await runner().run(agent, 'Find my account.');
  expect(result.finalOutput).toBe('Account found.');
  expect(execute).toHaveBeenCalledOnce();
  expect(first.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      developerInstructions: expect.stringContaining(
        'Call at least one exposed SDK tool or handoff',
      ),
    }),
  );
  expect(boundary.open).toHaveBeenCalledTimes(2);
});

test('suppresses only native workspace tools on required turns and preserves caller settings on auto continuation', async () => {
  const first = server(callback('lookup'));
  const second = server(completed('Account found.'));
  const configOverrides = [
    'features.shell_tool=true',
    'features.view_image=true',
    'features.apps=true',
  ];
  const sdkRunner = new Runner({
    modelProvider: new CodexProvider({ codexOptions: { configOverrides } }),
    tracingDisabled: true,
  });
  const result = await sdkRunner.run(
    new Agent({
      name: 'assistant',
      modelSettings: { toolChoice: 'required' },
      tools: [
        tool({
          name: 'lookup',
          description: 'Find an account.',
          parameters: z.object({}),
          execute: async () => 'account',
        }),
      ],
    }),
    'Find my account.',
  );
  expect(result.finalOutput).toBe('Account found.');
  expect(boundary.open.mock.calls[0][0].codexOptions.configOverrides).toEqual([
    ...configOverrides,
    'features.shell_tool=false',
    'features.view_image=false',
  ]);
  expect(boundary.open.mock.calls[1][0].codexOptions.configOverrides).toEqual(
    configOverrides,
  );
  expect(configOverrides).toEqual([
    'features.shell_tool=true',
    'features.view_image=true',
    'features.apps=true',
  ]);
  expect(first.request).not.toHaveBeenCalledWith(
    'config/read',
    expect.anything(),
  );
  expect(first.request).toHaveBeenCalledWith(
    'thread/start',
    expect.not.objectContaining({ environments: [] }),
  );
  expect(first.request).toHaveBeenCalledWith(
    'thread/start',
    expect.not.objectContaining({
      developerInstructions: expect.stringContaining('agents_sdk'),
    }),
  );
  expect(second.request).toHaveBeenCalledWith(
    'thread/start',
    expect.not.objectContaining({ environments: [] }),
  );
  expect(second.request).toHaveBeenCalledWith(
    'thread/start',
    expect.not.objectContaining({
      developerInstructions: expect.stringContaining('agents_sdk'),
    }),
  );
});

test('accepts a handoff as the required SDK tool call', async () => {
  server(callback('transfer_to_specialist'));
  server(completed('Specialist answer.'));
  const specialist = new Agent({ name: 'specialist' });
  const result = await runner().run(
    new Agent({
      name: 'assistant',
      handoffs: [specialist],
      modelSettings: { toolChoice: 'required' },
    }),
    'Transfer this request.',
  );
  expect(result.lastAgent).toBe(specialist);
  expect(result.finalOutput).toBe('Specialist answer.');
});

test.each(['none', 'hosted'])(
  'rejects required tool choice with only %s tools before opening the CLI',
  async (kind) => {
    const tools = kind === 'hosted' ? [webSearchTool()] : [];
    await expect(
      runner().run(
        new Agent({
          name: 'assistant',
          tools,
          modelSettings: { toolChoice: 'required' },
        }),
        'Hello.',
      ),
    ).rejects.toThrow('requires an SDK tool or handoff');
    expect(boundary.open).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  'executes a required SDK shell callback with stream=%s',
  async (stream) => {
    const events = callback('shell', 'agents_sdk');
    events[0]!.params.arguments = { action: { commands: ['pwd'] } };
    const first = server(events);
    server(completed('Workspace inspected.'));
    const run = vi.fn(async () => ({
      output: [
        {
          stdout: '/workspace',
          stderr: '',
          outcome: { type: 'exit' as const, exitCode: 0 },
        },
      ],
    }));
    const agent = new Agent({
      name: 'assistant',
      modelSettings: { toolChoice: 'required', retry: { maxRetries: 2 } },
      tools: [shellTool({ shell: { run } })],
    });
    const result = stream
      ? await runner().run(agent, 'Inspect the workspace.', { stream: true })
      : await runner().run(agent, 'Inspect the workspace.');
    if (stream) {
      for await (const _event of result as AsyncIterable<unknown>) {
        /* Drain the live stream. */
      }
    }
    expect(result.finalOutput).toBe('Workspace inspected.');
    expect(run).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(boundary.open).toHaveBeenCalledTimes(2);
  },
);

test.each(['empty', 'eof'])(
  'reports required %s completion without a successful stream terminal',
  async (kind) => {
    const connection = server(
      kind === 'empty'
        ? [
            {
              method: 'turn/completed',
              params: {
                threadId: 'thread',
                turn: { id: 'turn', status: 'completed' },
              },
            },
          ]
        : [],
    );
    const request = sandboxRequest();
    request.modelSettings = { toolChoice: 'required' };
    const events: string[] = [];
    await expect(
      (async () => {
        for await (const event of new CodexProvider()
          .getModel()
          .getStreamedResponse(request))
          events.push(event.type);
      })(),
    ).rejects.toThrow(
      kind === 'empty'
        ? 'did not call an SDK tool or handoff'
        : 'Codex finished without a completed response.',
    );
    expect(events).not.toContain('response_done');
    expect(connection.close).toHaveBeenCalledOnce();
    expect(boundary.open).toHaveBeenCalledOnce();
  },
);

test('fails required tool choice without a successful stream terminal when Codex only answers', async () => {
  const connection = server([
    {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: 'commandExecution',
          id: 'native',
          command: 'echo native',
        },
      },
    },
    ...completed('A plain answer after a native tool.'),
  ]);
  const request = sandboxRequest();
  request.modelSettings = { toolChoice: 'required', retry: { maxRetries: 2 } };
  const model = new CodexProvider().getModel();
  const events: string[] = [];
  await expect(
    (async () => {
      for await (const event of model.getStreamedResponse(request))
        events.push(event.type);
    })(),
  ).rejects.toThrow('did not call an SDK tool or handoff');
  expect(events).not.toContain('response_done');
  expect(connection.close).toHaveBeenCalledOnce();
  expect(boundary.open).toHaveBeenCalledOnce();
});

test.each([undefined, 'auto' as const])(
  'preserves %s tool choice without a function call',
  async (toolChoice) => {
    server(completed('A plain answer.'));
    const result = await runner().run(
      new Agent({ name: 'assistant', modelSettings: { toolChoice } }),
      'Hello.',
    );
    expect(result.finalOutput).toBe('A plain answer.');
  },
);

test.each([
  [{ toolChoice: 'none' }, 'toolChoice'],
  [{ toolChoice: 'lookup' }, 'toolChoice'],
  [{ parallelToolCalls: false }, 'parallelToolCalls'],
  [{ store: true }, 'store'],
  [{ reasoning: { context: 'all_turns' as const } }, 'reasoning.context'],
])(
  'rejects an SDK setting that Codex cannot enforce: %j',
  async (settings, name) => {
    const agent = new Agent({ name: 'assistant', modelSettings: settings });
    await expect(runner().run(agent, 'Hello.')).rejects.toThrow(
      `CodexProvider does not support modelSettings.${name}.`,
    );
    expect(boundary.open).not.toHaveBeenCalled();
  },
);

test.each([
  ['unconfigured tool', 'unknown', null],
  ['mismatched namespace', 'lookup', 'unconfigured'],
])(
  'rejects a callback for %s without executing SDK tools',
  async (_label, name, namespace) => {
    const connection = server(callback(name!, namespace));
    const execute = vi.fn(async () => 'account');
    const agent = new Agent({
      name: 'assistant',
      tools: [
        tool({
          name: 'lookup',
          description: 'Find account.',
          parameters: z.object({}),
          execute,
        }),
      ],
    });
    await expect(runner().run(agent, 'Find account.')).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledOnce();
  },
);

for (const stream of [false, true]) {
  for (const automatic of [false, true]) {
    test(`replays ${automatic ? 'automatic' : 'manual'} Responses compaction with stream=${stream}`, async () => {
      const compaction = {
        type: 'compaction' as const,
        id: 'cmp_original',
        encrypted_content: 'opaque-encrypted-history',
      };
      const compact = vi.fn().mockResolvedValue({ output: [compaction] });
      const session = new OpenAIResponsesCompactionSession({
        client: { responses: { compact } } as any,
        model: 'gpt-5.4',
        shouldTriggerCompaction: () => automatic,
      });
      const first = server(completed('The synthetic ticket is amber.'));
      const agent = new Agent({ name: 'support' });
      const sdk = runner();
      const result = stream
        ? await sdk.run(agent, 'Remember the synthetic ticket color.', {
            session,
            stream: true,
          })
        : await sdk.run(agent, 'Remember the synthetic ticket color.', {
            session,
          });
      if ('completed' in result) await result.completed;
      // Provider IDs remain available to callers but are not Responses chain IDs.
      expect(result.lastResponseId).toBe('thread');
      expect(first.close).toHaveBeenCalledOnce();
      if (!automatic) await session.runCompaction({ force: true });
      expect(compact).toHaveBeenCalledOnce();
      expect(compact.mock.calls[0][0]).toEqual({
        model: 'gpt-5.4',
        input: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'assistant' }),
        ]),
      });
      expect(await session.getItems()).toEqual([compaction]);
      const next = server(completed('amber'));
      const followup = await sdk.run(agent, 'What color was the ticket?', {
        session,
      });
      expect(followup.finalOutput).toBe('amber');
      expect(next.request).toHaveBeenCalledWith('thread/inject_items', {
        threadId: 'thread',
        items: [compaction],
      });
    });
  }
}
