import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { z as zod3 } from 'zod/v3';
import {
  Agent,
  MemorySession,
  RunContext,
  Usage,
  tool,
  type Model,
  type ModelResponse,
} from '@openai/agents-core';
import type { SerializedFunctionTool } from '@openai/agents-core/model';
import type { AgentInputItem, StreamEvent } from '@openai/agents-core/types';
import { ScriptedModel, assistantMessage } from '@openai/agents-core/testing';
import { SDKRunner } from '../src/migration';
import { capture } from '../src/migration/run';
import {
  modelRequest,
  modelResponse,
  bounded,
  SelectedModelInvocation,
  MAX_MODEL_BYTES,
} from '../src/migration/model';
import { sessionModelInput } from '../src/migration/persistence';
import {
  migrationTool,
  invokeFunctionTool,
  outputOf,
} from '../src/runtime/tools';
import type { ToolCallContext } from '../src/runtime/tools';
import { jsonObject, type JsonObject } from '../src/runtime/binding';

const native = vi.hoisted(() => ({ validateDeclarations: vi.fn() }));
vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({
    _validate_python_tool_declarations: native.validateDeclarations,
  }),
}));
beforeEach(() => {
  native.validateDeclarations.mockReset();
});

const body = (): JsonObject => ({
  model: 'agents-sdk-model',
  instructions: 'Static.',
  tools: [],
  input: [{ type: 'message', role: 'user', content: 'Hello' }],
});
const response = (): ModelResponse => ({
  output: [assistantMessage('Hello', { id: 'msg_actual' })],
  usage: new Usage({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
  requestId: 'request_actual',
});
const agent = (model = new ScriptedModel([])) =>
  new Agent({
    name: 'Classic',
    instructions: 'Static.',
    model,
    modelSettings: {},
  });

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const historyCall = {
  type: 'function_call',
  id: 'history-call-item',
  callId: 'history-call',
  name: 'echo',
  arguments: '{}',
} as const;
const historyResult = {
  type: 'function_call_result',
  callId: historyCall.callId,
  name: historyCall.name,
  status: 'completed',
  output: 'Result.',
} as const;

describe('migration declaration admission without native code', () => {
  it('captures run and function guard callbacks before application mutation', async () => {
    const originalInput = vi.fn(async () => ({
      tripwireTriggered: false,
      outputInfo: undefined,
    }));
    const originalOutput = vi.fn(async () => ({
      tripwireTriggered: false,
      outputInfo: undefined,
    }));
    const originalToolInput = vi.fn(async () => ({
      behavior: { type: 'allow' as const },
    }));
    const inputGuard = {
      name: 'original input',
      execute: originalInput,
      runInParallel: false,
    };
    const outputGuard = { name: 'original output', execute: originalOutput };
    const action = tool({
      name: 'guarded',
      description: 'A guarded function.',
      parameters: z.object({}),
      execute: async () => 'done',
      inputGuardrails: [
        { name: 'original tool input', run: originalToolInput },
      ],
    });
    const classic = agent();
    classic.inputGuardrails = [inputGuard];
    classic.outputGuardrails = [outputGuard];
    classic.tools = [action];
    const captured = capture(classic, 'Hello', { context: undefined });
    inputGuard.execute = vi.fn();
    outputGuard.execute = vi.fn();
    action.inputGuardrails![0]!.run = vi.fn();
    classic.inputGuardrails.length = 0;
    classic.outputGuardrails.length = 0;
    expect(captured.inputGuardrails[0]?.execute).toBe(originalInput);
    expect(captured.outputGuardrails[0]?.execute).toBe(originalOutput);
    const toolCall = {
      type: 'function_call' as const,
      name: action.name,
      callId: 'call',
      arguments: '{}',
    };
    await captured.tools[0]!.inputGuardrails![0]!.run({
      agent: classic,
      context: new RunContext(),
      toolCall,
    });
    expect(originalToolInput).toHaveBeenCalledOnce();
    expect(action.inputGuardrails![0]!.run).not.toHaveBeenCalled();
  });

  it('rejects an invalid guard callback before provider or native work', async () => {
    const classic = agent();
    classic.inputGuardrails = [
      { name: 'invalid', execute: undefined } as never,
    ];
    const getModel = vi.fn();
    await expect(
      SDKRunner.run(classic, 'Hello', {
        context: undefined,
        modelProvider: { getModel },
      }),
    ).rejects.toThrow('executable callbacks');
    expect(getModel).not.toHaveBeenCalled();
    expect(native.validateDeclarations).not.toHaveBeenCalled();
  });

  it('accepts a fresh SDK user-message item before native admission', () => {
    expect(() =>
      capture(agent(), [{ role: 'user', content: 'Fresh user text.' }], {
        context: undefined,
      }),
    ).not.toThrow();
  });
  it('copies ordered SDK text/image parts before native admission', () => {
    const text = { type: 'input_text' as const, text: 'Before.' };
    const picture = { type: 'input_image' as const, image, detail: 'auto' };
    const content = [text, picture];
    const input: AgentInputItem[] = [{ role: 'user', content }];
    const captured = capture(agent(), input, { context: undefined });
    text.text = 'Changed.';
    picture.image = 'https://invalid.example/image.png';
    content.length = 0;
    input.length = 0;
    expect(captured.input).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Before.' },
        { type: 'input_image', image_url: image, detail: 'auto' },
      ],
    });
  });
  it.each([
    ['empty history', []],
    [
      'multiple messages',
      [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
      ],
    ],
    ['system message', [{ role: 'system', content: 'Instructions.' }]],
    [
      'completed assistant',
      [assistantMessage('History.', { id: 'past-answer' })],
    ],
    ['message ID', [{ role: 'user', content: 'Text.', id: 'previous' }]],
    ['inert metadata', [{ role: 'user', content: 'Text.', providerData: {} }]],
    [
      'complete pair without a fresh user',
      [{ ...historyCall }, { ...historyResult }],
    ],
  ])('captures supported %s before native admission', (_name, input) => {
    const captured = capture(agent(), input as AgentInputItem[], {
      context: undefined,
    });
    expect(captured.sdkInput).toEqual(input);
    expect(captured.sdkItems).toEqual(input);
    expect(native.validateDeclarations).not.toHaveBeenCalled();
  });

  it('captures caller history IDs, metadata and images before caller mutation', () => {
    const text = { type: 'input_text' as const, text: 'Original.' };
    const picture = { type: 'input_image' as const, image };
    const user = {
      type: 'message' as const,
      role: 'user' as const,
      id: 'original-user',
      providerData: { id: 'original-user' },
      content: [text, picture],
    };
    const annotation = { title: 'original annotation' };
    const input: AgentInputItem[] = [
      user,
      { ...historyCall },
      { ...historyResult },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        id: 'original-answer',
        phase: 'final_answer',
        content: [
          {
            type: 'output_text',
            text: 'Settled.',
            providerData: { annotations: [annotation] },
          },
        ],
      },
    ];
    const expected = structuredClone(input);
    const captured = capture(agent(), input, { context: undefined });
    user.id = 'changed-user';
    user.providerData.id = 'changed-user';
    text.text = 'Changed.';
    picture.image = 'https://invalid.example/changed.png';
    annotation.title = 'changed annotation';
    input.length = 0;
    expect(captured.sdkInput).toEqual(expected);
    expect(captured.sdkItems).toEqual(expected);
    expect(captured.input).toBe('');
  });

  it.each([
    ['sparse history', Array(1)],
    [
      'incomplete assistant shape',
      [{ role: 'assistant', content: 'History.' }],
    ],
    ['reference', [{ type: 'item_reference', id: 'previous' }]],
    [
      'provider identity override',
      [
        {
          role: 'user',
          content: 'Text.',
          id: 'original',
          providerData: { id: 'changed' },
        },
      ],
    ],
    [
      'effect metadata',
      [
        {
          role: 'user',
          content: 'Text.',
          providerData: { approval: 'pending' },
        },
      ],
    ],
    [
      'oversize caller history',
      [{ role: 'system', content: 'x'.repeat(MAX_MODEL_BYTES) }],
    ],
    ['empty content', [{ role: 'user', content: [] }]],
    ['sparse content', [{ role: 'user', content: Array(1) }]],
    [
      'text type',
      [{ role: 'user', content: [{ type: 'input_text', text: 1 }] }],
    ],
    [
      'cache marker',
      [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Text.',
              promptCacheBreakpoint: { mode: 'explicit' },
            },
          ],
        },
      ],
    ],
    [
      'remote image',
      [
        {
          role: 'user',
          content: [
            { type: 'input_image', image: 'https://invalid.example/image.png' },
          ],
        },
      ],
    ],
    [
      'image reference',
      [
        {
          role: 'user',
          content: [{ type: 'input_image', image: { id: 'file' } }],
        },
      ],
    ],
    [
      'image detail',
      [
        {
          role: 'user',
          content: [{ type: 'input_image', image, detail: 'high' }],
        },
      ],
    ],
    [
      'base64 syntax',
      [
        {
          role: 'user',
          content: [
            { type: 'input_image', image: 'data:image/png;base64,not@@base64' },
          ],
        },
      ],
    ],
    [
      'file',
      [{ role: 'user', content: [{ type: 'input_file', file: 'file' }] }],
    ],
    ['audio', [{ role: 'user', content: [{ type: 'audio', audio: 'YQ==' }] }]],
    [
      'raw image alias',
      [{ role: 'user', content: [{ type: 'input_image', image_url: image }] }],
    ],
    ['incomplete pair', [{ ...historyCall }]],
    ['orphan result', [{ ...historyResult }]],
    [
      'duplicate call',
      [{ ...historyCall }, { ...historyCall }, { ...historyResult }],
    ],
    [
      'duplicate result',
      [{ ...historyCall }, { ...historyResult }, { ...historyResult }],
    ],
    [
      'raw call alias',
      [
        { ...historyCall, callId: undefined, call_id: historyCall.callId },
        { ...historyResult },
      ],
    ],
    [
      'raw result alias',
      [
        { ...historyCall },
        {
          type: 'function_call_output',
          call_id: historyCall.callId,
          output: 'Result.',
        },
      ],
    ],
  ])(
    'rejects %s before provider, native, Model, tool or store effects',
    async (_name, input) => {
      const model = new ScriptedModel([]);
      const getModel = vi.fn(async () => model);
      const execute = vi.fn(() => 'Unused.');
      const session = new MemorySession();
      const getItems = vi.spyOn(session, 'getItems');
      const addItems = vi.spyOn(session, 'addItems');
      const classic = new Agent({
        name: 'Preflight',
        instructions: 'Static.',
        model: 'chosen',
        modelSettings: {},
        tools: [
          tool({
            name: 'echo',
            description: 'Echo.',
            parameters: z.object({}),
            execute,
          }),
        ],
      });
      await expect(
        SDKRunner.run(classic, input as AgentInputItem[], {
          context: undefined,
          modelProvider: { getModel },
          session,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(native.validateDeclarations).not.toHaveBeenCalled();
      expect(getModel).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      expect(getItems).not.toHaveBeenCalled();
      expect(addItems).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid JavaScript instructions before resolving a provider', async () => {
    const getModel = vi.fn();
    const classic = new Agent({
      name: 'Unsupported',
      model: 'named',
    });
    Object.assign(classic, { instructions: 42 });
    await expect(
      SDKRunner.run(classic, 'Hello', {
        context: undefined,
        modelProvider: { getModel },
      }),
    ).rejects.toThrow('string or callable instructions');
    expect(native.validateDeclarations).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
  });
  it('validates reserved factory tool names before resolving a provider', async () => {
    const invalid = new Error('JavaScript tool uses a reserved name');
    native.validateDeclarations.mockImplementationOnce(() => {
      throw invalid;
    });
    const getModel = vi.fn(async () => {
      throw new Error('Provider must not be entered');
    });
    const execute = vi.fn(() => 'unused');
    const reserved = tool({
      name: 'exec_command',
      description: 'Reserved.',
      parameters: z.object({}),
      execute,
    });
    const classic = new Agent({
      name: 'Reserved',
      instructions: 'Static.',
      model: 'named',
      modelSettings: {},
      tools: [reserved],
    });
    await expect(
      SDKRunner.run(classic, 'Hello', {
        context: undefined,
        modelProvider: { getModel },
      }),
    ).rejects.toBe(invalid);
    expect(native.validateDeclarations).toHaveBeenCalledOnce();
    expect(JSON.parse(native.validateDeclarations.mock.calls[0][0])).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        description: 'Reserved.',
        inputSchema: reserved.parameters,
        deferLoading: false,
      },
    ]);
    expect(getModel).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects retained dynamic tool policies without executing them', () => {
    const predicate = vi.fn(() => true);
    const options = {
      name: 'echo',
      description: 'Echo.',
      parameters: z.object({ text: z.string() }),
      execute: ({ text }: { text: string }) => text,
      isEnabled: true as boolean | typeof predicate,
    };
    const classic = agent();
    classic.tools = [tool(options)];
    options.isEnabled = predicate;
    expect(() => capture(classic, 'Hello', { context: undefined })).toThrow(
      'static',
    );
    expect(predicate).not.toHaveBeenCalled();
    options.isEnabled = false;
    expect(
      capture(classic, 'Hello', { context: undefined }).tools,
    ).toHaveLength(0);
  });
  it('rejects hidden custom error policy and unregistered functions', () => {
    const classic = agent();
    classic.tools = [
      tool({
        name: 'custom',
        description: 'Custom.',
        parameters: z.object({}),
        execute: () => 'ok',
        errorFunction: null,
      }),
    ];
    expect(() => capture(classic, '', { context: undefined })).toThrow('error');
    classic.tools = [
      {
        ...tool({
          name: 'plain',
          description: 'Plain.',
          parameters: z.object({}),
          execute: () => 'ok',
        }),
        invoke: async () => 'custom',
      },
    ];
    expect(() => capture(classic, '', { context: undefined })).toThrow(
      'registered',
    );
  });
  it('rejects accessors without invoking policy getters', () => {
    const options = {
      name: 'plain',
      description: 'Plain.',
      parameters: z.object({}),
      execute: () => 'ok',
    };
    const classic = agent();
    classic.tools = [tool(options)];
    const getter = vi.fn(() => false);
    Object.defineProperty(options, 'needsApproval', { get: getter });
    expect(() => capture(classic, '', { context: undefined })).toThrow(
      'inspect',
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it('shares classic precedence and rejects unsupported effective settings', () => {
    const classic = agent();
    classic.modelSettings = { temperature: 0.2, store: false };
    const captured = capture(classic, '', {
      context: undefined,
      modelSettings: { temperature: 0.8, topP: 0.9 },
    });
    expect(captured.settings).toEqual({
      temperature: 0.2,
      topP: 0.9,
      store: false,
    });
    expect(() =>
      capture(classic, '', {
        context: undefined,
        modelSettings: { parallelToolCalls: false } as never,
      }),
    ).toThrow('parallelToolCalls');
  });
  it('captures retry policy identity and detaches merged backoff data without invoking it', () => {
    const classic = agent();
    const policy = vi.fn(() => true);
    classic.modelSettings = {
      retry: { maxRetries: 2, backoff: { maxDelayMs: 100 } },
    };
    const defaults = {
      retry: { policy, backoff: { initialDelayMs: 1 } },
      timeoutMs: 20,
    };
    const captured = capture(classic, '', {
      context: undefined,
      modelSettings: defaults,
    });
    defaults.retry.policy = vi.fn(() => false);
    defaults.retry.backoff.initialDelayMs = 500;
    classic.modelSettings.retry!.backoff!.maxDelayMs = 600;
    expect(captured.settings.retry).toEqual({
      maxRetries: 2,
      policy,
      backoff: { initialDelayMs: 1, maxDelayMs: 100 },
    });
    expect(captured.settings.timeoutMs).toBe(20);
    expect(policy).not.toHaveBeenCalled();
  });
  it.each([
    { timeoutMs: 0 },
    { retry: { maxRetries: -1 } },
    { retry: { policy: 'invalid' } },
    { retry: { backoff: { jitter: 'invalid' } } },
  ])(
    'rejects invalid admitted attempt controls before effects: %j',
    async (modelSettings) => {
      const getModel = vi.fn();
      await expect(
        SDKRunner.run(
          new Agent({
            name: 'Invalid controls',
            instructions: 'Static.',
            model: 'named',
            modelSettings: {},
          }),
          '',
          {
            context: undefined,
            modelProvider: { getModel },
            modelSettings: modelSettings as never,
          },
        ),
      ).rejects.toThrow();
      expect(getModel).not.toHaveBeenCalled();
      expect(native.validateDeclarations).not.toHaveBeenCalled();
    },
  );

  it('retains the exact provider failure without native acquisition or fallback', async () => {
    const error = { provider: 'unavailable' };
    const getModel = vi.fn(async () => {
      throw error;
    });
    const classic = new Agent({
      name: 'Named',
      instructions: 'Static.',
      model: 'exact-name',
      modelSettings: {},
    });
    await expect(
      SDKRunner.run(classic, '', {
        context: undefined,
        modelProvider: { getModel },
      }),
    ).rejects.toBe(error);
    expect(getModel).toHaveBeenCalledExactlyOnceWith('exact-name');
  });
});

describe('migration mappings', () => {
  it('preserves ordered user text and prepared inline image semantics for the SDK Model', () => {
    const request = modelRequest(
      {
        ...body(),
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Before.' },
              { type: 'input_image', image_url: image, detail: 'original' },
              { type: 'input_text', text: 'After.' },
            ],
          },
        ],
      },
      [],
      {},
      new AbortController().signal,
    );
    expect(request.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Before.' },
          { type: 'input_image', image, detail: 'original' },
          { type: 'input_text', text: 'After.' },
        ],
      },
    ]);
  });
  it('projects developer text, preserves input IDs and complete function pairs', () => {
    const parameters = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    } satisfies SerializedFunctionTool['parameters'];
    const tools = [
      {
        type: 'function' as const,
        name: 'lookup',
        description: 'Lookup.',
        parameters,
        strict: true,
      },
    ];
    const request = modelRequest(
      {
        ...body(),
        tools,
        max_output_tokens: 5,
        input: [
          {
            type: 'message',
            id: 'dev',
            role: 'developer',
            content: [
              { type: 'input_text', text: 'A' },
              { type: 'input_text', text: 'B' },
            ],
          },
          {
            type: 'function_call',
            id: 'call_item',
            call_id: 'call',
            name: 'lookup',
            arguments: ' { } ',
          },
          { type: 'function_call_output', call_id: 'call', output: 'found' },
        ],
      },
      tools,
      { maxTokens: 10, store: false },
      new AbortController().signal,
    );
    expect(request.input).toEqual([
      { type: 'message', id: 'dev', role: 'system', content: 'A\nB' },
      {
        type: 'function_call',
        id: 'call_item',
        callId: 'call',
        name: 'lookup',
        arguments: ' { } ',
      },
      {
        type: 'function_call_result',
        callId: 'call',
        name: 'lookup',
        status: 'completed',
        output: 'found',
      },
    ]);
    expect(request.modelSettings).toEqual({ maxTokens: 5, store: false });
    expect(request).not.toHaveProperty('_internal');
    expect(request).not.toHaveProperty('previousResponseId');
  });
  it('rejects references, unpaired results, media and unexpected tools before dispatch', () => {
    const signal = new AbortController().signal;
    for (const request of [
      { ...body(), previous_response_id: 'foreign' },
      {
        ...body(),
        input: [
          { type: 'function_call_output', call_id: 'missing', output: 'x' },
        ],
      },
      {
        ...body(),
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'image' }],
          },
        ],
      },
      { ...body(), tools: [{ type: 'web_search' }] },
    ])
      expect(() => modelRequest(request, [], {}, signal)).toThrow();
  });
  it('captures actual IDs and usage without inserting a private wire ID', () => {
    const original = response();
    const result = modelResponse(original, []);
    expect(result.actual.responseId).toBeUndefined();
    expect(result.actual.requestId).toBe('request_actual');
    expect(result.actual.output[0].id).toBe('msg_actual');
    expect(result.actual.usage.totalTokens).toBe(5);
    expect(result.wire).toContain('response.completed');
    original.output.length = 0;
    expect(result.actual.output).toHaveLength(1);
  });
  it.each([
    {
      name: 'absent details',
      input: undefined,
      output: undefined,
      expectedInput: { cached_tokens: 0 },
      expectedOutput: { reasoning_tokens: 0 },
    },
    {
      name: 'other detail fields',
      input: { cache_write_tokens: 1 },
      output: { audio_tokens: 2 },
      expectedInput: { cached_tokens: 0, cache_write_tokens: 1 },
      expectedOutput: { reasoning_tokens: 0, audio_tokens: 2 },
    },
    {
      name: 'explicit counts',
      input: { cached_tokens: 1 },
      output: { reasoning_tokens: 2 },
      expectedInput: { cached_tokens: 1 },
      expectedOutput: { reasoning_tokens: 2 },
    },
  ])(
    'supplies required native usage counts for $name',
    ({ input, output, expectedInput, expectedOutput }) => {
      const original = response();
      original.usage = new Usage({
        inputTokens: 2,
        outputTokens: 3,
        input_tokens_details: input,
        output_tokens_details: output,
      });
      const result = modelResponse(original, []);
      const terminal = JSON.parse(
        result.wire.trim().split('\n\n').at(-1)!.slice(6),
      );
      expect(terminal.response.usage).toEqual({
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
        input_tokens_details: expectedInput,
        output_tokens_details: expectedOutput,
      });
      for (const usage of [original.usage, result.actual.usage]) {
        expect(usage.inputTokensDetails).toEqual(input ? [input] : []);
        expect(usage.outputTokensDetails).toEqual(output ? [output] : []);
      }
    },
  );
  it('rejects unrepresentable usage and invalid function arguments', () => {
    const invalid = response();
    invalid.usage.totalTokens = 6;
    expect(() => modelResponse(invalid, [])).toThrow('totals');
    invalid.usage = new Usage({ inputTokens: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => modelResponse(invalid, [])).toThrow('safe integer');
    const toolSpec = {
      type: 'function' as const,
      name: 'lookup',
      description: 'Lookup.',
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    };
    expect(() =>
      modelResponse(
        {
          ...response(),
          output: [
            {
              type: 'function_call',
              name: 'lookup',
              callId: 'c',
              arguments: '[]',
            },
          ],
        },
        [toolSpec],
      ),
    ).toThrow();
  });
  it('uses normalized JSON and invokes one original classic schema transform', async () => {
    let transformed = 0;
    const original = tool({
      name: 'echo',
      description: 'Echo.',
      parameters: zod3.object({
        text: zod3.string().transform((value) => {
          transformed++;
          return value.toUpperCase();
        }),
      }) as any,
      execute: ({ text }: { text: string }) => text,
    });
    const texts: string[] = [];
    const adapted = migrationTool(
      {
        name: original.name,
        description: original.description,
        parameters: jsonObject.parse(original.parameters),
      },
      async (text, context) => {
        texts.push(text);
        return original.invoke(
          new (await import('@openai/agents-core')).RunContext(undefined),
          text,
          {
            signal: context.signal,
            toolCall: {
              type: 'function_call',
              name: 'echo',
              callId: context.callId,
              arguments: text,
            },
          },
        );
      },
      () => {},
    );
    const context = {
      context: undefined,
      submission: {},
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      signal: new AbortController().signal,
    } as ToolCallContext;
    expect(
      await invokeFunctionTool(adapted, { text: 'hello' }, context, () => {}),
    ).toEqual({
      contentItems: [{ type: 'inputText', text: 'HELLO' }],
      success: true,
    });
    expect(texts).toEqual(['{"text":"hello"}']);
    expect(transformed).toBe(1);
  });
});

describe('bounded and joined Model producers', () => {
  it('rejects an oversized history overlay plus catalog before calling the selected Model', async () => {
    const payload = 'x'.repeat(Math.ceil(2.2 * 1024 * 1024));
    const input: AgentInputItem[] = [{ role: 'user', content: payload }];
    const parameters = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    } satisfies SerializedFunctionTool['parameters'];
    const tools = [
      {
        type: 'function' as const,
        name: 'lookup',
        description: payload,
        parameters,
        strict: true,
      },
    ];
    expect(() => bounded(input)).not.toThrow();
    expect(() => bounded(tools)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify({ input, tools }))).toBeGreaterThan(
      MAX_MODEL_BYTES,
    );
    const carrier = jsonObject.parse({ ...body(), tools });
    expect(() =>
      modelRequest(carrier, tools, {}, new AbortController().signal),
    ).not.toThrow();
    const usage = new Usage();
    const invocation = new SelectedModelInvocation(
      tools,
      {},
      'response',
      { usage },
      'text',
      sessionModelInput(input, []),
    );
    const model = new ScriptedModel([response()]);
    invocation.model = model;
    const finish = vi.fn(async () => {});
    try {
      await expect(
        invocation.produce(
          carrier,
          new AbortController().signal,
          async () => {},
          finish,
        ),
      ).rejects.toThrow('4 MiB');
      expect(model.calls).toHaveLength(0);
      expect(finish).not.toHaveBeenCalled();
      expect(invocation.responses).toHaveLength(0);
      expect(usage.totalTokens).toBe(0);
    } finally {
      invocation.halt();
      await invocation.join();
    }
  });

  it('requires terminal, EOF and joined iterator return before publication', async () => {
    const returned = Promise.withResolvers<void>();
    let calls = 0;
    const terminal: Extract<StreamEvent, { type: 'response_done' }> = {
      type: 'response_done',
      response: {
        id: 'actual',
        usage: response().usage,
        output: [assistantMessage('Hello', { id: 'msg_actual' })],
      },
    };
    // Exact pending next/return ownership needs an iterator double rather than ScriptedModel.
    const model: Model = {
      getResponse: async () => response(),
      getStreamedResponse: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              return calls++ === 0
                ? { done: false, value: terminal }
                : { done: true, value: undefined };
            },
            async return() {
              await returned.promise;
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    };
    const usage = new Usage();
    const invocation = new SelectedModelInvocation([], {}, 'stream', { usage });
    invocation.model = model;
    const finish = vi.fn(async () => {});
    const produced = invocation.produce(
      body(),
      new AbortController().signal,
      async () => {},
      finish,
    );
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(finish).not.toHaveBeenCalled();
    expect(usage.totalTokens).toBe(0);
    returned.resolve();
    expect(await produced).toContain('response.completed');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(invocation.responses[0].responseId).toBe('actual');
    expect(usage).toMatchObject({ requests: 1, totalTokens: 5 });
    await invocation.join();
    await invocation.join();
    expect(usage).toMatchObject({ requests: 1, totalTokens: 5 });
  });
  it('keeps accepted tool results in Model batch order after late acknowledgments', () => {
    const invocation = new SelectedModelInvocation([], {}, 'response', {
      usage: new Usage(),
    });
    const first = {
      type: 'function_call' as const,
      id: 'first_actual',
      callId: 'first',
      name: 'lookup',
      namespace: 'functions',
      arguments: '{}',
    };
    const second = { ...first, id: 'second_actual', callId: 'second' };
    const final = assistantMessage('Done.', { id: 'final_actual' });
    invocation.responses.push(
      { ...response(), output: [first, second] },
      { ...response(), output: [final] },
    );
    expect(() => invocation.getOutputItems()).toThrow('missing an accepted');
    // Native can finish before its already-entered SDK callbacks have drained.
    invocation.toolResult('second', 'lookup', outputOf('{"literal":"text"}'));
    invocation.toolResult('first', 'lookup', outputOf('First result.'));
    expect(invocation.getOutputItems()).toEqual([
      first,
      second,
      {
        type: 'function_call_result',
        name: 'lookup',
        namespace: 'functions',
        callId: 'first',
        status: 'completed',
        output: { type: 'text', text: 'First result.' },
      },
      {
        type: 'function_call_result',
        name: 'lookup',
        namespace: 'functions',
        callId: 'second',
        status: 'completed',
        output: { type: 'text', text: '{"literal":"text"}' },
      },
      final,
    ]);
    expect(() =>
      invocation.toolResult('first', 'lookup', outputOf('Changed.')),
    ).toThrow('duplicate');
  });
  it('retains accepted tool evidence without clearing a concurrent failure', () => {
    const invocation = new SelectedModelInvocation([], {}, 'response', {
      usage: new Usage(),
    });
    invocation.responses.push({
      ...response(),
      output: [
        {
          type: 'function_call',
          callId: 'accepted',
          name: 'lookup',
          arguments: '{}',
        },
      ],
    });
    const failure = new Error('Cancelled after native acknowledgment.');
    invocation.fail(failure);
    invocation.toolResult('accepted', 'lookup', outputOf('Committed.'));
    expect(invocation.getOutputItems()).toContainEqual({
      type: 'function_call_result',
      name: 'lookup',
      callId: 'accepted',
      status: 'completed',
      output: { type: 'text', text: 'Committed.' },
    });
    expect(() => invocation.check()).toThrow(failure);
  });
  it('latches the original error and makes no second Model attempt', async () => {
    const original = { failed: 'model' };
    const model = new ScriptedModel([{ type: 'error', error: original }]);
    const usage = new Usage();
    const invocation = new SelectedModelInvocation([], {}, 'response', {
      usage,
    });
    invocation.model = model;
    const produce = () =>
      invocation.produce(
        body(),
        new AbortController().signal,
        async () => {},
        async () => {},
      );
    await expect(produce()).rejects.toBe(original);
    await expect(produce()).rejects.toBe(original);
    expect(model.calls).toHaveLength(1);
    expect(invocation.responses).toHaveLength(0);
    expect(usage.totalTokens).toBe(0);
  });
  it('rejects missing/late terminals and oversize output without publication', async () => {
    const streams = [
      [],
      [
        {
          type: 'response_done',
          response: {
            id: 'actual',
            usage: response().usage,
            output: response().output,
          },
        },
        { type: 'output_text_delta', delta: 'late' },
      ],
      [0, 1].map(() => ({
        type: 'response_done',
        response: {
          id: 'duplicate',
          usage: response().usage,
          output: response().output,
        },
      })),
      [{ type: 'output_text_delta', delta: 'x'.repeat(MAX_MODEL_BYTES) }],
    ];
    for (const events of streams) {
      const usage = new Usage();
      const invocation = new SelectedModelInvocation([], {}, 'stream', {
        usage,
      });
      invocation.model = {
        getResponse: async () => response(),
        getStreamedResponse: () => ({
          async *[Symbol.asyncIterator]() {
            yield* events as never[];
          },
        }),
      };
      const finish = vi.fn(async () => {});
      await expect(
        invocation.produce(
          body(),
          new AbortController().signal,
          async () => {},
          finish,
        ),
      ).rejects.toBeDefined();
      expect(finish).not.toHaveBeenCalled();
      expect(usage.totalTokens).toBe(0);
    }
  });
  it('keeps an abort-ignoring response pending until its producer settles', async () => {
    const pending = Promise.withResolvers<ModelResponse>();
    const usage = new Usage();
    const invocation = new SelectedModelInvocation([], {}, 'response', {
      usage,
    });
    invocation.model = {
      getResponse: () => pending.promise,
      getStreamedResponse: () => ({ async *[Symbol.asyncIterator]() {} }),
    };
    let settled = false;
    const result = invocation
      .produce(
        body(),
        new AbortController().signal,
        async () => {},
        async () => {},
      )
      .finally(() => {
        settled = true;
      });
    result.catch(() => {});
    await Promise.resolve();
    const original = new Error('stop');
    invocation.fail(original);
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve(response());
    await expect(result).rejects.toBe(original);
    await invocation.join();
    expect(usage.totalTokens).toBe(0);
  });
  it('preserves a Model-only original error with the public runner', async () => {
    const error = new Error('selected provider failed');
    const getModel = vi.fn(async () => {
      throw error;
    });
    await expect(
      SDKRunner.run(
        new Agent({ name: 'Named', model: 'named', modelSettings: {} }),
        '',
        { context: undefined, modelProvider: { getModel } },
      ),
    ).rejects.toBe(error);
    expect(getModel).toHaveBeenCalledTimes(1);
  });
});
