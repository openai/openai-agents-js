import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AgentInputItem,
  GuardrailExecutionError,
  MaxTurnsExceededError,
  ModelRefusalError,
  run,
  Runner,
  setDefaultModelProvider,
  setTracingDisabled,
  Usage,
  RunStreamEvent,
  RunAgentUpdatedStreamEvent,
  RunItemStreamEvent,
  RunMessageOutputItem,
  StreamedRunResult,
  handoff,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  FunctionCallItem,
  tool,
  user,
  Session,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  UserError,
  RunContext,
  RunState,
  hostedMcpTool,
  shellTool,
} from '../src';
import {
  ScriptedModelProvider,
  TEST_MODEL_FUNCTION_CALL,
  fakeModelMessage,
  fakeModelRefusal,
} from './stubs';
import * as protocol from '../src/types/protocol';
import * as sessionPersistence from '../src/runner/sessionPersistence';
import type { GuardrailFunctionOutput } from '../src/guardrail';
import { ServerConversationTracker } from '../src/runner/conversation';
import logger from '../src/logger';
import { getEventListeners } from 'node:events';
import { InvalidToolInputError, ToolCallError } from '../src/errors';
import { getToolInvocationFingerprint } from '../src/toolInvocation';
import {
  ScriptedModel,
  modelError,
  modelResponse,
  modelStream,
  modelStreamResponder,
  type ScriptedModelInput,
} from '../src/testing';

function getFirstTextContent(item: AgentInputItem): string | undefined {
  if (item.type !== 'message') {
    return undefined;
  }
  if (typeof item.content === 'string') {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const first = item.content[0] as { text?: string };
    return first?.text;
  }
  return undefined;
}

function getRequestInputItems(request: ModelRequest): AgentInputItem[] {
  return Array.isArray(request.input) ? request.input : [];
}

function abortingHangingStream(): ScriptedModelInput {
  return modelStreamResponder((call) =>
    (async function* () {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      const signal = call.request.signal;
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError);
          return;
        }
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(abortError);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      yield* [] as StreamEvent[];
    })(),
  );
}

function terminalModelStream(
  response: ModelResponse,
  responseId: string,
): ScriptedModelInput {
  return modelStream([
    {
      type: 'response_done',
      response: {
        id: responseId,
        usage: {
          requests: response.usage.requests,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
        },
        output: response.output,
      },
    } as StreamEvent,
  ]);
}

function parsedTerminalModelStream(
  response: ModelResponse,
  responseId: string,
): ScriptedModelInput {
  return terminalModelStream(
    {
      ...response,
      output: response.output.map((item) =>
        protocol.OutputModelItem.parse(item),
      ),
    },
    responseId,
  );
}

class CountingFunctionToolStreamModel extends ScriptedModel {
  constructor() {
    super([
      terminalModelStream(
        {
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        },
        'resp-1',
      ),
      terminalModelStream(
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
        'resp-2',
      ),
    ]);
  }

  get callCount(): number {
    return this.calls.length;
  }
}

class AbortAfterStreamedFunctionCallModel extends ScriptedModel {
  constructor(
    responseId: string,
    reconciliationStep: ScriptedModelInput = modelResponse({
      output: [fakeModelMessage('reconciled')],
      usage: new Usage(),
      responseId: 'resp-reconciled',
    }),
  ) {
    super([
      modelStreamResponder(() =>
        (async function* () {
          yield {
            type: 'model',
            event: {
              type: 'response.created',
              response: { id: responseId },
            },
          } as StreamEvent;
          yield {
            type: 'model',
            event: {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                id: 'fc_abort',
                call_id: 'call_abort',
                name: 'slow_tool',
                arguments: '{}',
                status: 'completed',
              },
            },
          } as StreamEvent;
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        })(),
      ),
      reconciliationStep,
    ]);
  }

  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
  }
}

class FailingAbortReconciliationModel extends AbortAfterStreamedFunctionCallModel {
  constructor(responseId: string, reconciliationError: unknown) {
    super(responseId, modelError(reconciliationError));
  }
}

class AbortAfterStreamedProgramModel extends ScriptedModel {
  constructor(responseId: string) {
    super([
      modelStreamResponder(() =>
        (async function* () {
          yield {
            type: 'model',
            event: {
              type: 'response.created',
              response: { id: responseId },
            },
          } as StreamEvent;
          yield {
            type: 'model',
            event: {
              type: 'response.output_item.done',
              item: {
                type: 'program',
                id: 'prog_abort',
                call_id: 'call_prog_abort',
                code: 'text("done");',
                fingerprint: 'fingerprint:abort',
              },
            },
          } as StreamEvent;
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        })(),
      ),
      modelResponse({
        output: [fakeModelMessage('reconciled')],
        usage: new Usage(),
        responseId: 'resp-reconciled',
      }),
    ]);
  }

  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
  }
}

class AbortAfterStreamedProgramToolCallsModel extends ScriptedModel {
  constructor() {
    const items = [
      {
        type: 'program',
        id: 'prog_abort',
        call_id: 'call_prog_abort',
        code: 'await tools.shell();',
        fingerprint: 'fingerprint:abort',
      },
      {
        type: 'shell_call',
        id: 'shell_abort',
        call_id: 'call_shell_abort',
        status: 'completed',
        action: { commands: ['sleep 10'] },
        caller: { type: 'program', caller_id: 'call_prog_abort' },
      },
      {
        type: 'apply_patch_call',
        id: 'patch_abort',
        call_id: 'call_patch_abort',
        status: 'completed',
        operation: { type: 'delete_file', path: 'temporary.txt' },
        caller: { type: 'program', caller_id: 'call_prog_abort' },
      },
    ];
    super([
      modelStreamResponder(() =>
        (async function* () {
          for (const item of items) {
            yield {
              type: 'model',
              event: { type: 'response.output_item.done', item },
            } as StreamEvent;
          }
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        })(),
      ),
      modelResponse({
        output: [fakeModelMessage('reconciled')],
        usage: new Usage(),
        responseId: 'resp-reconciled',
      }),
    ]);
  }

  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
  }
}

// Test for unhandled rejection when stream loop throws

describe('Runner.run (streaming)', () => {
  it('does not stream exact committed hosted MCP replay items', async () => {
    const approvalCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'streamed-replay-source',
      name: 'mcp_approval_request',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'streamed-replay-server',
        name: 'lookup',
        id: 'streamed-replay-call',
        arguments: '{"account":"123"}',
      },
    };
    const responses: ModelResponse[] = [
      { output: [approvalCall], usage: new Usage() },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ];
    const mcpTool = hostedMcpTool({
      serverLabel: 'streamed-replay-server',
      serverUrl: 'https://example.com',
      requireApproval: 'always',
    });
    const agent = new Agent({
      name: 'StreamedHostedReplayAgent',
      model: new ScriptedModel(
        responses.map((response, index) =>
          terminalModelStream(
            response,
            `streamed-replay-${responses.length - index - 1}`,
          ),
        ),
      ),
      tools: [mcpTool],
    });
    const state = new RunState(new RunContext(), 'start', agent, 3);
    state._completedToolInvocations.set(
      agent,
      new Map([
        [
          'streamed-replay-call',
          getToolInvocationFingerprint('lookup', approvalCall),
        ],
      ]),
    );

    const result = await new Runner().run(agent, state, { stream: true });
    const events: RunStreamEvent[] = [];
    for await (const event of result) {
      events.push(event);
    }
    await result.completed;

    expect(result.finalOutput).toBe('done');
    expect(
      events.some(
        (event) =>
          event.type === 'run_item_stream_event' &&
          ((event.item as any).rawItem?.id === 'streamed-replay-source' ||
            (event.item as any).rawItem?.providerData?.id ===
              'streamed-replay-call'),
      ),
    ).toBe(false);
  });

  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new ScriptedModelProvider());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not emit unhandled rejection when stream loop fails', async () => {
    const agent = new Agent({ name: 'StreamFail', model: new ScriptedModel() });

    const rejections: unknown[] = [];
    const handler = (err: unknown) => {
      rejections.push(err);
    };
    process.on('unhandledRejection', handler);

    const result = await run(agent, 'hi', { stream: true });
    await expect(result.completed).rejects.toBeInstanceOf(Error);

    // allow queued events to fire
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', handler);

    expect(rejections).toHaveLength(0);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('exposes model error to the consumer', async () => {
    const agent = new Agent({
      name: 'StreamError',
      model: new ScriptedModel([
        modelError(new Error('Scripted stream failure')),
      ]),
    });

    const result = await run(agent, 'hi', { stream: true });
    await expect(result.completed).rejects.toThrow('Scripted stream failure');

    expect((result.error as Error).message).toBe('Scripted stream failure');
  });

  it('emits a high-level run item event for streamed compaction', async () => {
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_stream',
      encrypted_content: 'ciphertext',
    };

    const model = new ScriptedModel([
      modelStream([
        {
          type: 'model',
          event: { type: 'response.output_item.added', item: compaction },
        } as StreamEvent,
        {
          type: 'response_done',
          response: {
            id: 'resp-compaction-stream',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: [compaction, fakeModelMessage('streamed done')],
          },
        } as StreamEvent,
      ]),
    ]);

    const agent = new Agent({
      name: 'StreamingCompactionAgent',
      model,
    });
    const result = await run(agent, 'hi', { stream: true });

    const events: RunStreamEvent[] = [];
    for await (const event of result) {
      events.push(event);
    }
    await result.completed;

    expect(result.finalOutput).toBe('streamed done');
    expect(result.newItems.map((item) => item.type)).toEqual([
      'compaction_item',
      'message_output_item',
    ]);
    expect(result.history).toContainEqual(compaction);
    expect(
      events.some((event) => event.type === 'raw_model_stream_event'),
    ).toBe(true);
    expect(
      events.find(
        (event) =>
          event.type === 'run_item_stream_event' &&
          event.name === 'compaction_item_created',
      ),
    ).toMatchObject({
      type: 'run_item_stream_event',
      name: 'compaction_item_created',
      item: {
        type: 'compaction_item',
        rawItem: compaction,
      },
    });
  });

  it('does not persist input for a malformed terminal compaction item', async () => {
    const model = new ScriptedModel([
      modelStream([
        {
          type: 'response_done',
          response: {
            id: 'resp-malformed-compaction-stream',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: [
              {
                type: 'compaction',
                id: 'cmp_malformed_stream',
              },
            ],
          },
        } as StreamEvent,
      ]),
    ]);

    const addItems = vi.fn(async (_items: AgentInputItem[]) => {});
    const clearSession = vi.fn(async () => {});
    const replaceHistoryWithCompaction = vi.fn(
      async (_items: AgentInputItem[]) => {},
    );
    const session: Session = {
      getSessionId: vi.fn().mockResolvedValue('malformed-stream-session'),
      getItems: vi.fn().mockResolvedValue([]),
      addItems,
      popItem: vi.fn().mockResolvedValue(undefined),
      clearSession,
      replaceHistoryWithCompaction,
    };
    const agent = new Agent({
      name: 'MalformedStreamingCompactionAgent',
      model,
    });
    const defaultErrorHandler = vi.fn(() => ({
      finalOutput: 'not used',
    }));

    const result = await run(agent, 'hello', {
      stream: true,
      session,
      errorHandlers: { default: defaultErrorHandler },
    });

    await expect(result.completed).rejects.toThrow(
      'Compaction item missing encrypted_content',
    );
    expect(defaultErrorHandler).not.toHaveBeenCalled();
    expect(addItems).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(replaceHistoryWithCompaction).not.toHaveBeenCalled();
  });

  it('treats prior tool_search outputs in input history as loaded deferred tools', async () => {
    const getShippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const agent = new Agent({
      name: 'StreamingShippingAgent',
      model: new ScriptedModel([
        parsedTerminalModelStream(
          {
            output: [
              {
                type: 'function_call',
                id: 'fc_shipping_eta',
                callId: 'call_shipping_eta',
                name: 'get_shipping_eta',
                status: 'completed',
                arguments: JSON.stringify({ trackingNumber: 'ZX-123' }),
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          },
          'resp-stream-tool-search',
        ),
        parsedTerminalModelStream(
          {
            output: [fakeModelMessage('The package arrives tomorrow.')],
            usage: new Usage(),
          },
          'resp-stream-tool-search',
        ),
      ]),
      tools: [getShippingEta],
      toolUseBehavior: 'run_llm_again',
    });
    const inputHistory: AgentInputItem[] = [
      user('Load shipping tools first.'),
      {
        type: 'tool_search_output',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'get_shipping_eta',
          },
        ],
      } as any,
    ];

    const result = await run(agent, inputHistory, { stream: true });

    await result.completed;
    expect(result.finalOutput).toBe('The package arrives tomorrow.');
  });

  it('streams through missing function tool errors when opted in', async () => {
    const model = new ScriptedModel([
      parsedTerminalModelStream(
        {
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              name: 'missing_tool',
              callId: 'call_missing',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        },
        'resp-stream-missing-tool',
      ),
      parsedTerminalModelStream(
        {
          output: [fakeModelMessage('stream recovered')],
          usage: new Usage(),
        },
        'resp-stream-missing-tool',
      ),
    ]);
    const agent = new Agent({
      name: 'StreamingMissingToolAgent',
      model,
      toolUseBehavior: 'run_llm_again',
    });

    const result = await run(agent, 'start', {
      stream: true,
      toolNotFoundBehavior: 'return_error_to_model',
    });

    await result.completed;
    expect(result.finalOutput).toBe('stream recovered');
    expect(model.calls).toHaveLength(2);
    const secondInput = model.calls[1].request.input as AgentInputItem[];
    expect(secondInput).toContainEqual({
      type: 'function_call_result',
      name: 'missing_tool',
      callId: 'call_missing',
      status: 'completed',
      output: {
        type: 'text',
        text: "Tool 'missing_tool' not found.",
      },
    });
  });

  it('streams a redacted invalid-argument output back to the model', async () => {
    class InvalidArgumentStreamingModel extends ScriptedModel {
      constructor(responses: ModelResponse[]) {
        super(
          responses.map((response) =>
            parsedTerminalModelStream(
              response,
              response.responseId ?? 'resp-stream-invalid-argument',
            ),
          ),
        );
      }

      get requests(): readonly Readonly<ModelRequest>[] {
        return this.calls.map((call) => call.request);
      }
    }

    const secret = 'SECRET_STREAMING_MODEL_OUTPUT_123';
    vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(true);
    const model = new InvalidArgumentStreamingModel([
      {
        output: [
          {
            ...TEST_MODEL_FUNCTION_CALL,
            arguments: secret,
          },
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('stream recovered')],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'StreamingInvalidArgumentAgent',
      model,
      tools: [
        tool({
          name: 'test',
          description: 'Validate input.',
          parameters: z.object({ test: z.string() }),
          execute: async () => 'unexpected',
        }),
      ],
    });

    const result = await run(agent, 'start', { stream: true });

    await result.completed;
    expect(result.finalOutput).toBe('stream recovered');
    expect(model.requests).toHaveLength(2);
    const toolOutput = getRequestInputItems(model.requests[1]).find(
      (item) => item.type === 'function_call_result',
    ) as protocol.FunctionCallResultItem | undefined;
    expect(toolOutput?.output).toEqual({
      type: 'text',
      text: 'An error occurred while parsing tool arguments. Please try again with valid JSON.',
    });
    expect(JSON.stringify(toolOutput)).not.toContain(secret);
  });

  it('does not retain invalid arguments in streamed Runner errors', async () => {
    const model = new ScriptedModel([
      modelStream([
        {
          type: 'response_done',
          response: {
            id: 'resp-stream-invalid-argument-error',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: [
              protocol.OutputModelItem.parse({
                ...TEST_MODEL_FUNCTION_CALL,
                arguments: 'SECRET_STREAMED_RUN_STATE_123',
              }),
            ],
          },
        } satisfies StreamEvent,
      ]),
    ]);

    const secret = 'SECRET_STREAMED_RUN_STATE_123';
    vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(true);
    const agent = new Agent({
      name: 'StreamingInvalidArgumentStateAgent',
      model,
      tools: [
        tool({
          name: 'test',
          description: 'Validate structured input.',
          parameters: z.object({ test: z.string() }),
          outputSchema: z.object({ status: z.string() }),
          errorFunction: null,
          execute: async () => ({ status: 'unexpected' }),
        }),
      ],
    });

    const result = await run(agent, 'start', { stream: true });
    const error = await result.completed.catch((caught) => caught);

    expect(error).toBeInstanceOf(ToolCallError);
    const toolCallError = error as ToolCallError;
    expect(toolCallError.state).toBeUndefined();
    expect(toolCallError.error).toBeInstanceOf(InvalidToolInputError);
    const inputError = toolCallError.error as InvalidToolInputError;
    expect(inputError.state).toBeUndefined();
    expect(inputError.originalError).toBeUndefined();
    expect(inputError.toolInvocation).toBeUndefined();
    expect(JSON.stringify(toolCallError)).not.toContain(secret);
  });

  it('detaches abort listeners after streaming completion when signal is retained', async () => {
    const agent = new Agent({
      name: 'AbortDetach',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    });

    const result = await run(agent, 'hi', { stream: true });
    const signal = result._getAbortSignal();

    expect(signal).toBeDefined();
    if (!signal) {
      throw new Error('Expected an abort signal.');
    }
    const retainedSignals = [signal];

    await result.completed;

    expect(getEventListeners(retainedSignals[0], 'abort').length).toBe(0);
  });

  it('reconciles streamed function calls on abort with conversationId', async () => {
    const model = new AbortAfterStreamedFunctionCallModel('resp-aborted');
    const agent = new Agent({ name: 'AbortReconcile', model });

    const result = await run(agent, 'hi', {
      stream: true,
      conversationId: 'conv-abort',
    });

    await result.completed;

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].conversationId).toBe('conv-abort');
    expect(model.requests[1].signal).toBeUndefined();
    expect(getRequestInputItems(model.requests[1])).toEqual([
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'call_abort',
        name: 'slow_tool',
        status: 'incomplete',
        output: { type: 'text', text: 'aborted' },
      }),
    ]);
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'redacts abort reconciliation failures when model=%s or tool=%s logging is disabled',
    async (dontLogModelData, dontLogToolData) => {
      const secret = 'SECRET_ABORT_RECONCILIATION_123';
      const model = new FailingAbortReconciliationModel(
        'resp-aborted',
        new Error(secret),
      );
      const agent = new Agent({ name: 'AbortReconcileFailure', model });
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(
        dontLogToolData,
      );

      const result = await run(agent, 'hi', {
        stream: true,
        conversationId: 'conv-abort-failure',
      });

      await expect(result.completed).resolves.toBeUndefined();
      expect(model.requests).toHaveLength(2);
      expect(debugSpy).toHaveBeenCalledWith(
        'Failed to reconcile streamed tool calls after abort.',
        'object',
      );
      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
    },
  );

  it('uses the streamed response id when reconciling previousResponseId-only aborts', async () => {
    const model = new AbortAfterStreamedFunctionCallModel('resp-aborted');
    const agent = new Agent({ name: 'AbortPreviousResponse', model });

    const result = await run(agent, 'hi', {
      stream: true,
      previousResponseId: 'resp-before-abort',
    });

    await result.completed;

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].conversationId).toBeUndefined();
    expect(model.requests[1].previousResponseId).toBe('resp-aborted');
    expect(getRequestInputItems(model.requests[1])[0]).toMatchObject({
      type: 'function_call_result',
      callId: 'call_abort',
      status: 'incomplete',
    });
  });

  it('reconciles streamed programs without outputs on abort', async () => {
    const model = new AbortAfterStreamedProgramModel('resp-aborted');
    const agent = new Agent({ name: 'AbortProgram', model });

    const result = await run(agent, 'hi', {
      stream: true,
      conversationId: 'conv-program-abort',
    });

    await result.completed;

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].conversationId).toBe('conv-program-abort');
    expect(getRequestInputItems(model.requests[1])).toEqual([
      expect.objectContaining({
        type: 'program_output',
        id: expect.stringMatching(/^prog_out_[0-9a-f]{32}$/),
        callId: 'call_prog_abort',
        status: 'incomplete',
        output: 'aborted',
      }),
    ]);
  });

  it('reconciles program-owned shell and apply_patch calls on abort', async () => {
    const model = new AbortAfterStreamedProgramToolCallsModel();
    const agent = new Agent({ name: 'AbortProgramTools', model });

    const result = await run(agent, 'hi', {
      stream: true,
      conversationId: 'conv-program-tools-abort',
    });

    await result.completed;

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].conversationId).toBe('conv-program-tools-abort');
    expect(getRequestInputItems(model.requests[1])).toEqual([
      {
        type: 'shell_call_output',
        callId: 'call_shell_abort',
        status: 'incomplete',
        output: [
          {
            stdout: '',
            stderr: 'aborted',
            outcome: { type: 'timeout' },
          },
        ],
        caller: { type: 'program', callerId: 'call_prog_abort' },
      },
      {
        type: 'apply_patch_call_output',
        callId: 'call_patch_abort',
        status: 'failed',
        output: 'aborted',
        caller: { type: 'program', callerId: 'call_prog_abort' },
      },
      expect.objectContaining({
        type: 'program_output',
        callId: 'call_prog_abort',
        status: 'incomplete',
        output: 'aborted',
      }),
    ]);
  });

  it('emits agent_updated_stream_event with new agent on handoff', async () => {
    const agentB = new Agent({
      name: 'B',
      model: new ScriptedModel([
        terminalModelStream(
          { output: [fakeModelMessage('done B')], usage: new Usage() },
          'r',
        ),
      ]),
    });

    const callItem: FunctionCallItem = {
      id: 'h1',
      type: 'function_call',
      name: handoff(agentB).toolName,
      callId: 'c1',
      status: 'completed',
      arguments: '{}',
    };

    const agentA = new Agent({
      name: 'A',
      model: new ScriptedModel([
        terminalModelStream({ output: [callItem], usage: new Usage() }, 'r'),
      ]),
      handoffs: [handoff(agentB)],
    });

    const result = await run(agentA, 'hi', { stream: true });
    const events: RunStreamEvent[] = [];
    for await (const e of result.toStream()) {
      events.push(e);
    }
    await result.completed;

    const update = events.find(
      (e): e is RunAgentUpdatedStreamEvent =>
        e.type === 'agent_updated_stream_event',
    );
    expect(update?.agent).toBe(agentB);
  });

  it('streams only the accepted handoff when multiple handoffs are emitted', async () => {
    const agentB = new Agent({
      name: 'B',
      model: new ScriptedModel([
        terminalModelStream(
          { output: [fakeModelMessage('done B')], usage: new Usage() },
          'r',
        ),
      ]),
    });
    const agentC = new Agent({
      name: 'C',
      model: new ScriptedModel([
        terminalModelStream(
          { output: [fakeModelMessage('done C')], usage: new Usage() },
          'r',
        ),
      ]),
    });
    const handoffToB = handoff(agentB);
    const handoffToC = handoff(agentC);
    const acceptedCall: FunctionCallItem = {
      id: 'h1',
      type: 'function_call',
      name: handoffToB.toolName,
      callId: 'c1',
      status: 'completed',
      arguments: '{}',
    };
    const ignoredCall: FunctionCallItem = {
      id: 'h2',
      type: 'function_call',
      name: handoffToC.toolName,
      callId: 'c2',
      status: 'completed',
      arguments: '{}',
    };
    const agentA = new Agent({
      name: 'A',
      model: new ScriptedModel([
        terminalModelStream(
          { output: [acceptedCall, ignoredCall], usage: new Usage() },
          'r',
        ),
      ]),
      handoffs: [handoffToB, handoffToC],
    });

    const result = await run(agentA, 'hi', { stream: true });
    const events: RunStreamEvent[] = [];
    for await (const event of result.toStream()) {
      events.push(event);
    }
    await result.completed;

    const handoffRequested = events.filter(
      (event): event is RunItemStreamEvent =>
        event.type === 'run_item_stream_event' &&
        event.name === 'handoff_requested',
    );

    expect(handoffRequested).toHaveLength(1);
    expect((handoffRequested[0].item as any).rawItem.callId).toBe(
      acceptedCall.callId,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'run_item_stream_event' &&
          event.name === 'tool_output' &&
          (event.item as any).rawItem.callId === ignoredCall.callId,
      ),
    ).toBe(false);
    expect(
      result.history.some(
        (item) => (item as { callId?: string }).callId === ignoredCall.callId,
      ),
    ).toBe(false);
  });

  it('emits agent_end lifecycle event for streaming agents', async () => {
    const agent = new Agent({
      name: 'TestAgent',
      model: new ScriptedModel([
        terminalModelStream(
          { output: [fakeModelMessage('Final output')], usage: new Usage() },
          'r',
        ),
      ]),
    });

    // Track agent_end events on both the agent and runner
    const agentEndEvents: Array<{ context: any; output: string }> = [];
    const runnerEndEvents: Array<{ context: any; agent: any; output: string }> =
      [];

    agent.on('agent_end', (context, output) => {
      agentEndEvents.push({ context, output });
    });

    // Create a runner instance to listen for events
    const runner = new Runner();
    runner.on('agent_end', (context, agent, output) => {
      runnerEndEvents.push({ context, agent, output });
    });

    const result = await runner.run(agent, 'test input', { stream: true });

    // Consume the stream
    const events: RunStreamEvent[] = [];
    for await (const e of result.toStream()) {
      events.push(e);
    }
    await result.completed;

    // Verify agent_end was called on both agent and runner
    expect(agentEndEvents).toHaveLength(1);
    expect(agentEndEvents[0].output).toBe('Final output');

    expect(runnerEndEvents).toHaveLength(1);
    expect(runnerEndEvents[0].agent).toBe(agent);
    expect(runnerEndEvents[0].output).toBe('Final output');
  });

  it('emits turn input on agent_start during streaming runs', async () => {
    const agent = new Agent({
      name: 'StreamLifecycleAgent',
      model: new ScriptedModel([
        terminalModelStream(
          { output: [fakeModelMessage('Final output')], usage: new Usage() },
          'r_lifecycle',
        ),
      ]),
    });
    const runner = new Runner();

    const agentInputs: AgentInputItem[][] = [];
    const runnerInputs: AgentInputItem[][] = [];

    agent.on('agent_start', (_context, _agent, turnInput) => {
      agentInputs.push(turnInput ?? []);
    });
    runner.on('agent_start', (_context, _agent, turnInput) => {
      runnerInputs.push(turnInput ?? []);
    });

    const result = await runner.run(agent, 'stream this input', {
      stream: true,
    });

    // Drain the stream to ensure the run completes.
    for await (const _event of result.toStream()) {
      // no-op
    }
    await result.completed;

    expect(agentInputs).toHaveLength(1);
    expect(runnerInputs).toHaveLength(1);
    expect(agentInputs[0].map(getFirstTextContent)).toEqual([
      'stream this input',
    ]);
    expect(runnerInputs[0].map(getFirstTextContent)).toEqual([
      'stream this input',
    ]);
  });

  it('applies reasoningItemIdPolicy to follow-up streamed turn input', async () => {
    class RequestRecordingStreamingModel extends ScriptedModel {
      constructor() {
        super([
          parsedTerminalModelStream(
            {
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_stream',
                  content: [{ type: 'input_text', text: 'reasoning trace' }],
                } satisfies protocol.ReasoningItem,
                {
                  type: 'function_call',
                  id: 'fc_stream',
                  callId: 'call_stream',
                  name: 'echo_tool',
                  status: 'completed',
                  arguments: '{}',
                } satisfies protocol.FunctionCallItem,
              ],
              usage: new Usage(),
            },
            'stream_1',
          ),
          parsedTerminalModelStream(
            {
              output: [fakeModelMessage('stream done')],
              usage: new Usage(),
            },
            'stream_2',
          ),
        ]);
      }

      get requests(): readonly Readonly<ModelRequest>[] {
        return this.calls.map((call) => call.request);
      }
    }

    const model = new RequestRecordingStreamingModel();
    const echoTool = tool({
      name: 'echo_tool',
      description: 'Echoes a static payload.',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const agent = new Agent({
      name: 'StreamingReasoningPolicyAgent',
      model,
      tools: [echoTool],
    });
    const runner = new Runner();

    const result = await runner.run(agent, 'hello', {
      stream: true,
      reasoningItemIdPolicy: 'omit',
    });
    for await (const _event of result.toStream()) {
      // Drain the stream.
    }
    await result.completed;

    expect(model.requests).toHaveLength(2);
    const secondRequestReasoning = getRequestInputItems(model.requests[1]).find(
      (item): item is protocol.ReasoningItem => item.type === 'reasoning',
    );
    expect(secondRequestReasoning).toBeDefined();
    expect(secondRequestReasoning).not.toHaveProperty('id');
  });

  it('updates cumulative usage during streaming responses', async () => {
    const testTool = tool({
      name: 'calculator',
      description: 'Does math',
      parameters: z.object({ value: z.number() }),
      execute: async ({ value }) => `result: ${value * 2}`,
    });

    const firstResponse: ModelResponse = {
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          callId: 'call_1',
          name: 'calculator',
          status: 'completed',
          arguments: JSON.stringify({ value: 5 }),
        } as protocol.FunctionCallItem,
      ],
      usage: new Usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    };

    const secondResponse: ModelResponse = {
      output: [fakeModelMessage('The answer is 10')],
      usage: new Usage({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
    };

    const agent = new Agent({
      name: 'UsageTracker',
      model: new ScriptedModel([
        terminalModelStream(firstResponse, 'r_1'),
        terminalModelStream(secondResponse, 'r_2'),
      ]),
      tools: [testTool],
    });

    const runner = new Runner();
    const result = await runner.run(agent, 'calculate', { stream: true });

    const totals: number[] = [];
    for await (const event of result.toStream()) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'response_done'
      ) {
        totals.push(result.state.usage.totalTokens);
      }
    }
    await result.completed;

    expect(totals).toEqual([15, 45]);
    expect(result.state.usage.inputTokens).toBe(30);
    expect(result.state.usage.outputTokens).toBe(15);
    expect(result.state.usage.requestUsageEntries?.length).toBe(2);
    expect(result.finalOutput).toBe('The answer is 10');
  });

  it('allows aborting a stream based on cumulative usage', async () => {
    const testTool = tool({
      name: 'expensive',
      description: 'Uses lots of tokens',
      parameters: z.object({}),
      execute: async () => 'expensive result',
    });

    const responses: ModelResponse[] = [
      {
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            callId: 'call_1',
            name: 'expensive',
            status: 'completed',
            arguments: '{}',
          } as protocol.FunctionCallItem,
        ],
        usage: new Usage({
          inputTokens: 5000,
          outputTokens: 2000,
          totalTokens: 7000,
        }),
      },
      {
        output: [fakeModelMessage('continuing...')],
        usage: new Usage({
          inputTokens: 6000,
          outputTokens: 3000,
          totalTokens: 9000,
        }),
      },
    ];

    const agent = new Agent({
      name: 'ExpensiveAgent',
      model: new ScriptedModel(
        responses.map((response, index) =>
          terminalModelStream(response, `r_${index + 1}`),
        ),
      ),
      tools: [testTool],
    });

    const runner = new Runner();
    const result = await runner.run(agent, 'do expensive work', {
      stream: true,
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const MAX_TOKENS = 10_000;
    let aborted = false;

    for await (const event of result.toStream()) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'response_done' &&
        result.state.usage.totalTokens > MAX_TOKENS
      ) {
        aborted = true;
        break;
      }
    }

    expect(aborted).toBe(true);
    expect(result.state.usage.totalTokens).toBe(16_000);
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );
    warnSpy.mockRestore();
  });

  it('cancels streaming promptly when the consumer cancels the stream', async () => {
    const waitWithAbort = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          clearTimeout(timer);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });

    const agent = new Agent({
      name: 'SlowStream',
      model: new ScriptedModel([
        modelStreamResponder((call) =>
          (async function* () {
            yield { type: 'output_text_delta', delta: 'hello' } as StreamEvent;
            await waitWithAbort(400, call.request.signal);
            yield {
              type: 'response_done',
              response: {
                id: 'delayed',
                usage: {
                  requests: 1,
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                },
                output: [fakeModelMessage('final')],
              },
            } as StreamEvent;
          })(),
        ),
      ]),
    });

    const result = await run(agent, 'go', { stream: true });
    const stream = result.toStream() as any;
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);

    const start = Date.now();
    const cancelPromise = reader.cancel('timeout');

    await expect(result.completed).resolves.toBeUndefined();
    await cancelPromise;

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(250);
    expect(result.cancelled).toBe(true);
    expect(result.error).toBe(null);
  });

  it('waits for the background run loop after cancellation', async () => {
    let markAbortObserved: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve;
    });
    let releaseModel: (() => void) | undefined;
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });

    const agent = new Agent({
      name: 'SettlingStream',
      model: new ScriptedModel([
        modelStreamResponder((call) =>
          (async function* () {
            yield {
              type: 'output_text_delta',
              delta: 'hello',
            } as StreamEvent;
            const signal = call.request.signal;
            if (!signal) {
              throw new Error('Expected an abort signal');
            }
            if (!signal.aborted) {
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
              });
            }
            markAbortObserved?.();
            await modelReleased;
            const error = new Error('Aborted');
            error.name = 'AbortError';
            throw error;
          })(),
        ),
      ]),
    });
    const result = await run(agent, 'go', { stream: true });
    const reader = (result.toStream() as any).getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel('stop');
    await abortObserved;

    let completedSettled = false;
    void result.completed.then(() => {
      completedSettled = true;
    });
    await Promise.resolve();

    expect(completedSettled).toBe(false);

    releaseModel?.();
    await expect(result.completed).resolves.toBeUndefined();
    expect(result.cancelled).toBe(true);
    expect(result.error).toBe(null);
  });

  it('marks inputs as sent when aborted before first stream event in server-managed conversations', async () => {
    const waitWithAbort = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          clearTimeout(timer);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });

    let streamStarted: (() => void) | undefined;
    const streamStartedPromise = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });

    const markSpy = vi.spyOn(
      ServerConversationTracker.prototype,
      'markInputAsSent',
    );

    const agent = new Agent({
      name: 'AbortBeforeFirstEvent',
      model: new ScriptedModel([
        modelStreamResponder((call) =>
          (async function* () {
            streamStarted?.();
            await waitWithAbort(500, call.request.signal);
            yield {
              type: 'response_done',
              response: {
                id: 'resp-delayed',
                usage: {
                  requests: 1,
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                },
                output: [fakeModelMessage('should not reach')],
              },
            } as StreamEvent;
          })(),
        ),
      ]),
    });
    const runner = new Runner();

    const result = await runner.run(agent, 'initial', {
      stream: true,
      conversationId: 'conv-abort-before-event',
    });

    await streamStartedPromise;
    const reader = (result.toStream() as any).getReader();
    await reader.cancel('stop');
    await expect(result.completed).resolves.toBeUndefined();

    expect(markSpy).toHaveBeenCalledTimes(1);
    const [sourceItems] = markSpy.mock.calls[0];
    expect(Array.isArray(sourceItems)).toBe(true);

    markSpy.mockRestore();
  });

  it('streams tool_called before the tool finishes executing', async () => {
    let releaseTool: (() => void) | undefined;
    const toolExecuted = vi.fn();

    const blockingTool = tool({
      name: 'blocker',
      description: 'blocks until released',
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }) => {
        toolExecuted(value);
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        return `result:${value}`;
      },
    });

    const functionCall: FunctionCallItem = {
      id: 'call-1',
      type: 'function_call',
      name: blockingTool.name,
      callId: 'c1',
      status: 'completed',
      arguments: JSON.stringify({ value: 'test' }),
    };

    const toolResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    const finalMessageResponse: ModelResponse = {
      output: [fakeModelMessage('done')],
      usage: new Usage(),
    };

    const agent = new Agent({
      name: 'BlockingAgent',
      model: new ScriptedModel([
        terminalModelStream(toolResponse, 'resp-0'),
        terminalModelStream(finalMessageResponse, 'resp-1'),
      ]),
      tools: [blockingTool],
    });

    const runner = new Runner();
    const result = await runner.run(agent, 'hello', { stream: true });
    const iterator = result.toStream()[Symbol.asyncIterator]();

    const collected: RunStreamEvent[] = [];
    const firstRunItemPromise: Promise<RunItemStreamEvent> = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error('Stream ended before emitting a run item event');
        }
        collected.push(next.value);
        if (next.value.type === 'run_item_stream_event') {
          return next.value;
        }
      }
    })();

    let firstRunItemResolved = false;
    void firstRunItemPromise.then(() => {
      firstRunItemResolved = true;
    });

    // Allow the tool execution to start.
    await new Promise((resolve) => setImmediate(resolve));

    expect(toolExecuted).toHaveBeenCalledWith('test');
    expect(releaseTool).toBeDefined();
    expect(firstRunItemResolved).toBe(true);

    const firstRunItem = await firstRunItemPromise;
    expect(firstRunItem.name).toBe('tool_called');

    releaseTool?.();

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      collected.push(next.value);
    }

    await result.completed;

    const toolCalledIndex = collected.findIndex(
      (event) =>
        event.type === 'run_item_stream_event' && event.name === 'tool_called',
    );
    const toolOutputIndex = collected.findIndex(
      (event) =>
        event.type === 'run_item_stream_event' && event.name === 'tool_output',
    );

    expect(toolCalledIndex).toBeGreaterThan(-1);
    expect(toolOutputIndex).toBeGreaterThan(-1);
    expect(toolCalledIndex).toBeLessThan(toolOutputIndex);
  });

  it('settles a cancelled function tool without starting another model turn', async () => {
    let markToolStarted: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    let toolSignal: AbortSignal | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolCanFinish = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const abortableTool = tool({
      name: 'test',
      description: 'waits for the streamed run to be cancelled',
      parameters: z.object({ test: z.string() }),
      execute: async (_input, _context, details) => {
        toolSignal = details?.signal;
        markToolStarted?.();
        if (!toolSignal?.aborted) {
          await Promise.race([
            toolCanFinish,
            new Promise<void>((resolve) => {
              toolSignal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            }),
          ]);
        }
        return 'cancelled';
      },
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'AbortableToolStreamAgent',
      model,
      tools: [abortableTool],
    });
    const result = await run(agent, 'start', {
      stream: true,
      maxTurns: 1,
    });
    const reader = (result.toStream() as any).getReader();

    await toolStarted;
    await reader.cancel('stop');
    releaseTool?.();
    await result.completed;

    expect(result.cancelled).toBe(true);
    expect(toolSignal?.aborted).toBe(true);
    expect(model.callCount).toBe(1);
    expect(result.state._currentTurnInProgress).toBe(false);
    expect(
      result.state._generatedItems.some(
        (item) =>
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.status === 'completed',
      ),
    ).toBe(true);

    const resumed = await run(agent, result.state, { stream: true });
    await expect(resumed.completed).rejects.toBeInstanceOf(
      MaxTurnsExceededError,
    );
    expect(model.callCount).toBe(1);
  });

  it('atomically finalizes a completed tool output after cancellation', async () => {
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();
    let markToolStarted: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolCanFinish = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const execute = vi.fn(async (_input, _context, details) => {
      markToolStarted?.();
      const signal = details?.signal as AbortSignal | undefined;
      if (!signal?.aborted) {
        await Promise.race([
          toolCanFinish,
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
      return 'settled after cancellation';
    });
    const finalTool = tool({
      name: 'test',
      description: 'returns the final output after cancellation',
      parameters: z.object({ test: z.string() }),
      execute,
    });
    const guardrail = {
      name: 'allow-final-output',
      execute: vi.fn().mockResolvedValue({
        tripwireTriggered: false,
        outputInfo: { safe: true },
      }),
    };
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'CancelledFinalToolStreamAgent',
      model,
      tools: [finalTool],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [guardrail],
    });
    const runner = new Runner();
    const agentEnd = vi.fn();
    runner.on('agent_end', agentEnd);
    const session = createSessionMock();
    const cancelled = await runner.run(agent, 'start', {
      stream: true,
      session,
    });
    const reader = (cancelled.toStream() as any).getReader();

    await toolStarted;
    await reader.cancel('stop');
    releaseTool?.();
    await cancelled.completed;

    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.finalOutput).toBe('settled after cancellation');
    expect(cancelled.state._currentStep).toEqual({
      type: 'next_step_final_output',
      output: 'settled after cancellation',
    });
    expect(cancelled.state._currentTurnInProgress).toBe(false);
    expect(model.callCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
  });

  it('atomically finalizes a completed resumed tool after cancellation', async () => {
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();
    let markToolStarted: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolCanFinish = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const execute = vi.fn(async (_input, _context, details) => {
      markToolStarted?.();
      const signal = details?.signal as AbortSignal | undefined;
      if (!signal?.aborted) {
        await Promise.race([
          toolCanFinish,
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
      return 'cancelled';
    });
    const abortableTool = tool({
      name: 'test',
      description: 'waits for the resumed stream to be cancelled',
      parameters: z.object({ test: z.string() }),
      needsApproval: true,
      execute,
    });
    const guardrail = {
      name: 'allow-resumed-final-output',
      execute: vi.fn().mockResolvedValue({
        tripwireTriggered: false,
        outputInfo: { safe: true },
      }),
    };
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'ResumedAbortableToolStreamAgent',
      model,
      tools: [abortableTool],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [guardrail],
    });
    const runner = new Runner();
    const agentEnd = vi.fn();
    runner.on('agent_end', agentEnd);
    const session = createSessionMock();
    const interrupted = await runner.run(agent, 'start', {
      stream: true,
      session,
    });
    for await (const _event of interrupted) {
      // Drain the interrupted run.
    }
    interrupted.state.approve(interrupted.interruptions[0]);

    const resumed = await runner.run(agent, interrupted.state, {
      stream: true,
      session,
    });
    const reader = (resumed.toStream() as any).getReader();

    await toolStarted;
    await reader.cancel('stop');
    releaseTool?.();
    await resumed.completed;

    expect(resumed.cancelled).toBe(true);
    expect(model.callCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.state._currentStep).toEqual({
      type: 'next_step_final_output',
      output: 'cancelled',
    });
    expect(resumed.state._currentTurnInProgress).toBe(false);
    expect(resumed.finalOutput).toBe('cancelled');
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).toHaveBeenCalledTimes(2);
    expect(saveResultSpy.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({
        compactionMode: 'input',
      }),
    );
    expect(guardrail.execute.mock.invocationCallOrder[0]).toBeLessThan(
      saveResultSpy.mock.invocationCallOrder[1]!,
    );
    expect(agentEnd).toHaveBeenCalledTimes(1);
    expect(
      resumed.state._generatedItems.some(
        (item) =>
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.status === 'completed',
      ),
    ).toBe(true);
  });

  it('finishes finalization once output guardrails have started', async () => {
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();
    let markGuardrailStarted: (() => void) | undefined;
    let releaseGuardrail: (() => void) | undefined;
    const guardrailStarted = new Promise<void>((resolve) => {
      markGuardrailStarted = resolve;
    });
    const guardrailCanFinish = new Promise<void>((resolve) => {
      releaseGuardrail = resolve;
    });
    const guardrail = {
      name: 'delayed-final-output-guardrail',
      execute: vi.fn(async () => {
        markGuardrailStarted?.();
        await guardrailCanFinish;
        return {
          tripwireTriggered: false,
          outputInfo: { safe: true },
        };
      }),
    };
    const execute = vi.fn(async () => 'guarded output');
    const finalTool = tool({
      name: 'test',
      description: 'returns output guarded before finalization',
      parameters: z.object({ test: z.string() }),
      execute,
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'CancelDuringOutputGuardrailAgent',
      model,
      tools: [finalTool],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [guardrail],
    });
    const runner = new Runner();
    const agentEnd = vi.fn();
    runner.on('agent_end', agentEnd);
    const session = createSessionMock();
    const cancelled = await runner.run(agent, 'start', {
      stream: true,
      session,
    });
    const reader = (cancelled.toStream() as any).getReader();

    await guardrailStarted;
    await reader.cancel('stop');
    releaseGuardrail?.();
    await cancelled.completed;

    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.state._currentStep).toEqual({
      type: 'next_step_final_output',
      output: 'guarded output',
    });
    expect(cancelled.finalOutput).toBe('guarded output');
    expect(cancelled.state._currentTurnInProgress).toBe(false);
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
    expect(model.callCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
  });

  it('finishes finalization when cancellation arrives during persistence', async () => {
    let markPersistenceStarted: (() => void) | undefined;
    let releasePersistence: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceCanFinish = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockImplementation(async () => {
        markPersistenceStarted?.();
        await persistenceCanFinish;
      });
    const finalTool = tool({
      name: 'test',
      description: 'returns output before persistence',
      parameters: z.object({ test: z.string() }),
      execute: async () => 'persisted output',
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'CancelDuringFinalPersistenceAgent',
      model,
      tools: [finalTool],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const runner = new Runner();
    const agentEnd = vi.fn();
    runner.on('agent_end', agentEnd);
    const result = await runner.run(agent, 'start', {
      stream: true,
      session: createSessionMock(),
    });
    const reader = (result.toStream() as any).getReader();

    await persistenceStarted;
    await reader.cancel('stop');
    releasePersistence?.();
    await result.completed;

    expect(result.cancelled).toBe(true);
    expect(result.finalOutput).toBe('persisted output');
    expect(result.state._currentTurnInProgress).toBe(false);
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
  });

  it('records a cancelled streaming agent tool as incomplete', async () => {
    let markNestedModelStarted: (() => void) | undefined;
    const nestedModelStarted = new Promise<void>((resolve) => {
      markNestedModelStarted = resolve;
    });
    const nestedModel = new ScriptedModel([
      modelStreamResponder((call) =>
        (async function* () {
          markNestedModelStarted?.();
          const signal = call.request.signal;
          if (!signal) {
            throw new Error('Expected nested model abort signal');
          }
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
          signal.throwIfAborted();
          yield {
            type: 'response_done',
            response: {
              id: 'unexpected-nested-response',
              usage: {
                requests: 1,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
              output: [fakeModelMessage('unexpected nested completion')],
            },
          } as StreamEvent;
        })(),
      ),
    ]);
    const nestedAgent = new Agent({
      name: 'NestedStreamingAgent',
      model: nestedModel,
    });
    const nestedTool = nestedAgent.asTool({
      toolName: 'test',
      toolDescription: 'runs a nested streaming agent',
      parameters: z.object({ test: z.string() }),
      inputBuilder: ({ params }) => params.test,
      onStream: () => {},
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'ParentStreamingAgent',
      model,
      tools: [nestedTool],
    });
    const cancelled = await run(agent, 'start', { stream: true });
    const reader = (cancelled.toStream() as any).getReader();

    await nestedModelStarted;
    await reader.cancel('stop');
    await cancelled.completed;

    expect(cancelled.cancelled).toBe(true);
    expect(model.callCount).toBe(1);
    expect(
      cancelled.state._generatedItems.find(
        (item) => item.rawItem.type === 'function_call_result',
      )?.rawItem,
    ).toMatchObject({
      type: 'function_call_result',
      callId: TEST_MODEL_FUNCTION_CALL.callId,
      status: 'incomplete',
      output: { type: 'text', text: 'aborted' },
    });
    expect(
      cancelled.state.hasPendingAgentToolRun(
        nestedTool.name,
        TEST_MODEL_FUNCTION_CALL.callId,
      ),
    ).toBe(false);

    const resumed = await run(agent, cancelled.state, { stream: true });
    for await (const _event of resumed) {
      // Drain the resumed run.
    }

    expect(resumed.finalOutput).toBe('done');
    expect(model.callCount).toBe(2);
  });

  it('preserves a nested agent output committed during cancellation', async () => {
    let markGuardrailStarted: (() => void) | undefined;
    let releaseGuardrail: (() => void) | undefined;
    const guardrailStarted = new Promise<void>((resolve) => {
      markGuardrailStarted = resolve;
    });
    const guardrailCanFinish = new Promise<void>((resolve) => {
      releaseGuardrail = resolve;
    });
    const nestedGuardrail = {
      name: 'delayed-nested-output-guardrail',
      execute: vi.fn(async () => {
        markGuardrailStarted?.();
        await guardrailCanFinish;
        return {
          tripwireTriggered: false,
          outputInfo: { safe: true },
        };
      }),
    };
    const nestedModel = new ScriptedModel([
      terminalModelStream(
        {
          output: [fakeModelMessage('nested final output')],
          usage: new Usage(),
        },
        'nested-final-response',
      ),
    ]);
    const nestedAgent = new Agent({
      name: 'CommittedNestedStreamingAgent',
      model: nestedModel,
      outputGuardrails: [nestedGuardrail],
    });
    const nestedTool = nestedAgent.asTool({
      toolName: 'test',
      toolDescription: 'runs a nested streaming agent',
      parameters: z.object({ test: z.string() }),
      inputBuilder: ({ params }) => params.test,
      onStream: () => {},
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'ParentOfCommittedNestedAgent',
      model,
      tools: [nestedTool],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const result = await run(agent, 'start', { stream: true });
    const reader = (result.toStream() as any).getReader();

    await guardrailStarted;
    await reader.cancel('stop');
    releaseGuardrail?.();
    await result.completed;

    expect(result.cancelled).toBe(true);
    expect(result.finalOutput).toBe('nested final output');
    expect(nestedGuardrail.execute).toHaveBeenCalledTimes(1);
    expect(
      result.state._generatedItems.find(
        (item) => item.rawItem.type === 'function_call_result',
      )?.rawItem,
    ).toMatchObject({
      type: 'function_call_result',
      callId: TEST_MODEL_FUNCTION_CALL.callId,
      status: 'completed',
      output: { type: 'text', text: 'nested final output' },
    });
  });

  it('preserves a nested approval committed during cancellation', async () => {
    let markPersistenceStarted: (() => void) | undefined;
    let releasePersistence: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceCanFinish = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let blockedNestedPersistence = false;
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockImplementation(async (_session, nestedResult) => {
        if (
          !blockedNestedPersistence &&
          nestedResult.state._currentStep?.type === 'next_step_interruption'
        ) {
          blockedNestedPersistence = true;
          markPersistenceStarted?.();
          await persistenceCanFinish;
        }
      });
    const approvalTool = tool({
      name: 'test',
      description: 'requires approval in the nested agent',
      parameters: z.object({ test: z.string() }),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const nestedModel = new CountingFunctionToolStreamModel();
    const nestedAgent = new Agent({
      name: 'NestedApprovalAgent',
      model: nestedModel,
      tools: [approvalTool],
    });
    const nestedSession = createSessionMock();
    const nestedTool = nestedAgent.asTool({
      toolName: 'test',
      toolDescription: 'runs a nested agent that requires approval',
      parameters: z.object({ test: z.string() }),
      inputBuilder: ({ params }) => params.test,
      onStream: () => {},
      runOptions: { session: nestedSession },
    });
    const outerModel = new CountingFunctionToolStreamModel();
    const outerAgent = new Agent({
      name: 'ParentOfNestedApprovalAgent',
      model: outerModel,
      tools: [nestedTool],
    });
    const runner = new Runner();
    const cancelled = await runner.run(outerAgent, 'start', { stream: true });
    const reader = (cancelled.toStream() as any).getReader();

    await persistenceStarted;
    await reader.cancel('stop');
    releasePersistence?.();
    await cancelled.completed;

    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.interruptions).toHaveLength(1);
    expect(cancelled.interruptions[0]?.agent).toBe(nestedAgent);
    expect(
      cancelled.state.hasPendingAgentToolRun(
        nestedTool.name,
        TEST_MODEL_FUNCTION_CALL.callId,
      ),
    ).toBe(true);
    expect(
      saveResultSpy.mock.calls.filter(([session]) => session === nestedSession),
    ).toHaveLength(1);

    cancelled.state.approve(cancelled.interruptions[0]);
    const resumed = await runner.run(outerAgent, cancelled.state, {
      stream: true,
    });
    for await (const _event of resumed) {
      // Drain the resumed run.
    }

    expect(resumed.finalOutput).toBe('done');
    expect(
      resumed.state.hasPendingAgentToolRun(
        nestedTool.name,
        TEST_MODEL_FUNCTION_CALL.callId,
      ),
    ).toBe(false);
    expect(nestedModel.callCount).toBe(2);
    expect(outerModel.callCount).toBe(2);
  });

  it('does not call the model when cancelled during next-turn preparation', async () => {
    let filterCalls = 0;
    let markNextTurnPreparationStarted: (() => void) | undefined;
    let finishNextTurnPreparation: (() => void) | undefined;
    const nextTurnPreparationStarted = new Promise<void>((resolve) => {
      markNextTurnPreparationStarted = resolve;
    });
    const nextTurnPreparationCanFinish = new Promise<void>((resolve) => {
      finishNextTurnPreparation = resolve;
    });
    const testTool = tool({
      name: 'test',
      description: 'completes before the next model turn',
      parameters: z.object({ test: z.string() }),
      execute: async () => 'completed',
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'CancelDuringPreparationAgent',
      model,
      tools: [testTool],
    });
    const runner = new Runner({
      callModelInputFilter: async ({ modelData }) => {
        filterCalls += 1;
        if (filterCalls === 2) {
          markNextTurnPreparationStarted?.();
          await nextTurnPreparationCanFinish;
        }
        return modelData;
      },
    });
    const result = await runner.run(agent, 'start', { stream: true });
    const reader = (result.toStream() as any).getReader();

    await nextTurnPreparationStarted;
    await reader.cancel('stop');
    finishNextTurnPreparation?.();
    await result.completed;

    expect(result.cancelled).toBe(true);
    expect(model.callCount).toBe(1);
    expect(result.currentTurn).toBe(1);
    expect(result.state._currentTurn).toBe(1);
  });

  it('does not call the model when a resumed turn is cancelled during preparation', async () => {
    let markToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const testTool = tool({
      name: 'test',
      description: 'settles after cancellation',
      parameters: z.object({ test: z.string() }),
      execute: async (_input, _context, details) => {
        markToolStarted?.();
        const signal = details?.signal;
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return 'completed';
      },
    });
    const model = new CountingFunctionToolStreamModel();
    const agent = new Agent({
      name: 'CancelDuringResumedPreparationAgent',
      model,
      tools: [testTool],
    });
    const first = await run(agent, 'start', { stream: true });
    const firstReader = (first.toStream() as any).getReader();

    await toolStarted;
    await firstReader.cancel('stop');
    await first.completed;

    expect(first.state._currentStep?.type).toBe('next_step_run_again');
    expect(first.state._currentTurnInProgress).toBe(false);

    let markPreparationStarted: (() => void) | undefined;
    let releasePreparation: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    const preparationCanFinish = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const runner = new Runner({
      callModelInputFilter: async ({ modelData }) => {
        markPreparationStarted?.();
        await preparationCanFinish;
        return modelData;
      },
    });
    const resumed = await runner.run(agent, first.state, { stream: true });
    const resumedReader = (resumed.toStream() as any).getReader();

    await preparationStarted;
    await resumedReader.cancel('stop');
    releasePreparation?.();
    await resumed.completed;

    expect(resumed.cancelled).toBe(true);
    expect(model.callCount).toBe(1);
    expect(resumed.currentTurn).toBe(1);
    expect(resumed.state._currentTurn).toBe(1);
  });

  it('enforces maxTurns across multiple streamed model calls', async () => {
    // Bug: After first model call, _lastTurnResponse is set, so turn counter never advances.
    // With maxTurns=1, we should only allow 1 model call, but currently allows 2.
    const testTool = tool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: z.object({}),
      execute: async () => 'result',
    });

    const firstResponse: ModelResponse = {
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          callId: 'call_1',
          name: 'test_tool',
          status: 'completed',
          arguments: '{}',
          providerData: {},
        } as protocol.FunctionCallItem,
      ],
      usage: new Usage(),
    };
    const secondResponse: ModelResponse = {
      output: [fakeModelMessage('second')],
      usage: new Usage(),
    };

    const agent = new Agent({
      name: 'StreamTurnCounter',
      model: new ScriptedModel([
        terminalModelStream(firstResponse, 'r_1'),
        terminalModelStream(secondResponse, 'r_2'),
      ]),
      tools: [testTool],
      toolUseBehavior: 'run_llm_again',
    });

    // With maxTurns=1, this should throw MaxTurnsExceededError after the first model call
    // Currently fails because turn counter doesn't advance after first call
    const result = await run(agent, 'hi', { stream: true, maxTurns: 1 });
    await expect(result.completed).rejects.toBeInstanceOf(
      MaxTurnsExceededError,
    );
    expect(result.currentTurn).toBe(1);
    expect(result.state._currentTurn).toBe(1);
  });

  it('does not enforce maxTurns for streamed runs when maxTurns is null', async () => {
    const testTool = tool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: z.object({}),
      execute: async () => 'result',
    });
    const responses: ModelResponse[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        output: [
          {
            type: 'function_call' as const,
            id: `fc_${index}`,
            callId: `call_${index}`,
            name: 'test_tool',
            status: 'completed' as const,
            arguments: '{}',
            providerData: {},
          } as protocol.FunctionCallItem,
        ],
        usage: new Usage(),
      })),
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ];

    const agent = new Agent({
      name: 'NoMaxTurnsStream',
      model: new ScriptedModel(
        responses.map((response, index) =>
          terminalModelStream(response, `r_${index + 1}`),
        ),
      ),
      tools: [testTool],
      toolUseBehavior: 'run_llm_again',
    });

    const result = await run(agent, 'hi', { stream: true, maxTurns: null });
    for await (const _event of result.toStream()) {
      // Consume stream.
    }
    await result.completed;

    expect(result.finalOutput).toBe('done');
    expect(result.maxTurns).toBeNull();
    expect(result.state._currentTurn).toBe(13);
  });

  it('handles maxTurns errors with an error handler', async () => {
    const agent = new Agent({
      name: 'MaxTurnsHandlerStream',
      model: new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('nope')],
          usage: new Usage(),
        }),
      ]),
    });
    const result = await run(agent, 'x', {
      stream: true,
      maxTurns: 0,
      errorHandlers: {
        maxTurns: () => ({
          finalOutput: 'summary',
        }),
      },
    });
    const events: RunStreamEvent[] = [];
    for await (const event of result.toStream()) {
      events.push(event);
    }
    await result.completed;
    expect(result.finalOutput).toBe('summary');
    const runItemEvents = events.filter(
      (event): event is RunItemStreamEvent =>
        event.type === 'run_item_stream_event',
    );
    expect(runItemEvents).toHaveLength(1);
    expect(runItemEvents[0].name).toBe('message_output_created');
    expect(runItemEvents[0].item).toBeInstanceOf(RunMessageOutputItem);
    if (runItemEvents[0].item instanceof RunMessageOutputItem) {
      expect(runItemEvents[0].item.content).toBe('summary');
    }
  });

  it('keeps an error-handler final output hidden while its guardrail is pending', async () => {
    let signalGuardrailStarted!: () => void;
    const guardrailStarted = new Promise<void>((resolve) => {
      signalGuardrailStarted = resolve;
    });
    let releaseGuardrail!: () => void;
    const guardrailResult = new Promise<GuardrailFunctionOutput>((resolve) => {
      releaseGuardrail = () =>
        resolve({
          tripwireTriggered: false,
          outputInfo: null,
        });
    });
    const agent = new Agent({
      name: 'Pending error-handler guardrail stream',
      model: new ScriptedModel([]),
      outputGuardrails: [
        {
          name: 'suspend error-handler output',
          execute: async () => {
            signalGuardrailStarted();
            return guardrailResult;
          },
        },
      ],
    });
    const result = await run(agent, 'x', {
      stream: true,
      maxTurns: 0,
      errorHandlers: {
        maxTurns: () => ({ finalOutput: 'guarded fallback' }),
      },
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await guardrailStarted;
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );

    releaseGuardrail();
    await result.completed;
    expect(result.finalOutput).toBe('guarded fallback');

    warnSpy.mockRestore();
  });

  it('handles model refusal errors with an error handler', async () => {
    const model = new ScriptedModel([
      terminalModelStream(
        {
          output: [fakeModelRefusal('I cannot help with that request.')],
          usage: new Usage(),
        },
        'r_refusal',
      ),
    ]);

    const agent = new Agent({
      name: 'RefusalHandlerStream',
      model,
    });
    const result = await run(agent, 'x', {
      stream: true,
      errorHandlers: {
        modelRefusal: ({ error }) => {
          expect(error).toBeInstanceOf(ModelRefusalError);
          return { finalOutput: 'safe fallback' };
        },
      },
    });
    const events: RunStreamEvent[] = [];
    for await (const event of result.toStream()) {
      events.push(event);
    }
    await result.completed;
    expect(result.finalOutput).toBe('safe fallback');
    const runItemEvents = events.filter(
      (event): event is RunItemStreamEvent =>
        event.type === 'run_item_stream_event',
    );
    expect(runItemEvents).toHaveLength(2);
    expect(runItemEvents[1].name).toBe('message_output_created');
    expect(runItemEvents[1].item).toBeInstanceOf(RunMessageOutputItem);
    if (runItemEvents[1].item instanceof RunMessageOutputItem) {
      expect(runItemEvents[1].item.content).toBe('safe fallback');
    }
  });

  it('handles invalid final output errors with an error handler', async () => {
    const model = new ScriptedModel([
      terminalModelStream(
        {
          output: [fakeModelMessage('not valid json')],
          usage: new Usage(),
        },
        'r_invalid_final_output',
      ),
    ]);

    const agent = new Agent({
      name: 'InvalidFinalOutputHandlerStream',
      outputType: z.object({ summary: z.string() }),
      model,
    });
    const result = await run(agent, 'x', {
      stream: true,
      errorHandlers: {
        invalidFinalOutput: () => ({
          finalOutput: { summary: 'safe fallback' },
        }),
      },
    });
    const events: RunStreamEvent[] = [];
    for await (const event of result.toStream()) {
      events.push(event);
    }
    await result.completed;

    expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
    const runItemEvents = events.filter(
      (event): event is RunItemStreamEvent =>
        event.type === 'run_item_stream_event',
    );
    expect(runItemEvents).toHaveLength(2);
    expect(runItemEvents[1].name).toBe('message_output_created');
    expect(runItemEvents[1].item).toBeInstanceOf(RunMessageOutputItem);
    if (runItemEvents[1].item instanceof RunMessageOutputItem) {
      expect(runItemEvents[1].item.content).toBe('{"summary":"safe fallback"}');
    }
  });

  it('does not advance the turn for streaming runs resuming an interruption without persisted items', async () => {
    const approvalTool = tool({
      name: 'get_weather',
      description: 'Gets weather for a city.',
      parameters: z.object({ city: z.string() }),
      needsApproval: async () => true,
      execute: async ({ city }) => `Weather in ${city}`,
    });

    const modelResponses: ModelResponse[] = [
      {
        output: [
          {
            type: 'function_call',
            id: 'fc_stream',
            callId: 'call_weather_stream',
            name: 'get_weather',
            status: 'completed',
            arguments: JSON.stringify({ city: 'Seattle' }),
            providerData: {},
          } as protocol.FunctionCallItem,
        ],
        usage: new Usage(),
      },
      { output: [fakeModelMessage('Stream done.')], usage: new Usage() },
    ];

    const agent = new Agent({
      name: 'ApprovalStreamResume',
      model: new ScriptedModel(
        modelResponses.map((response) =>
          terminalModelStream(response, 'approval-stream'),
        ),
      ),
      tools: [approvalTool],
      toolUseBehavior: 'run_llm_again',
    });

    let result = await run(agent, 'Stream weather?', {
      maxTurns: 1,
      stream: true,
    });

    for await (const _event of result.toStream()) {
      // Consume stream.
    }
    await result.completed;

    expect(result.interruptions).toHaveLength(1);
    expect(result.state._currentTurn).toBe(1);
    expect(result.state._currentTurnPersistedItemCount).toBe(0);

    result.state.approve(result.interruptions[0]);

    result = await run(agent, result.state, { maxTurns: 1, stream: true });

    for await (const _event of result.toStream()) {
      // Consume stream.
    }
    await result.completed;

    expect(result.finalOutput).toBe('Stream done.');
    expect(result.state._currentTurn).toBe(1);
  });

  it('emits run item events in the order items are generated', async () => {
    const sequenceTool = tool({
      name: 'report',
      description: 'Generate a report',
      parameters: z.object({}),
      execute: async () => 'report ready',
    });

    const functionCall: FunctionCallItem = {
      id: 'call-1',
      type: 'function_call',
      name: sequenceTool.name,
      callId: 'c1',
      status: 'completed',
      arguments: '{}',
    };

    const firstTurnResponse: ModelResponse = {
      output: [fakeModelMessage('Starting work'), functionCall],
      usage: new Usage(),
    };

    const secondTurnResponse: ModelResponse = {
      output: [fakeModelMessage('All done')],
      usage: new Usage(),
    };

    const agent = new Agent({
      name: 'SequencedAgent',
      model: new ScriptedModel([
        terminalModelStream(firstTurnResponse, 'resp-1'),
        terminalModelStream(secondTurnResponse, 'resp-2'),
      ]),
      tools: [sequenceTool],
    });

    const runner = new Runner();
    const result = await runner.run(agent, 'begin', { stream: true });

    const itemEventNames: string[] = [];
    for await (const event of result.toStream()) {
      if (event.type === 'run_item_stream_event') {
        itemEventNames.push(event.name);
      }
    }
    await result.completed;

    expect(itemEventNames).toEqual([
      'message_output_created',
      'tool_called',
      'tool_output',
      'message_output_created',
    ]);
  });

  describe('server-managed conversation state', () => {
    type Turn = { output: protocol.ModelItem[]; responseId?: string };

    class TrackingStreamingModel extends ScriptedModel {
      public requests: ModelRequest[];

      constructor(turns: Turn[]) {
        const requests: ModelRequest[] = [];
        super(
          turns.map((turn) =>
            modelStreamResponder((call) => {
              const recorded: ModelRequest = {
                ...call.request,
                input:
                  typeof call.request.input === 'string'
                    ? call.request.input
                    : (JSON.parse(
                        JSON.stringify(call.request.input),
                      ) as AgentInputItem[]),
              };
              requests.push(recorded);
              const responseId = turn.responseId ?? `resp-${requests.length}`;
              return [
                {
                  type: 'response_done',
                  response: {
                    id: responseId,
                    usage: {
                      requests: 1,
                      inputTokens: 0,
                      outputTokens: 0,
                      totalTokens: 0,
                    },
                    output: JSON.parse(
                      JSON.stringify(turn.output),
                    ) as protocol.ModelItem[],
                  },
                } as StreamEvent,
              ];
            }),
          ),
        );
        this.requests = requests;
      }

      get firstRequest(): ModelRequest | undefined {
        return this.requests[0];
      }

      get lastRequest(): ModelRequest | undefined {
        return this.requests.at(-1);
      }
    }

    const buildTurn = (
      items: protocol.ModelItem[],
      responseId?: string,
    ): Turn => ({
      output: JSON.parse(JSON.stringify(items)) as protocol.ModelItem[],
      responseId,
    });

    const buildToolCall = (callId: string, arg: string): FunctionCallItem => ({
      id: callId,
      type: 'function_call',
      name: 'test',
      callId,
      status: 'completed',
      arguments: JSON.stringify({ test: arg }),
    });

    const serverTool = tool({
      name: 'test',
      description: 'test tool',
      parameters: z.object({ test: z.string() }),
      execute: async ({ test }) => `result:${test}`,
    });

    async function drain<TOutput, TAgent extends Agent<any, any>>(
      result: StreamedRunResult<TOutput, TAgent>,
    ) {
      for await (const _ of result.toStream()) {
        // drain
      }
      await result.completed;
    }

    it('only sends new items when using conversationId across turns', async () => {
      const model = new TrackingStreamingModel([
        buildTurn(
          [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
          'resp-1',
        ),
        buildTurn(
          [fakeModelMessage('b_message'), buildToolCall('call-2', 'bar')],
          'resp-2',
        ),
        buildTurn([fakeModelMessage('done')], 'resp-3'),
      ]);

      const agent = new Agent({
        name: 'StreamTest',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        stream: true,
        conversationId: 'conv-test-123',
      });

      await drain(result);

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(3);
      expect(model.requests.map((req) => req.conversationId)).toEqual([
        'conv-test-123',
        'conv-test-123',
        'conv-test-123',
      ]);

      const firstInput = model.requests[0].input;
      expect(Array.isArray(firstInput)).toBe(true);
      expect(firstInput as AgentInputItem[]).toHaveLength(1);
      const userMessage = (firstInput as AgentInputItem[])[0] as any;
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('user_message');

      const secondItems = model.requests[1].input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });

      const thirdItems = model.requests[2].input as AgentInputItem[];
      expect(thirdItems).toHaveLength(1);
      expect(thirdItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-2',
      });
    });

    it('keeps server tracker aligned with filtered inputs when streaming', async () => {
      const model = new TrackingStreamingModel([
        buildTurn(
          [fakeModelMessage('call the tool'), buildToolCall('call-1', 'value')],
          'resp-1',
        ),
        buildTurn([fakeModelMessage('all done')], 'resp-2'),
      ]);

      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls += 1;
          if (filterCalls === 1) {
            return {
              instructions: modelData.instructions,
              input: modelData.input
                .slice(1)
                .map((item) => structuredClone(item)),
            };
          }
          return modelData;
        },
      });

      const agent = new Agent({
        name: 'StreamTrackerFilter',
        model,
        tools: [serverTool],
      });

      const result = await runner.run(
        agent,
        [user('First input'), user('Second input')],
        {
          stream: true,
          conversationId: 'conv-filter-stream',
        },
      );

      await drain(result);

      expect(result.finalOutput).toBe('all done');
      expect(filterCalls).toBe(2);
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input as AgentInputItem[];
      expect(Array.isArray(firstInput)).toBe(true);
      expect(firstInput).toHaveLength(1);
      expect(getFirstTextContent(firstInput[0])).toBe('Second input');

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(Array.isArray(secondInput)).toBe(true);
      expect(
        secondInput.some(
          (item) =>
            item.type === 'message' &&
            getFirstTextContent(item) === 'First input',
        ),
      ).toBe(false);
      expect(
        secondInput.some(
          (item) =>
            item.type === 'function_call_result' &&
            (item as protocol.FunctionCallResultItem).callId === 'call-1',
        ),
      ).toBe(true);
    });

    it('marks streaming inputs as sent only after the response stream begins', async () => {
      const model = new TrackingStreamingModel([
        buildTurn([fakeModelMessage('hello')], 'resp-stream-1'),
      ]);

      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );
      const agent = new Agent({ name: 'StreamMark', model });
      const runner = new Runner();

      const result = await runner.run(agent, 'ping', {
        stream: true,
        conversationId: 'conv-stream-mark',
      });

      await drain(result);

      expect(result.finalOutput).toBe('hello');
      expect(markSpy).toHaveBeenCalledTimes(1);
      const [sourceItems, options] = markSpy.mock.calls[0];
      expect(Array.isArray(sourceItems)).toBe(true);
      expect(options?.filterApplied).toBe(false);

      markSpy.mockRestore();
    });

    it('does not mark streaming inputs as sent when the stream fails before any events', async () => {
      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );
      const agent = new Agent({
        name: 'StreamFail',
        model: new ScriptedModel([modelError(new Error('stream failure'))]),
      });
      const runner = new Runner();

      const result = await runner.run(agent, 'ping', {
        stream: true,
        conversationId: 'conv-stream-fail',
      });

      await expect(drain(result)).rejects.toThrow('stream failure');
      expect(markSpy).not.toHaveBeenCalled();

      markSpy.mockRestore();
    });

    it('only sends new items and updates previousResponseId across turns', async () => {
      const model = new TrackingStreamingModel([
        buildTurn(
          [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
          'resp-789',
        ),
        buildTurn([fakeModelMessage('done')], 'resp-900'),
      ]);

      const agent = new Agent({
        name: 'StreamPrev',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        stream: true,
        previousResponseId: 'initial-response-123',
      });

      await drain(result);

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);
      expect(model.requests[0].previousResponseId).toBe('initial-response-123');

      const secondRequest = model.requests[1];
      expect(secondRequest.previousResponseId).toBe('resp-789');
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });
    });

    it('acknowledges ignored handoffs when continuing a managed conversationId stream', async () => {
      const agentBModel = new TrackingStreamingModel([
        buildTurn([fakeModelMessage('done B')], 'resp-b'),
      ]);
      const agentCModel = new TrackingStreamingModel([
        buildTurn([fakeModelMessage('done C')], 'resp-c'),
      ]);
      const agentB = new Agent({
        name: 'ManagedStreamB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedStreamC',
        model: agentCModel,
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const acceptedCall: FunctionCallItem = {
        id: 'h1',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: FunctionCallItem = {
        id: 'h2',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: 'c2',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedStreamA',
        model: new TrackingStreamingModel([
          buildTurn([acceptedCall, ignoredCall], 'resp-a'),
        ]),
        handoffs: [handoffToB, handoffToC],
      });
      const runner = new Runner();

      const result = await runner.run(agentA, 'hi', {
        stream: true,
        conversationId: 'conv-managed-handoff',
      });

      await drain(result);

      expect(result.finalOutput).toBe('done B');
      expect(agentBModel.requests).toHaveLength(1);
      expect(agentCModel.requests).toHaveLength(0);
      expect(agentBModel.requests[0].conversationId).toBe(
        'conv-managed-handoff',
      );
      expect(agentBModel.requests[0].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: acceptedCall.callId,
        }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: ignoredCall.callId,
        }),
      ]);
      expect(
        result.history.some(
          (item) => (item as { callId?: string }).callId === ignoredCall.callId,
        ),
      ).toBe(false);
    });

    it('rejects an ignored handoff that reuses a committed callId while streaming', async () => {
      const agentBModel = new TrackingStreamingModel([
        buildTurn([fakeModelMessage('done B')], 'resp-b'),
      ]);
      const agentCModel = new TrackingStreamingModel([
        buildTurn([fakeModelMessage('done C')], 'resp-c'),
      ]);
      const agentB = new Agent({
        name: 'ManagedReuseStreamB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedReuseStreamC',
        model: agentCModel,
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const reusedCallId = 'reused-call-id';
      const acceptedCall: FunctionCallItem = {
        id: 'handoff-accepted',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'handoff-accepted-id',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: FunctionCallItem = {
        id: 'handoff-ignored',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: reusedCallId,
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedReuseStreamA',
        model: new TrackingStreamingModel([
          buildTurn([buildToolCall(reusedCallId, 'warmup')], 'resp-tool'),
          buildTurn([acceptedCall, ignoredCall], 'resp-handoff'),
        ]),
        tools: [serverTool],
        handoffs: [handoffToB, handoffToC],
      });
      const runner = new Runner();

      const result = await runner.run(agentA, 'hi', {
        stream: true,
        conversationId: 'conv-managed-reused-call-id',
      });

      await expect(drain(result)).rejects.toThrow(
        'Tool call ID reused-call-id was reused for a different invocation after its output was committed.',
      );

      expect(agentBModel.requests).toHaveLength(0);
      expect(agentCModel.requests).toHaveLength(0);
    });

    it('replays managed handoff acknowledgements when resuming before streamed response completion', async () => {
      class AbortAfterAckStreamingModel extends ScriptedModel {
        readonly requests: ModelRequest[];

        constructor() {
          const requests: ModelRequest[] = [];
          const record = (request: Readonly<ModelRequest>) => {
            requests.push({
              ...request,
              input: Array.isArray(request.input)
                ? (JSON.parse(
                    JSON.stringify(request.input),
                  ) as AgentInputItem[])
                : request.input,
            });
          };
          super([
            modelStreamResponder((call) =>
              (async function* () {
                record(call.request);
                yield {
                  type: 'output_text_delta',
                  delta: 'ack',
                } as StreamEvent;
                const abortError = new Error('aborted');
                abortError.name = 'AbortError';
                const signal = call.request.signal;
                await new Promise((_resolve, reject) => {
                  if (signal?.aborted) {
                    reject(abortError);
                    return;
                  }
                  const onAbort = () => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(abortError);
                  };
                  signal?.addEventListener('abort', onAbort, { once: true });
                });
              })(),
            ),
            modelStreamResponder((call) => {
              record(call.request);
              return [
                {
                  type: 'response_done',
                  response: {
                    id: 'resp-b-final',
                    usage: {
                      requests: 1,
                      inputTokens: 0,
                      outputTokens: 0,
                      totalTokens: 0,
                    },
                    output: [fakeModelMessage('done B')],
                  },
                } as StreamEvent,
              ];
            }),
          ]);
          this.requests = requests;
        }
      }

      const agentBModel = new AbortAfterAckStreamingModel();
      const agentB = new Agent({
        name: 'ManagedResumeB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedResumeC',
        model: new TrackingStreamingModel([
          buildTurn([fakeModelMessage('done C')], 'resp-c'),
        ]),
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const acceptedCall: FunctionCallItem = {
        id: 'handoff-accepted',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: FunctionCallItem = {
        id: 'handoff-ignored',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: 'c2',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedResumeA',
        model: new TrackingStreamingModel([
          buildTurn([acceptedCall, ignoredCall], 'resp-a'),
        ]),
        handoffs: [handoffToB, handoffToC],
      });
      const runner = new Runner();

      const firstRun = await runner.run(agentA, 'hi', {
        stream: true,
        conversationId: 'conv-managed-handoff-resume',
      });
      const reader = (firstRun.toStream() as any).getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (
          value?.type === 'raw_model_stream_event' &&
          value.data?.type === 'output_text_delta'
        ) {
          await reader.cancel('stop');
          break;
        }
      }
      await firstRun.completed;

      expect(agentBModel.requests).toHaveLength(1);
      expect(agentBModel.requests[0].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: acceptedCall.callId,
        }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: ignoredCall.callId,
        }),
      ]);

      const resumed = await runner.run(agentA, firstRun.state, {
        stream: true,
        conversationId: 'conv-managed-handoff-resume',
      });
      await drain(resumed);

      expect(resumed.finalOutput).toBe('done B');
      expect(agentBModel.requests).toHaveLength(2);
      expect(agentBModel.requests[1]?.input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: acceptedCall.callId,
        }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: ignoredCall.callId,
        }),
      ]);
    });

    it('does not replay orphan hosted shell calls in default streamed multi-turn runs', async () => {
      const hostedShell = shellTool({
        environment: { type: 'container_auto' },
      });
      const model = new TrackingStreamingModel([
        buildTurn(
          [
            {
              type: 'shell_call',
              callId: 'call-shell-1',
              status: 'completed',
              action: { commands: ['echo hi'] },
            } satisfies protocol.ShellCallItem,
          ],
          'resp-shell-1',
        ),
        buildTurn([fakeModelMessage('done')], 'resp-shell-2'),
      ]);

      const agent = new Agent({
        name: 'HostedShellStreamAgent',
        model,
        tools: [hostedShell],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        stream: true,
      });

      await drain(result);

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toHaveLength(1);
      expect(secondInput[0]).toMatchObject({
        type: 'message',
        role: 'user',
        content: 'user_message',
      });
      expect(secondInput.some((item) => item.type === 'shell_call')).toBe(
        false,
      );
    });

    it('replays pending hosted shell calls in default streamed multi-turn runs', async () => {
      const hostedShell = shellTool({
        environment: { type: 'container_auto' },
      });
      const model = new TrackingStreamingModel([
        buildTurn(
          [
            {
              type: 'shell_call',
              callId: 'call-shell-pending',
              status: 'in_progress',
              action: { commands: ['echo hi'] },
            } satisfies protocol.ShellCallItem,
          ],
          'resp-shell-pending-1',
        ),
        buildTurn([fakeModelMessage('done')], 'resp-shell-pending-2'),
      ]);

      const agent = new Agent({
        name: 'HostedShellStreamAgent',
        model,
        tools: [hostedShell],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        stream: true,
      });

      await drain(result);

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toHaveLength(2);
      expect(secondInput[0]).toMatchObject({
        type: 'message',
        role: 'user',
        content: 'user_message',
      });
      expect(secondInput[1]).toMatchObject({
        type: 'shell_call',
        callId: 'call-shell-pending',
        status: 'in_progress',
      });
    });

    it('does not resend prior items when resuming a streamed run with conversationId', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingStreamingModel([
        buildTurn([buildToolCall('call-stream', 'foo')], 'resp-stream-1'),
        buildTurn([fakeModelMessage('done')], 'resp-stream-2'),
      ]);

      const agent = new Agent({
        name: 'StreamApprovalAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        stream: true,
        conversationId: 'conv-stream-approval',
      });

      await drain(firstResult);

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        stream: true,
        conversationId: 'conv-stream-approval',
      });

      await drain(secondResult);

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);
      expect(model.requests.map((req) => req.conversationId)).toEqual([
        'conv-stream-approval',
        'conv-stream-approval',
      ]);

      const firstInput = model.requests[0].input as AgentInputItem[];
      expect(firstInput).toHaveLength(1);
      expect(firstInput[0]).toMatchObject({
        role: 'user',
        content: 'user_message',
      });

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toHaveLength(1);
      expect(secondInput[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-stream',
      });
    });

    it('does not replay an acknowledged function result across consecutive streamed approvals', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });
      const model = new TrackingStreamingModel([
        buildTurn([buildToolCall('call-stream-1', 'first')], 'resp-stream-1'),
        buildTurn([buildToolCall('call-stream-2', 'second')], 'resp-stream-2'),
        buildTurn([fakeModelMessage('done')], 'resp-stream-3'),
      ]);
      const agent = new Agent({
        name: 'ConsecutiveStreamApprovalAgent',
        model,
        tools: [approvalTool],
      });
      const runner = new Runner();

      const firstResult = await runner.run(agent, 'user_message', {
        stream: true,
        previousResponseId: 'initial-response',
      });
      await drain(firstResult);
      expect(firstResult.interruptions).toHaveLength(1);
      firstResult.state.approve(firstResult.interruptions[0]);

      const secondResult = await runner.run(agent, firstResult.state, {
        stream: true,
        previousResponseId: 'initial-response',
      });
      await drain(secondResult);
      expect(secondResult.interruptions).toHaveLength(1);
      secondResult.state.approve(secondResult.interruptions[0]);

      const thirdResult = await runner.run(agent, secondResult.state, {
        stream: true,
        previousResponseId: 'initial-response',
      });
      await drain(thirdResult);

      expect(thirdResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(3);
      expect(model.requests[1].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'call-stream-1',
        }),
      ]);
      expect(model.requests[2].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'call-stream-2',
        }),
      ]);
    });

    it('uses runner-level toolErrorFormatter when resuming a rejected approval', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingStreamingModel([
        buildTurn(
          [buildToolCall('call-stream-reject', 'foo')],
          'resp-stream-1',
        ),
      ]);

      const agent = new Agent({
        name: 'StreamRejectFormatter',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
      });

      const runner = new Runner({
        toolErrorFormatter: () => 'stream runner rejection',
      });

      const firstResult = await runner.run(agent, 'user_message', {
        stream: true,
      });

      await drain(firstResult);

      expect(firstResult.interruptions).toHaveLength(1);
      firstResult.state.reject(firstResult.interruptions[0]);

      const resumed = await runner.run(agent, firstResult.state, {
        stream: true,
      });

      await drain(resumed);

      expect(resumed.finalOutput).toBe('stream runner rejection');
      expect(model.requests).toHaveLength(1);
    });

    it('sends full history when no server-managed state is provided', async () => {
      const model = new TrackingStreamingModel([
        buildTurn(
          [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
          'resp-789',
        ),
        buildTurn([fakeModelMessage('done')], 'resp-900'),
      ]);

      const agent = new Agent({
        name: 'StreamDefault',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', { stream: true });

      await drain(result);

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondItems = model.requests[1].input as AgentInputItem[];
      expect(secondItems).toHaveLength(4);
      expect(secondItems[0]).toMatchObject({ role: 'user' });
      expect(secondItems[1]).toMatchObject({ role: 'assistant' });
      expect(secondItems[2]).toMatchObject({
        type: 'function_call',
        name: 'test',
      });
      expect(secondItems[3]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });
    });
  });

  it('persists streaming input with the result after the run completes successfully', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi.spyOn(
      sessionPersistence,
      'saveStreamResultToSession',
    );

    const session = createSessionMock();

    const agent = new Agent({
      name: 'StreamSuccess',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner();

    const result = await runner.run(agent, 'hello world', {
      stream: true,
      session,
    });

    await result.completed;

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
    const [sessionArg, , , persistedItems] = saveResultSpy.mock.calls[0];
    expect(sessionArg).toBe(session);
    if (!Array.isArray(persistedItems)) {
      throw new Error('Expected persisted session items to be an array.');
    }
    expect(persistedItems).toHaveLength(1);
    expect(persistedItems[0]).toMatchObject({
      role: 'user',
      content: 'hello world',
    });
  });

  it('persists streaming input when the model stream rejects before completion', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();

    const session = createSessionMock();
    const streamError = new Error('model stream failed');

    const agent = new Agent({
      name: 'StreamFailurePersistsInput',
      model: new RejectingStreamingModel(streamError),
    });

    const runner = new Runner();

    const result = await runner.run(agent, 'save me please', {
      stream: true,
      session,
    });

    await expect(result.completed).rejects.toThrow('model stream failed');

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    const [, persistedItems] = saveInputSpy.mock.calls[0];
    if (!Array.isArray(persistedItems)) {
      throw new Error('Expected persisted session items to be an array.');
    }
    expect(persistedItems).toHaveLength(1);
    expect(persistedItems[0]).toMatchObject({
      role: 'user',
      content: 'save me please',
    });
  });

  it('replaces session history from explicit compaction input when streaming fails', async () => {
    const previousSessionItem = user('previous session');
    const discardedInput = user('discarded input');
    const retainedInput = user('retained input');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_stream_input_failure',
      encrypted_content: 'ciphertext',
    };
    const sessionItems: AgentInputItem[] = [previousSessionItem];
    const session: Session = {
      getSessionId: vi.fn().mockResolvedValue('compacted-stream-session'),
      getItems: vi.fn(async () => structuredClone(sessionItems)),
      addItems: vi.fn(async (items: AgentInputItem[]) => {
        sessionItems.push(...structuredClone(items));
      }),
      popItem: vi.fn(async () => sessionItems.pop()),
      clearSession: vi.fn(async () => {
        sessionItems.splice(0);
      }),
    };
    const streamError = new Error('model stream failed after compaction');
    const model = new ScriptedModel([modelError(streamError)]);
    const agent = new Agent({ name: 'StreamCompactedInputFailure', model });
    const result = await new Runner().run(
      agent,
      [discardedInput, compaction, retainedInput],
      { stream: true, session },
    );

    await expect(result.completed).rejects.toThrow(
      'model stream failed after compaction',
    );

    expect(model.firstCall?.request.input).toEqual([compaction, retainedInput]);
    expect(sessionItems).toEqual([compaction, retainedInput]);
  });

  it('does not retry streamed input after combined persistence reaches compaction', async () => {
    const compactionError = new Error('compaction failed');
    const session = {
      ...createSessionMock(),
      runCompaction: vi.fn().mockRejectedValue(compactionError),
    };
    const agent = new Agent({
      name: 'StreamCompactionFailure',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    });

    const result = await run(agent, 'persist once', {
      stream: true,
      session,
    });

    await expect(result.completed).rejects.toThrow('compaction failed');
    expect(session.addItems).toHaveBeenCalledTimes(1);
    const persistedItems = vi.mocked(session.addItems).mock.calls[0][0];
    expect(
      persistedItems.filter(
        (item) =>
          item.type === 'message' &&
          item.role === 'user' &&
          getFirstTextContent(item) === 'persist once',
      ),
    ).toHaveLength(1);
  });

  it('persists filtered streaming input instead of the raw turn payload', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi.spyOn(
      sessionPersistence,
      'saveStreamResultToSession',
    );

    const session = createSessionMock();

    const agent = new Agent({
      name: 'StreamFiltered',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner();

    const secretInput = 'super secret';
    const redactedContent = '[filtered]';

    const result = await runner.run(agent, secretInput, {
      stream: true,
      session,
      callModelInputFilter: ({ modelData }) => {
        const sanitizedInput = modelData.input.map((item) => {
          if (
            item.type === 'message' &&
            'role' in item &&
            item.role === 'user'
          ) {
            return {
              ...item,
              content: redactedContent,
            };
          }
          return item;
        });

        return {
          ...modelData,
          input: sanitizedInput,
        };
      },
    });

    await result.completed;

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
    const [, , , persistedItems] = saveResultSpy.mock.calls[0];
    if (!Array.isArray(persistedItems)) {
      throw new Error('Expected persisted session items to be an array.');
    }
    expect(persistedItems).toHaveLength(1);
    expect(persistedItems[0]).toMatchObject({
      role: 'user',
      content: redactedContent,
    });
    expect(JSON.stringify(persistedItems)).not.toContain(secretInput);
  });

  it('skips streaming session persistence when the server manages the conversation', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    const session = createSessionMock();

    const agent = new Agent({
      name: 'StreamServerManaged',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner();

    // Session is still supplied alongside conversationId to confirm we suppress duplicate persistence while preserving session-based hooks.
    const result = await runner.run(agent, 'hello world', {
      stream: true,
      session,
      conversationId: 'conv-server-managed',
    });

    await result.completed;

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).not.toHaveBeenCalled();
  });

  it('skips persisting streaming input when an input guardrail triggers', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    const guardrail = {
      name: 'block',
      runInParallel: false,
      execute: vi.fn().mockResolvedValue({
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked' },
      }),
    };

    const session = createSessionMock();

    const agent = new Agent({
      name: 'StreamGuardrail',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('should not run')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner({ inputGuardrails: [guardrail] });

    const result = await runner.run(agent, 'blocked input', {
      stream: true,
      session,
    });

    await expect(result.completed).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).not.toHaveBeenCalled();
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
  });

  it('skips persisting streaming input when a parallel input guardrail triggers after streaming starts', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    const guardrail = {
      name: 'parallel-block',
      execute: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  tripwireTriggered: true,
                  outputInfo: { reason: 'blocked' },
                }),
              0,
            ),
          ),
      ),
    };

    const session = createSessionMock();

    const agent = new Agent({
      name: 'StreamGuardrailParallel',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('should not run')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner({ inputGuardrails: [guardrail] });

    const result = await runner.run(agent, 'blocked input', {
      stream: true,
      session,
    });

    await expect(result.completed).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).not.toHaveBeenCalled();
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
  });

  it('does not start streaming while sibling parallel guardrails drain after a failure', async () => {
    let releaseSlowGuardrail!: () => void;
    let markSlowStarted!: () => void;
    let markErrorThrown!: () => void;
    const slowGuardrailCanFinish = new Promise<void>((resolve) => {
      releaseSlowGuardrail = resolve;
    });
    const slowGuardrailStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const errorThrown = new Promise<void>((resolve) => {
      markErrorThrown = resolve;
    });
    const slowGuardrail = {
      name: 'slow-parallel-guardrail',
      execute: async () => {
        markSlowStarted();
        await slowGuardrailCanFinish;
        return { tripwireTriggered: false, outputInfo: {} };
      },
    };
    const errorGuardrail = {
      name: 'failing-parallel-guardrail',
      execute: async () => {
        await slowGuardrailStarted;
        markErrorThrown();
        throw new Error('boom');
      },
    };

    const model = new ScriptedModel([
      terminalModelStream(
        {
          output: [protocol.OutputModelItem.parse(fakeModelMessage('done'))],
          usage: new Usage(),
        },
        'stream-response',
      ),
    ]);
    const agent = new Agent({
      name: 'StreamingParallelGuardrailFailure',
      model,
      inputGuardrails: [slowGuardrail, errorGuardrail],
    });
    const runner = new Runner();

    const result = await runner.run(agent, 'hello', { stream: true });
    let completionSettled = false;
    void result.completed.then(
      () => {
        completionSettled = true;
      },
      () => {
        completionSettled = true;
      },
    );
    await errorThrown;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeSiblingFinished = model.calls.length;
    const settledBeforeSiblingFinished = completionSettled;
    releaseSlowGuardrail();

    await expect(result.completed).rejects.toBeInstanceOf(
      GuardrailExecutionError,
    );
    expect(callsBeforeSiblingFinished).toBe(0);
    expect(settledBeforeSiblingFinished).toBe(false);
    expect(model.calls).toHaveLength(0);
    expect(result.currentTurn).toBe(0);
    expect(result.inputGuardrailResults.map((r) => r.guardrail.name)).toEqual([
      'slow-parallel-guardrail',
    ]);
  });

  it('retains an admitted streamed turn when a parallel guardrail fails after the model starts', async () => {
    let markModelStarted!: () => void;
    let markGuardrailFailing!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const guardrailFailing = new Promise<void>((resolve) => {
      markGuardrailFailing = resolve;
    });
    const guardrail = {
      name: 'late-parallel-guardrail-error',
      execute: async () => {
        await modelStarted;
        markGuardrailFailing();
        throw new Error('late boom');
      },
    };

    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          markModelStarted();
          await guardrailFailing;
          yield {
            type: 'response_done',
            response: {
              id: 'late-guardrail-response',
              usage: {
                requests: 1,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
              output: [
                protocol.OutputModelItem.parse(fakeModelMessage('unused')),
              ],
            },
          } satisfies StreamEvent;
        })(),
      ),
    ]);
    const agent = new Agent({
      name: 'LateStreamingParallelGuardrailFailure',
      model,
      inputGuardrails: [guardrail],
    });
    const runner = new Runner();

    const result = await runner.run(agent, 'hello', { stream: true });
    await expect(result.completed).rejects.toBeInstanceOf(
      GuardrailExecutionError,
    );
    expect(model.calls).toHaveLength(1);
    expect(result.currentTurn).toBe(1);
    expect(result.state._currentTurn).toBe(1);

    const restored = await RunState.fromString(agent, result.state.toString());
    expect(restored._currentTurn).toBe(1);

    const resumed = await runner.run(agent, restored, {
      stream: true,
      maxTurns: 1,
    });
    await expect(resumed.completed).rejects.toBeInstanceOf(
      MaxTurnsExceededError,
    );
    expect(resumed.currentTurn).toBe(1);
    expect(resumed.state._currentTurn).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  it('persists streaming input through the blocked result save when an output guardrail trips', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    const guardrail = {
      name: 'output-block',
      execute: vi.fn().mockResolvedValue({
        tripwireTriggered: true,
        outputInfo: { reason: 'pii' },
      }),
    };

    const session = createSessionMock();
    const agent = new Agent({
      name: 'StreamOutputGuardrail',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('PII: 123-456-7890')],
        usage: new Usage(),
      }),
      outputGuardrails: [guardrail],
    });

    const result = await run(agent, 'filter me', { stream: true, session });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(result.completed).rejects.toBeInstanceOf(
      OutputGuardrailTripwireTriggered,
    );

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).toHaveBeenCalledWith(
      session,
      result,
      { outputBlocked: true },
      expect.any(Array),
    );
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
    expect(result.state._currentStep?.type).toBe('next_step_final_output');
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );
  });

  it('keeps streamed final output hidden while output guardrails are pending', async () => {
    let signalGuardrailStarted!: () => void;
    const guardrailStarted = new Promise<void>((resolve) => {
      signalGuardrailStarted = resolve;
    });
    let releaseGuardrail!: () => void;
    const guardrailResult = new Promise<GuardrailFunctionOutput>((resolve) => {
      releaseGuardrail = () =>
        resolve({
          tripwireTriggered: false,
          outputInfo: null,
        });
    });
    const agent = new Agent({
      name: 'Pending output guardrail',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('guarded candidate')],
        usage: new Usage(),
      }),
      outputGuardrails: [
        {
          name: 'suspended output guardrail',
          execute: async () => {
            signalGuardrailStarted();
            return guardrailResult;
          },
        },
      ],
    });
    const result = await run(agent, 'hello', { stream: true });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await guardrailStarted;
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );

    releaseGuardrail();
    await result.completed;
    expect(result.finalOutput).toBe('guarded candidate');

    warnSpy.mockRestore();
  });

  it('keeps a serialized final output hidden when streamed resume is pre-aborted', async () => {
    const guardrail = vi.fn().mockResolvedValue({
      tripwireTriggered: false,
      outputInfo: null,
    });
    const agent = new Agent({
      name: 'Pre-aborted final output resume',
      model: new ScriptedModel([]),
      outputGuardrails: [
        {
          name: 'should not run after pre-abort',
          execute: guardrail,
        },
      ],
    });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._currentTurn = 1;
    state._currentTurnInProgress = true;
    state._currentStep = {
      type: 'next_step_final_output',
      output: 'blocked secret',
    };
    const restored = await RunState.fromString(agent, state.toString());
    const controller = new AbortController();
    controller.abort('cancel before resume');
    const result = await run(agent, restored, {
      stream: true,
      signal: controller.signal,
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await result.completed;

    expect(result.cancelled).toBe(true);
    expect(result.finalOutput).toBeUndefined();
    expect(guardrail).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );

    warnSpy.mockRestore();
  });

  it('does not persist streaming result when the consumer cancels early', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    const session = createSessionMock();
    const agent = new Agent({
      name: 'StreamCancelPersistence',
      model: new ImmediateStreamingModel({
        output: [
          fakeModelMessage('Chunk1'),
          fakeModelMessage('Chunk2'),
          fakeModelMessage('Chunk3'),
        ],
        usage: new Usage(),
      }),
    });

    const result = await run(agent, 'cancel me', { stream: true, session });
    const reader = (result.toStream() as any).getReader();

    // Read the first delta then cancel the stream.
    await reader.read();
    await reader.cancel('stop');
    await result.completed;

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
  });

  it('persists streaming input after cancellation once parallel guardrails finish', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    let resolveGuardrail:
      ((value: GuardrailFunctionOutput) => void) | undefined;
    const guardrail = {
      name: 'parallel-allow',
      execute: vi.fn(
        () =>
          new Promise<GuardrailFunctionOutput>((resolve) => {
            resolveGuardrail = resolve;
          }),
      ),
    };

    const session = createSessionMock();
    const agent = new Agent({
      name: 'StreamCancelAfterGuardrail',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('Chunk1')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner({ inputGuardrails: [guardrail] });
    const result = await runner.run(agent, 'hi', { stream: true, session });
    const reader = (result.toStream() as any).getReader();

    await reader.read();
    await reader.cancel('stop');

    if (!resolveGuardrail) {
      throw new Error('Expected guardrail resolver to be set.');
    }
    resolveGuardrail({
      tripwireTriggered: false,
      outputInfo: { ok: true },
    });

    await result._getStreamLoopPromise();

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).not.toHaveBeenCalled();
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
  });

  it('resumes a cancelled in-progress turn without double-counting turns', async () => {
    const agent = new Agent({
      name: 'ResumeAfterCancel',
      model: new ScriptedModel([abortingHangingStream()]),
    });
    const runner = new Runner();

    const streaming = await runner.run(agent, 'hello', { stream: true });
    const reader = (streaming.toStream() as any).getReader();

    // Allow the streaming loop to enter before cancellation.
    await new Promise((resolve) => setImmediate(resolve));
    await reader.cancel('stop');
    await streaming._getStreamLoopPromise();

    expect(streaming.state._currentTurn).toBe(1);
    expect(streaming.state._currentTurnInProgress).toBe(true);

    const serialized = streaming.state.toString();
    const restored = await RunState.fromString(agent, serialized);

    agent.model = new ScriptedModel([
      modelResponse({
        output: [fakeModelMessage('resumed')],
        usage: new Usage(),
      }),
    ]);

    const resumed = await runner.run(agent, restored);

    expect(resumed.finalOutput).toBe('resumed');
    expect(resumed.state._currentTurn).toBe(1);
    expect(resumed.state._currentTurnInProgress).toBe(false);
  });

  it('persists streaming input/result exactly once on success', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();
    const saveResultSpy = vi
      .spyOn(sessionPersistence, 'saveStreamResultToSession')
      .mockResolvedValue();

    const session = createSessionMock();
    const agent = new Agent({
      name: 'StreamPersistOnce',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    });

    const result = await run(agent, 'hello', { stream: true, session });
    await result.completed;

    expect(saveInputSpy).not.toHaveBeenCalled();
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves requestId from response_done in rawResponses', async () => {
    const agent = new Agent({
      name: 'StreamRequestId',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        responseId: 'resp_123',
        requestId: 'req_stream_123',
      }),
    });

    const result = await run(agent, 'hello', { stream: true });
    await result.completed;

    expect(result.rawResponses).toHaveLength(1);
    expect(result.rawResponses[0].responseId).toBe('resp_123');
    expect(result.rawResponses[0].requestId).toBe('req_stream_123');
  });

  it.each([
    ['omitted', undefined, undefined],
    ['disabled', false, undefined],
    ['enabled', true, { input_tokens_details: { cached_tokens: 0 } }],
  ] as const)(
    'exposes streamed raw usage only when preservation is %s',
    async (_label, preserveRawUsage, expectedRawUsage) => {
      const agent = new Agent({
        name: 'StreamRawUsage',
        model: new ImmediateStreamingModel({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
          rawUsage: { input_tokens_details: { cached_tokens: 0 } },
        }),
        modelSettings: { preserveRawUsage },
      });

      const result = await run(agent, 'hello', { stream: true });
      await result.completed;

      expect(result.rawResponses[0].rawUsage).toEqual(expectedRawUsage);
    },
  );

  it('detaches raw usage retained by a streamed result from the terminal event', async () => {
    const agent = new Agent({
      name: 'DetachedStreamRawUsage',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        rawUsage: { input_tokens_details: { cached_tokens: 0 } },
      }),
      modelSettings: { preserveRawUsage: true },
    });

    const result = await run(agent, 'hello', { stream: true });
    for await (const event of result.toStream()) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'response_done' &&
        event.data.response.rawUsage
      ) {
        (
          event.data.response.rawUsage.input_tokens_details as {
            cached_tokens: number;
          }
        ).cached_tokens = 99;
      }
    }
    await result.completed;

    expect(result.rawResponses[0].rawUsage).toEqual({
      input_tokens_details: { cached_tokens: 0 },
    });
  });

  it.each(['non-plain', 'cyclic', 'throwing getter'] as const)(
    'ignores %s raw usage from a terminal model event',
    async (variant) => {
      const model = new ScriptedModel([
        modelStreamResponder(() =>
          (async function* () {
            const response: Record<string, unknown> = {
              id: 'r',
              usage: {
                requests: 1,
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
              output: [fakeModelMessage('done')],
            };
            if (variant === 'throwing getter') {
              Object.defineProperty(response, 'rawUsage', {
                enumerable: true,
                get() {
                  throw new Error('raw usage is unavailable');
                },
              });
            } else if (variant === 'cyclic') {
              const rawUsage: Record<string, unknown> = {};
              rawUsage.self = rawUsage;
              response.rawUsage = rawUsage;
            } else {
              response.rawUsage = new Map([['input_tokens', 1]]);
            }
            yield { type: 'response_done', response } as any;
          })(),
        ),
      ]);

      const agent = new Agent({
        name: 'InvalidRawUsage',
        model,
        modelSettings: { preserveRawUsage: true },
      });
      const result = await run(agent, 'hello', { stream: true });
      await result.completed;

      expect(result.finalOutput).toBe('done');
      expect(result.rawResponses[0].rawUsage).toBeUndefined();
    },
  );

  it('runs blocking input guardrails before streaming starts', async () => {
    let guardrailFinished = false;

    const guardrail = {
      name: 'blocking',
      runInParallel: false,
      execute: vi.fn(async () => {
        await Promise.resolve();
        guardrailFinished = true;
        return {
          tripwireTriggered: false,
          outputInfo: { ok: true },
        };
      }),
    };

    const agent = new Agent({
      name: 'BlockingStreamAgent',
      model: new ScriptedModel([
        modelStreamResponder(() => {
          expect(guardrailFinished).toBe(true);
          return [
            {
              type: 'response_done',
              response: {
                id: 'stream1',
                usage: {
                  requests: 1,
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                },
                output: [fakeModelMessage('ok')],
              },
            } satisfies StreamEvent,
          ];
        }),
      ]),
      inputGuardrails: [guardrail],
    });

    const runner = new Runner();
    const result = await runner.run(agent, 'hi', { stream: true });

    for await (const _ of result.toStream()) {
      // consume
    }
    await result.completed;

    expect(result.finalOutput).toBe('ok');
    expect(result.inputGuardrailResults).toHaveLength(1);
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
  });
});

class ImmediateStreamingModel extends ScriptedModel {
  constructor(response: ModelResponse) {
    super([
      modelStream([
        {
          type: 'response_done',
          response: {
            id: response.responseId ?? 'r',
            requestId: response.requestId,
            usage: {
              requests: response.usage.requests,
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              totalTokens: response.usage.totalTokens,
            },
            rawUsage: response.rawUsage,
            output: response.output.map((item) =>
              protocol.OutputModelItem.parse(item),
            ),
          },
        } satisfies StreamEvent,
      ]),
    ]);
  }
}

class RejectingStreamingModel extends ScriptedModel {
  constructor(error: Error) {
    super([modelError(error)]);
  }
}

function createSessionMock(): Session {
  return {
    getSessionId: vi.fn().mockResolvedValue('session-id'),
    getItems: vi.fn().mockResolvedValue([]),
    addItems: vi.fn().mockResolvedValue(undefined),
    popItem: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
  };
}

// A streaming model that returns one queued ModelResponse per turn, mirroring
// the QueueStreamingModel used elsewhere in this file.
class QueuedTurnStreamingModel extends ScriptedModel {
  constructor(responses: ModelResponse[]) {
    super(
      responses.map((response) =>
        parsedTerminalModelStream(
          response,
          response.responseId ?? 'resp-current-turn',
        ),
      ),
    );
  }
}

describe('StreamedRunResult.currentTurn (streamed runs)', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it('tracks the real turn count across a multi-turn streamed run', async () => {
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ q: z.string() }),
      execute: async () => 'ok',
    });
    const agent = new Agent({
      name: 'MultiTurnStreamingAgent',
      model: new QueuedTurnStreamingModel([
        {
          output: [
            {
              type: 'function_call',
              id: 'fc_lookup',
              callId: 'call_lookup',
              name: 'lookup',
              status: 'completed',
              arguments: JSON.stringify({ q: 'x' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ]),
      tools: [lookup],
      toolUseBehavior: 'run_llm_again',
    });

    const result = await run(agent, 'go', { stream: true });
    await result.completed;

    // Two model requests => two turns. Previously currentTurn was pinned at 0.
    expect(result.finalOutput).toBe('done');
    expect(result.currentTurn).toBe(2);
  });

  it('reports 0 on a handled max-turn boundary (no turn was admitted)', async () => {
    // maxTurns: 0 -- the runner increments _currentTurn to 1 before the limit
    // check, then raises MaxTurnsExceededError without ever calling the model.
    // currentTurn is written only once a turn is ADMITTED, so it stays 0 here.
    const agent = new Agent({
      name: 'MaxTurnsZeroAgent',
      model: new ScriptedModel(),
    });

    const result = await run(agent, 'go', { stream: true, maxTurns: 0 });
    await expect(result.completed).rejects.toBeInstanceOf(
      MaxTurnsExceededError,
    );
    expect(result.currentTurn).toBe(0);
    expect(result.state._currentTurn).toBe(0);

    const restored = await RunState.fromString(agent, result.state.toString());
    agent.model = new ImmediateStreamingModel({
      output: [fakeModelMessage('resumed')],
      usage: new Usage(),
    });
    const resumed = await run(agent, restored, {
      stream: true,
      maxTurns: null,
    });
    await resumed.completed;

    expect(resumed.finalOutput).toBe('resumed');
    expect(resumed.currentTurn).toBe(1);
    expect(resumed.state._currentTurn).toBe(1);
  });

  it('reports 0 when request serialization fails before the model call', async () => {
    const model = new QueuedTurnStreamingModel([
      {
        output: [fakeModelMessage('{"value":"ok"}')],
        usage: new Usage(),
      },
    ]);
    const agent: Agent<any, any> = new Agent({
      name: 'StreamingRequestSerializationFailure',
      model,
      outputType: z.object({ value: z.custom() }),
    });

    const result = await run(agent, 'x', { stream: true });
    await expect(result.completed).rejects.toBeInstanceOf(UserError);

    expect(model.calls).toHaveLength(0);
    expect(result.currentTurn).toBe(0);
    expect(result.state._currentTurn).toBe(0);

    const restored = await RunState.fromString(agent, result.state.toString());
    agent.outputType = z.object({ value: z.string() });
    const resumed = await run(agent, restored, {
      stream: true,
      maxTurns: 1,
    });
    await resumed.completed;

    expect(resumed.finalOutput).toEqual({ value: 'ok' });
    expect(resumed.currentTurn).toBe(1);
    expect(resumed.state._currentTurn).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  it('preserves an in-progress turn when resumed request serialization fails', async () => {
    const model = new QueuedTurnStreamingModel([
      {
        output: [fakeModelMessage('{"value":"ok"}')],
        usage: new Usage(),
      },
    ]);
    const agent: Agent<any, any> = new Agent({
      name: 'ResumedStreamingRequestSerializationFailure',
      model,
      outputType: z.object({ value: z.custom() }),
    });
    const state = new RunState(new RunContext(), 'x', agent, 1);
    state._currentTurn = 1;
    state._currentTurnInProgress = true;
    const restored = await RunState.fromString(agent, state.toString());

    const result = await run(agent, restored, {
      stream: true,
      maxTurns: 1,
    });
    await expect(result.completed).rejects.toBeInstanceOf(UserError);

    expect(model.calls).toHaveLength(0);
    expect(result.currentTurn).toBe(1);
    expect(result.state._currentTurn).toBe(1);
    expect(result.state._currentTurnInProgress).toBe(true);

    const retryState = await RunState.fromString(
      agent,
      result.state.toString(),
    );
    agent.outputType = z.object({ value: z.string() });
    const resumed = await run(agent, retryState, {
      stream: true,
      maxTurns: 1,
    });
    await resumed.completed;

    expect(resumed.finalOutput).toEqual({ value: 'ok' });
    expect(resumed.currentTurn).toBe(1);
    expect(resumed.state._currentTurn).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  it('reports 0 when a blocking input guardrail trips before any model request', async () => {
    // The counter is bumped by beginTurn BEFORE the guardrails run. The runner
    // must roll it back when the tripwire fires so resumed state does not report
    // a turn that never reached the model.
    const guardrail = {
      name: 'block-first-turn',
      runInParallel: false, // blocking: awaited before the model request
      execute: vi.fn().mockResolvedValue({
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked' },
      }),
    };

    const agent = new Agent({
      name: 'GuardrailBlockedAgent',
      model: new ImmediateStreamingModel({
        output: [fakeModelMessage('should never run')],
        usage: new Usage(),
      }),
    });

    const runner = new Runner({ inputGuardrails: [guardrail] });
    const result = await runner.run(agent, 'blocked input', { stream: true });

    await expect(result.completed).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
    expect(result.currentTurn).toBe(0);
    expect(result.state._currentTurn).toBe(0);
  });

  it('carries the turn count into a resumed streamed run instead of restarting at 0', async () => {
    // A run resumed from a serialized state has already spent turns; restarting the
    // public counter at 0 would under-report them for the rest of the run.
    const agent = new Agent({
      name: 'ResumeTurnCountAgent',
      model: new ScriptedModel([abortingHangingStream()]),
    });
    const runner = new Runner();

    const streaming = await runner.run(agent, 'hello', { stream: true });
    const reader = (streaming.toStream() as any).getReader();
    await new Promise((resolve) => setImmediate(resolve));
    await reader.cancel('stop');
    await streaming._getStreamLoopPromise();

    // The first turn WAS admitted -- the model request started, then was cancelled.
    expect(streaming.currentTurn).toBe(1);

    const restored = await RunState.fromString(
      agent,
      streaming.state.toString(),
    );
    agent.model = new ImmediateStreamingModel({
      output: [fakeModelMessage('resumed')],
      usage: new Usage(),
    });

    const resumed = await runner.run(agent, restored, { stream: true });
    await resumed.completed;

    expect(resumed.finalOutput).toBe('resumed');
    // Seeded from the resumed state, NOT reset to 0.
    expect(resumed.currentTurn).toBe(1);
  });
});
