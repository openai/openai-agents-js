import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RequestUsage,
  Runner,
  RunContext,
  RunState,
  Span,
  Trace,
  Usage,
  createAgentSpan,
  createGenerationSpan,
  getGlobalTraceProvider,
  handoff,
  retryPolicies,
  setTraceProcessors,
  setTracingContextStorage,
  setTracingDisabled,
  tool,
  withAgentSpan,
  withGenerationSpan,
  withTrace,
  withTraceContext,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type MCPServer,
  type OpenAIResponsesCompactionResult,
  type StreamEvent,
  type TracingProcessor,
} from '../src';
import type { MCPTool } from '../src/mcp';
import { defaultProcessor } from '../src/tracing/processor';
import { mergeAgentToolRunConfig } from '../src/agentToolRunConfig';
import { SandboxRuntimeManager } from '../src/sandbox/runtime';
import { AsyncLocalStorage as BrowserAsyncLocalStorage } from '../src/shims/shims-browser';
import { fakeModelMessage, FakeModel } from './stubs';

class RecordingProcessor implements TracingProcessor {
  readonly spansStarted: Span<any>[] = [];
  readonly spansEnded: Span<any>[] = [];
  readonly spanErrorsAtEnd = new Map<string, unknown>();

  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(span: Span<any>): Promise<void> {
    this.spansStarted.push(span);
  }
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
    this.spanErrorsAtEnd.set(span.spanId, span.error);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

class StreamingModel implements Model {
  private readonly responses: ModelResponse[];

  constructor(response: ModelResponse | ModelResponse[]) {
    this.responses = Array.isArray(response) ? [...response] : [response];
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error('Use getStreamedResponse for this model.');
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response found.');
    }
    yield {
      type: 'response_done',
      response: {
        id: 'stream-response',
        output: response.output,
        usage: response.usage,
      },
    } as StreamEvent;
  }
}

class FailingModel implements Model {
  constructor(private readonly error: Error) {}

  async getResponse(): Promise<ModelResponse> {
    throw this.error;
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw this.error;
    yield* [] as StreamEvent[];
  }
}

class HangingStreamingModel implements Model {
  async getResponse(): Promise<ModelResponse> {
    throw new Error('Use getStreamedResponse for this model.');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const signal = request.signal;
    await new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError);
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError), {
        once: true,
      });
    });
    yield* [] as StreamEvent[];
  }
}

class AbortReconciliationUsageModel implements Model {
  async getResponse(): Promise<ModelResponse> {
    return responseWithSpecificUsage(7, 3);
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    yield {
      type: 'model',
      event: {
        type: 'response.created',
        response: { id: 'response-before-abort' },
      },
    } as StreamEvent;
    yield {
      type: 'model',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'function-call-before-abort',
          call_id: 'call-before-abort',
          name: 'slow_tool',
          arguments: '{}',
          status: 'completed',
        },
      },
    } as StreamEvent;
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

class UsageCompactionSession extends MemorySession {
  async runCompaction(): Promise<OpenAIResponsesCompactionResult> {
    return {
      usage: new RequestUsage({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        endpoint: 'responses.compact',
      }),
    };
  }
}

class FailingCompactionSession extends MemorySession {
  readonly error = new Error('session compaction failed');

  async runCompaction(): Promise<OpenAIResponsesCompactionResult> {
    throw this.error;
  }
}

class FailingAddItemsSession extends MemorySession {
  readonly error = new Error('session addItems failed');

  async addItems(): Promise<void> {
    throw this.error;
  }
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createBarrier(participantCount: number) {
  let remaining = participantCount;
  const ready = createDeferred();
  return async () => {
    remaining -= 1;
    if (remaining === 0) {
      ready.resolve();
    }
    await ready.promise;
  };
}

class CoordinatedModel implements Model {
  private readonly responses: ModelResponse[];
  private callCount = 0;

  constructor(
    response: ModelResponse | ModelResponse[],
    private readonly waitForPeers: () => Promise<void>,
    private readonly waitBeforeResponse?: Promise<void>,
  ) {
    this.responses = Array.isArray(response) ? [...response] : [response];
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    if (this.callCount === 0) {
      await this.waitForPeers();
      await this.waitBeforeResponse;
    }
    this.callCount += 1;
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No coordinated response found.');
    }
    return response;
  }

  getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming is not supported by this model.');
  }
}

class CoordinatedTracingModel implements Model {
  constructor(
    private readonly label: string,
    private readonly waitForPeers: () => Promise<void>,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return withGenerationSpan(
      async () => {
        await this.waitForPeers();
        return responseWithoutUsage();
      },
      { data: { model: this.label } },
      request._internal?.tracingParent,
    );
  }

  getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming is not supported by this model.');
  }
}

class RetryingTracingModel implements Model {
  private attempts = 0;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return withGenerationSpan(
      async () => {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error('Rate limited');
          (error as Error & { statusCode?: number }).statusCode = 429;
          throw error;
        }
        return responseWithSpecificUsage(7, 3);
      },
      { data: { model: `retry-attempt-${this.attempts + 1}` } },
      request._internal?.tracingParent,
    );
  }

  getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming is not supported by this model.');
  }
}

class CoordinatedStreamingTracingModel implements Model {
  constructor(
    private readonly label: string,
    private readonly waitForPeers: () => Promise<void>,
  ) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error('Use getStreamedResponse for this model.');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const span = createGenerationSpan(
      { data: { model: this.label } },
      request._internal?.tracingParent,
    );
    span.start();
    try {
      await this.waitForPeers();
      yield {
        type: 'response_done',
        response: {
          id: `stream-response-${this.label}`,
          output: responseWithoutUsage().output,
          usage: new Usage(),
        },
      } as StreamEvent;
    } finally {
      span.end();
    }
  }
}

class CoordinatedMCPServer implements MCPServer {
  readonly cacheToolsList = false;
  readonly toolFilter = undefined;

  constructor(
    readonly name: string,
    private readonly waitForPeers: () => Promise<void>,
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<MCPTool[]> {
    await this.waitForPeers();
    return [];
  }

  async callTool(): Promise<[]> {
    return [];
  }
}

class CoordinatedMCPToolServer implements MCPServer {
  readonly cacheToolsList = false;
  readonly toolFilter = undefined;

  constructor(
    readonly name: string,
    readonly toolName: string,
    private readonly waitForPeers: () => Promise<void>,
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: this.toolName,
        description: `Tool from ${this.name}.`,
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      } as MCPTool,
    ];
  }

  async callTool(): Promise<any> {
    await this.waitForPeers();
    return [{ type: 'text', text: 'ok' }];
  }
}

function approvalResponse(toolName: string): ModelResponse {
  return {
    output: [
      {
        id: 'approval-call',
        type: 'function_call',
        name: toolName,
        callId: 'approval-call-id',
        status: 'completed',
        arguments: '{}',
      },
    ],
    usage: new Usage(),
  };
}

function agentToolCallResponse(toolName: string): ModelResponse {
  return {
    output: [
      {
        id: 'agent-tool-call',
        type: 'function_call',
        name: toolName,
        callId: 'agent-tool-call-id',
        status: 'completed',
        arguments: JSON.stringify({ input: 'hello' }),
      },
    ],
    usage: new Usage(),
  };
}

function handoffCallResponse(toolName: string): ModelResponse {
  return {
    output: [
      {
        id: `handoff-call-${toolName}`,
        type: 'function_call',
        name: toolName,
        callId: `handoff-call-id-${toolName}`,
        status: 'completed',
        arguments: '{}',
      },
    ],
    usage: new Usage(),
  };
}

function parallelAgentToolCallResponse(toolNames: string[]): ModelResponse {
  return {
    output: toolNames.map((toolName, index) => ({
      id: `agent-tool-call-${index}`,
      type: 'function_call' as const,
      name: toolName,
      callId: `agent-tool-call-id-${index}`,
      status: 'completed' as const,
      arguments: JSON.stringify({ input: 'hello' }),
    })),
    usage: new Usage(),
  };
}

function createNestedAgentToolScenario(
  nestedTracing?: {
    apiKey?: string;
    includeTaskAndTurnSpans?: boolean;
  },
  nestedTracingDisabled?: boolean,
) {
  const nestedAgent = new Agent({
    name: 'Nested agent',
    model: new FakeModel([responseWithUsage()]),
  });
  const nestedTool = nestedAgent.asTool({
    toolName: 'nested_agent',
    toolDescription: 'Runs the nested agent.',
    ...(nestedTracing === undefined && nestedTracingDisabled === undefined
      ? {}
      : {
          runConfig: {
            ...(nestedTracing === undefined ? {} : { tracing: nestedTracing }),
            ...(nestedTracingDisabled === undefined
              ? {}
              : { tracingDisabled: nestedTracingDisabled }),
          },
        }),
  });
  const outerAgent = new Agent({
    name: 'Outer agent',
    model: new FakeModel([
      agentToolCallResponse(nestedTool.name),
      responseWithUsage(),
    ]),
    tools: [nestedTool],
  });
  return outerAgent;
}

function responseWithUsage(): ModelResponse {
  return {
    output: [fakeModelMessage('done')],
    usage: new Usage({
      requests: 1,
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      inputTokensDetails: {
        cached_tokens: 2,
        cache_write_tokens: 3,
      },
    }),
  };
}

function responseWithSpecificUsage(
  inputTokens: number,
  outputTokens: number,
): ModelResponse {
  return {
    output: [fakeModelMessage('done')],
    usage: new Usage({
      requests: 1,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    }),
  };
}

function toolCallResponseWithSpecificUsage(
  toolName: string,
  inputTokens: number,
  outputTokens: number,
): ModelResponse {
  return {
    ...approvalResponse(toolName),
    usage: new Usage({
      requests: 1,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    }),
  };
}

function responseWithoutUsage(): ModelResponse {
  return {
    output: [fakeModelMessage('done')],
    usage: new Usage(),
  };
}

function createApprovedAgentToolScenario(stream: boolean) {
  const nestedAgent = new Agent({
    name: 'Approved nested agent',
    model: new FakeModel([responseWithUsage()]),
  });
  const nestedTool = nestedAgent.asTool({
    toolName: 'approved_nested_agent',
    toolDescription: 'Runs the approved nested agent.',
    needsApproval: true,
  });
  const responses = [
    agentToolCallResponse(nestedTool.name),
    responseWithoutUsage(),
  ];
  const outerAgent = new Agent({
    name: 'Outer approval agent',
    model: stream ? new StreamingModel(responses) : new FakeModel(responses),
    tools: [nestedTool],
  });
  return outerAgent;
}

function spanOfType(processor: RecordingProcessor, type: string): Span<any> {
  const span = processor.spansEnded.find(
    (candidate) => candidate.spanData.type === type,
  );
  if (!span) {
    throw new Error(`Missing ${type} span.`);
  }
  return span;
}

describe('runner task and turn tracing', () => {
  let processor: RecordingProcessor;

  beforeEach(() => {
    processor = new RecordingProcessor();
    setTraceProcessors([processor]);
    setTracingDisabled(false);
  });

  afterEach(() => {
    setTracingContextStorage();
    setTraceProcessors([defaultProcessor()]);
    setTracingDisabled(true);
  });

  it('creates task and turn spans by default with Python-compatible usage', async () => {
    const agent = new Agent({
      name: 'Researcher',
      model: new FakeModel([responseWithUsage()]),
    });
    const runner = new Runner({ workflowName: 'Tracing parity workflow' });

    await runner.run(agent, 'hello');

    const taskSpan = spanOfType(processor, 'task');
    const agentSpan = spanOfType(processor, 'agent');
    const turnSpan = spanOfType(processor, 'turn');

    expect(taskSpan.parentId).toBeNull();
    expect(agentSpan.parentId).toBe(taskSpan.spanId);
    expect(turnSpan.parentId).toBe(agentSpan.spanId);
    expect(taskSpan.spanData).toMatchObject({
      type: 'task',
      name: 'Tracing parity workflow',
      usage: {
        requests: 1,
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
        cached_input_tokens: 2,
        cache_write_input_tokens: 3,
      },
    });
    expect(turnSpan.spanData).toMatchObject({
      type: 'turn',
      turn: 1,
      agent_name: 'Researcher',
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        cached_input_tokens: 2,
        cache_write_input_tokens: 3,
      },
    });
    expect(taskSpan.toJSON()).toMatchObject({
      span_data: {
        type: 'custom',
        name: 'task',
        data: {
          sdk_span_type: 'task',
          name: 'Tracing parity workflow',
        },
      },
    });
    expect(turnSpan.toJSON()).toMatchObject({
      span_data: {
        type: 'custom',
        name: 'turn',
        data: {
          sdk_span_type: 'turn',
          turn: 1,
          agent_name: 'Researcher',
        },
      },
    });
  });

  it('omits only task and turn spans when explicitly disabled', async () => {
    const agent = new Agent({
      name: 'Researcher',
      model: new FakeModel([responseWithUsage()]),
    });
    const runner = new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    });

    await runner.run(agent, 'hello');

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
    expect(spanOfType(processor, 'agent').parentId).toBeNull();
  });

  it.each([false, true])(
    'does not create task or turn spans when tracing is disabled (stream: %s)',
    async (stream) => {
      const response = responseWithUsage();
      const agent = new Agent({
        name: 'Researcher',
        model: stream
          ? new StreamingModel(response)
          : new FakeModel([response]),
      });
      const runner = new Runner({ tracingDisabled: true });

      if (stream) {
        const result = await runner.run(agent, 'hello', { stream: true });
        await result.completed;
      } else {
        await runner.run(agent, 'hello');
      }

      expect(processor.spansStarted).toHaveLength(0);
      expect(processor.spansEnded).toHaveLength(0);
    },
  );

  it('can re-enable tracing when resuming a state created by a disabled runner', async () => {
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const agent = new Agent({
      name: 'Re-enabled tracing agent',
      model: new FakeModel([
        agentToolCallResponse(approvalTool.name),
        responseWithoutUsage(),
      ]),
      tools: [approvalTool],
    });

    const first = await new Runner({ tracingDisabled: true }).run(
      agent,
      'hello',
    );
    expect(first.interruptions).toHaveLength(1);
    expect(processor.spansEnded).toHaveLength(0);
    first.state.approve(first.interruptions[0]);

    await new Runner().run(agent, first.state);

    expect(
      processor.spansEnded.filter((span) => span.spanData.type === 'task'),
    ).toHaveLength(1);
    expect(
      processor.spansEnded.filter((span) => span.spanData.type === 'turn'),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'can re-enable tracing when resuming an in-memory state created while tracing is globally disabled (stream=%s)',
    async (stream) => {
      const approvalTool = tool({
        name: stream
          ? 'streaming_globally_disabled_approval_tool'
          : 'globally_disabled_approval_tool',
        description: 'Requires approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const responses = [
        approvalResponse(approvalTool.name),
        responseWithoutUsage(),
      ];
      const agent = new Agent({
        name: stream
          ? 'Streaming globally re-enabled tracing agent'
          : 'Globally re-enabled tracing agent',
        model: stream
          ? new StreamingModel(responses)
          : new FakeModel(responses),
        tools: [approvalTool],
      });

      setTracingDisabled(true);
      const first = stream
        ? await new Runner().run(agent, 'hello', { stream: true })
        : await new Runner().run(agent, 'hello');
      if ('completed' in first) {
        await first.completed;
      }
      expect(first.interruptions).toHaveLength(1);
      expect(processor.spansEnded).toHaveLength(0);
      first.state.approve(first.interruptions[0]);

      setTracingDisabled(false);
      const resumed = stream
        ? await new Runner().run(agent, first.state, { stream: true })
        : await new Runner().run(agent, first.state);
      if ('completed' in resumed) {
        await resumed.completed;
      }

      expect(
        processor.spansEnded.filter((span) => span.spanData.type === 'task'),
      ).toHaveLength(1);
      expect(
        processor.spansEnded.filter((span) => span.spanData.type === 'turn'),
      ).toHaveLength(1);
    },
  );

  it('preserves the runner task and turn opt-out for nested agent tools when overriding the tracing API key', async () => {
    const agent = createNestedAgentToolScenario();
    const runner = new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    });

    await runner.run(agent, 'hello', {
      tracing: {
        apiKey: 'run-specific-key',
        includeTaskAndTurnSpans: undefined,
      },
    });

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
    expect(
      processor.spansEnded
        .filter((span) => span.spanData.type === 'agent')
        .every((span) => span.tracingApiKey === 'run-specific-key'),
    ).toBe(true);
  });

  it('propagates the task and turn opt-out to nested agent tools', async () => {
    const runnerConfiguredAgent = createNestedAgentToolScenario();
    await new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    }).run(runnerConfiguredAgent, 'hello');

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);

    processor.spansStarted.length = 0;
    processor.spansEnded.length = 0;

    const callConfiguredAgent = createNestedAgentToolScenario();
    await new Runner().run(callConfiguredAgent, 'hello', {
      tracing: { includeTaskAndTurnSpans: false },
    });

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
  });

  it('propagates tracingDisabled to nested agent tools unless overridden', async () => {
    const inheritedAgent = createNestedAgentToolScenario();
    await new Runner({ tracingDisabled: true }).run(inheritedAgent, 'hello');

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);

    processor.spansStarted.length = 0;
    processor.spansEnded.length = 0;

    const overriddenAgent = createNestedAgentToolScenario(undefined, false);
    await new Runner({ tracingDisabled: true }).run(overriddenAgent, 'hello');

    expect(
      processor.spansEnded.filter((span) => span.spanData.type === 'task'),
    ).toHaveLength(1);
    expect(
      processor.spansEnded.filter((span) => span.spanData.type === 'turn'),
    ).toHaveLength(1);
  });

  it('isolates task and turn usage for parallel nested agent tools', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const firstToolFinished = createDeferred();
    const innerToolA = tool({
      name: 'inner_tool_a',
      description: 'Runs the first inner tool.',
      parameters: z.object({}),
      execute: async () => 'inner-a',
    });
    const innerToolB = tool({
      name: 'inner_tool_b',
      description: 'Runs the second inner tool.',
      parameters: z.object({}),
      execute: async () => 'inner-b',
    });
    const nestedAgentA = new Agent({
      name: 'Nested agent A',
      model: new CoordinatedModel(
        [
          toolCallResponseWithSpecificUsage(innerToolA.name, 10, 1),
          responseWithSpecificUsage(11, 2),
        ],
        waitForBothModels,
      ),
      tools: [innerToolA],
    });
    const nestedAgentB = new Agent({
      name: 'Nested agent B',
      model: new CoordinatedModel(
        [
          toolCallResponseWithSpecificUsage(innerToolB.name, 20, 2),
          responseWithSpecificUsage(21, 3),
        ],
        waitForBothModels,
        firstToolFinished.promise,
      ),
      tools: [innerToolB],
    });
    const nestedToolA = nestedAgentA.asTool({
      toolName: 'nested_agent_a',
      toolDescription: 'Runs nested agent A.',
      customOutputExtractor: (result) => {
        firstToolFinished.resolve();
        return String(result.finalOutput);
      },
    });
    const nestedToolB = nestedAgentB.asTool({
      toolName: 'nested_agent_b',
      toolDescription: 'Runs nested agent B.',
    });
    const outerAgent = new Agent({
      name: 'Outer parallel agent',
      model: new FakeModel([
        parallelAgentToolCallResponse([nestedToolA.name, nestedToolB.name]),
        responseWithoutUsage(),
      ]),
      tools: [nestedToolA, nestedToolB],
    });

    await new Runner().run(outerAgent, 'hello');

    const nestedAgentSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === nestedAgentA.name,
    );
    const nestedAgentSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === nestedAgentB.name,
    );
    const nestedTaskSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'task' &&
        span.spanId === nestedAgentSpanA?.parentId,
    );
    const nestedTaskSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'task' &&
        span.spanId === nestedAgentSpanB?.parentId,
    );
    const nestedTurnSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'turn' &&
        span.parentId === nestedAgentSpanA?.spanId,
    );
    const nestedTurnSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'turn' &&
        span.parentId === nestedAgentSpanB?.spanId,
    );
    const outerTaskSpan = processor.spansEnded.find(
      (span) => span.spanData.type === 'task' && span.parentId === null,
    );
    const outerTurnSpan = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'turn' &&
        span.spanData.agent_name === outerAgent.name,
    );
    const nestedFunctionSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'function' &&
        span.spanData.name === nestedToolA.name,
    );
    const nestedFunctionSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'function' &&
        span.spanData.name === nestedToolB.name,
    );
    const innerFunctionSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'function' &&
        span.spanData.name === innerToolA.name,
    );
    const innerFunctionSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'function' &&
        span.spanData.name === innerToolB.name,
    );

    expect(nestedFunctionSpanA?.parentId).toBe(outerTurnSpan?.spanId);
    expect(nestedFunctionSpanB?.parentId).toBe(outerTurnSpan?.spanId);
    expect(nestedTaskSpanA?.parentId).toBe(nestedFunctionSpanA?.spanId);
    expect(nestedTaskSpanB?.parentId).toBe(nestedFunctionSpanB?.spanId);
    expect(nestedTaskSpanA?.spanData.usage).toMatchObject({
      requests: 2,
      input_tokens: 21,
      output_tokens: 3,
      total_tokens: 24,
    });
    expect(nestedTaskSpanB?.spanData.usage).toMatchObject({
      requests: 2,
      input_tokens: 41,
      output_tokens: 5,
      total_tokens: 46,
    });
    expect(nestedTurnSpanA?.spanData.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 1,
    });
    expect(nestedTurnSpanB?.spanData.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 2,
    });
    expect(outerTaskSpan?.spanData.usage).toMatchObject({
      requests: 4,
      input_tokens: 62,
      output_tokens: 8,
      total_tokens: 70,
    });
    expect(outerTurnSpan?.spanData.usage).toMatchObject({
      input_tokens: 62,
      output_tokens: 8,
    });
    const nestedTurnSpansA = processor.spansEnded.filter(
      (span) =>
        span.spanData.type === 'turn' &&
        span.spanData.agent_name === nestedAgentA.name,
    );
    const nestedTurnSpansB = processor.spansEnded.filter(
      (span) =>
        span.spanData.type === 'turn' &&
        span.spanData.agent_name === nestedAgentB.name,
    );
    expect(nestedTurnSpansA).toHaveLength(2);
    expect(nestedTurnSpansB).toHaveLength(2);
    expect(innerFunctionSpanA?.parentId).toBe(nestedTurnSpansA[0]?.spanId);
    expect(innerFunctionSpanB?.parentId).toBe(nestedTurnSpansB[0]?.spanId);
    expect(
      nestedTurnSpansA.every(
        (span) => span.parentId === nestedAgentSpanA?.spanId,
      ),
    ).toBe(true);
    expect(
      nestedTurnSpansB.every(
        (span) => span.parentId === nestedAgentSpanB?.spanId,
      ),
    ).toBe(true);
  });

  it('keeps parallel nested agent spans under their tools when task and turn spans are disabled', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const nestedAgentA = new Agent({
      name: 'Opt-out nested agent A',
      model: new CoordinatedModel(responseWithoutUsage(), waitForBothModels),
    });
    const nestedAgentB = new Agent({
      name: 'Opt-out nested agent B',
      model: new CoordinatedModel(responseWithoutUsage(), waitForBothModels),
    });
    const nestedToolA = nestedAgentA.asTool({
      toolName: 'opt_out_nested_agent_a',
      toolDescription: 'Runs opt-out nested agent A.',
    });
    const nestedToolB = nestedAgentB.asTool({
      toolName: 'opt_out_nested_agent_b',
      toolDescription: 'Runs opt-out nested agent B.',
    });
    const outerAgent = new Agent({
      name: 'Opt-out outer parallel agent',
      model: new FakeModel([
        parallelAgentToolCallResponse([nestedToolA.name, nestedToolB.name]),
        responseWithoutUsage(),
      ]),
      tools: [nestedToolA, nestedToolB],
    });

    await new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    }).run(outerAgent, 'hello');

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
    const outerAgentSpan = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === outerAgent.name,
    );
    const nestedAgentSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === nestedAgentA.name,
    );
    const nestedAgentSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === nestedAgentB.name,
    );
    const functionSpanA = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'function' &&
        span.spanData.name === nestedToolA.name,
    );
    const functionSpanB = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'function' &&
        span.spanData.name === nestedToolB.name,
    );

    expect(functionSpanA?.parentId).toBe(outerAgentSpan?.spanId);
    expect(functionSpanB?.parentId).toBe(outerAgentSpan?.spanId);
    expect(nestedAgentSpanA?.parentId).toBe(functionSpanA?.spanId);
    expect(nestedAgentSpanB?.parentId).toBe(functionSpanB?.spanId);
  });

  it('keeps parallel nested handoff spans under their own turns in browser runtimes', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const targetAgentA = new Agent({
      name: 'Nested handoff target A',
      model: new FakeModel([responseWithoutUsage()]),
    });
    const targetAgentB = new Agent({
      name: 'Nested handoff target B',
      model: new FakeModel([responseWithoutUsage()]),
    });
    const handoffA = handoff(targetAgentA);
    const handoffB = handoff(targetAgentB);
    const sourceAgentA = new Agent({
      name: 'Nested handoff source A',
      model: new CoordinatedModel(
        handoffCallResponse(handoffA.toolName),
        waitForBothModels,
      ),
      handoffs: [handoffA],
    });
    const sourceAgentB = new Agent({
      name: 'Nested handoff source B',
      model: new CoordinatedModel(
        handoffCallResponse(handoffB.toolName),
        waitForBothModels,
      ),
      handoffs: [handoffB],
    });
    const nestedToolA = sourceAgentA.asTool({
      toolName: 'nested_handoff_agent_a',
      toolDescription: 'Runs nested handoff agent A.',
    });
    const nestedToolB = sourceAgentB.asTool({
      toolName: 'nested_handoff_agent_b',
      toolDescription: 'Runs nested handoff agent B.',
    });
    const outerAgent = new Agent({
      name: 'Outer parallel handoff agent',
      model: new FakeModel([
        parallelAgentToolCallResponse([nestedToolA.name, nestedToolB.name]),
        responseWithoutUsage(),
      ]),
      tools: [nestedToolA, nestedToolB],
    });

    await new Runner().run(outerAgent, 'hello');

    for (const sourceAgent of [sourceAgentA, sourceAgentB]) {
      const sourceTurn = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'turn' &&
          span.spanData.agent_name === sourceAgent.name,
      );
      const handoffSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'handoff' &&
          span.spanData.from_agent === sourceAgent.name,
      );
      expect(handoffSpan?.parentId).toBe(sourceTurn?.spanId);
    }
  });

  it('keeps parallel nested MCP list spans under their own agents in browser runtimes', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothServers = createBarrier(2);
    const serverA = new CoordinatedMCPServer(
      'Nested MCP server A',
      waitForBothServers,
    );
    const serverB = new CoordinatedMCPServer(
      'Nested MCP server B',
      waitForBothServers,
    );
    const nestedAgentA = new Agent({
      name: 'Nested MCP agent A',
      model: new FakeModel([responseWithoutUsage()]),
      mcpServers: [serverA],
    });
    const nestedAgentB = new Agent({
      name: 'Nested MCP agent B',
      model: new FakeModel([responseWithoutUsage()]),
      mcpServers: [serverB],
    });
    const nestedToolA = nestedAgentA.asTool({
      toolName: 'nested_mcp_agent_a',
      toolDescription: 'Runs nested MCP agent A.',
    });
    const nestedToolB = nestedAgentB.asTool({
      toolName: 'nested_mcp_agent_b',
      toolDescription: 'Runs nested MCP agent B.',
    });
    const outerAgent = new Agent({
      name: 'Outer parallel MCP agent',
      model: new FakeModel([
        parallelAgentToolCallResponse([nestedToolA.name, nestedToolB.name]),
        responseWithoutUsage(),
      ]),
      tools: [nestedToolA, nestedToolB],
    });

    await new Runner().run(outerAgent, 'hello');

    for (const [agent, server] of [
      [nestedAgentA, serverA],
      [nestedAgentB, serverB],
    ] as const) {
      const agentSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'agent' && span.spanData.name === agent.name,
      );
      const mcpSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'mcp_tools' &&
          span.spanData.server === server.name,
      );
      expect(mcpSpan?.parentId).toBe(agentSpan?.spanId);
    }
  });

  it('records parallel MCP tool metadata on the matching function spans in browser runtimes', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothTools = createBarrier(2);
    const serverA = new CoordinatedMCPToolServer(
      'Parallel MCP tool server A',
      'parallel_mcp_tool_a',
      waitForBothTools,
    );
    const serverB = new CoordinatedMCPToolServer(
      'Parallel MCP tool server B',
      'parallel_mcp_tool_b',
      waitForBothTools,
    );
    const agent = new Agent({
      name: 'Parallel MCP tool agent',
      model: new FakeModel([
        parallelAgentToolCallResponse([serverA.toolName, serverB.toolName]),
        responseWithoutUsage(),
      ]),
      mcpServers: [serverA, serverB],
    });

    await new Runner().run(agent, 'hello');

    for (const server of [serverA, serverB]) {
      const functionSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'function' &&
          span.spanData.name === server.toolName,
      );
      expect(functionSpan?.spanData).toMatchObject({
        mcp_data: { server: server.name },
      });
    }
  });

  it('captures distinct external trace parents for concurrent runs on a shared runner', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const agentA = new Agent({
      name: 'Concurrent external parent agent A',
      model: new CoordinatedModel(responseWithoutUsage(), waitForBothModels),
    });
    const agentB = new Agent({
      name: 'Concurrent external parent agent B',
      model: new CoordinatedModel(responseWithoutUsage(), waitForBothModels),
    });
    const runner = new Runner();

    const runUnderParent = async (agent: Agent, label: string) =>
      withTrace(`External workflow ${label}`, async (trace) => {
        const parent = createAgentSpan(
          { data: { name: `External parent ${label}` } },
          trace,
        );
        parent.start();
        try {
          await withTraceContext({ trace, span: parent }, () =>
            runner.run(agent, `hello ${label}`),
          );
        } finally {
          parent.end();
        }
        return parent;
      });

    const [parentA, parentB] = await Promise.all([
      runUnderParent(agentA, 'A'),
      runUnderParent(agentB, 'B'),
    ]);

    for (const [agent, parent] of [
      [agentA, parentA],
      [agentB, parentB],
    ] as const) {
      const agentSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'agent' && span.spanData.name === agent.name,
      );
      const taskSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'task' && span.spanId === agentSpan?.parentId,
      );
      expect(taskSpan?.parentId).toBe(parent.spanId);
      expect(taskSpan?.traceId).toBe(parent.traceId);
    }
  });

  it.each([true, false])(
    'creates distinct traces for concurrent top-level runs in browser runtimes (task/turn=%s)',
    async (includeTaskAndTurnSpans) => {
      setTracingContextStorage(new BrowserAsyncLocalStorage());
      const waitForBothModels = createBarrier(2);
      const agentA = new Agent({
        name: 'Concurrent top-level agent A',
        model: new CoordinatedModel(responseWithoutUsage(), waitForBothModels),
      });
      const agentB = new Agent({
        name: 'Concurrent top-level agent B',
        model: new CoordinatedModel(responseWithoutUsage(), waitForBothModels),
      });
      const runner = new Runner({
        tracing: { includeTaskAndTurnSpans },
      });

      await Promise.all([
        runner.run(agentA, 'hello A'),
        runner.run(agentB, 'hello B'),
      ]);

      const rootSpanForAgent = (agent: Agent) => {
        const agentSpan = processor.spansEnded.find(
          (span) =>
            span.spanData.type === 'agent' && span.spanData.name === agent.name,
        );
        return includeTaskAndTurnSpans
          ? processor.spansEnded.find(
              (span) =>
                span.spanData.type === 'task' &&
                span.spanId === agentSpan?.parentId,
            )
          : agentSpan;
      };
      expect(rootSpanForAgent(agentA)?.traceId).not.toBe(
        rootSpanForAgent(agentB)?.traceId,
      );
      if (!includeTaskAndTurnSpans) {
        expect(
          processor.spansEnded.some(
            (span) =>
              span.spanData.type === 'task' || span.spanData.type === 'turn',
          ),
        ).toBe(false);
      }
    },
  );

  it('keeps parallel model generation spans under their own turns in browser runtimes', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const agentA = new Agent({
      name: 'Parallel generation agent A',
      model: new CoordinatedTracingModel(
        'parallel-generation-model-a',
        waitForBothModels,
      ),
    });
    const agentB = new Agent({
      name: 'Parallel generation agent B',
      model: new CoordinatedTracingModel(
        'parallel-generation-model-b',
        waitForBothModels,
      ),
    });

    await Promise.all([
      new Runner().run(agentA, 'hello A'),
      new Runner().run(agentB, 'hello B'),
    ]);

    for (const [agent, model] of [
      [agentA, 'parallel-generation-model-a'],
      [agentB, 'parallel-generation-model-b'],
    ] as const) {
      const turnSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'turn' &&
          span.spanData.agent_name === agent.name,
      );
      const generationSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'generation' && span.spanData.model === model,
      );
      expect(generationSpan?.parentId).toBe(turnSpan?.spanId);
    }
  });

  it('keeps parallel streamed generation spans under their own turns in browser runtimes', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const agentA = new Agent({
      name: 'Parallel streamed generation agent A',
      model: new CoordinatedStreamingTracingModel(
        'parallel-streamed-generation-model-a',
        waitForBothModels,
      ),
    });
    const agentB = new Agent({
      name: 'Parallel streamed generation agent B',
      model: new CoordinatedStreamingTracingModel(
        'parallel-streamed-generation-model-b',
        waitForBothModels,
      ),
    });

    const [resultA, resultB] = await Promise.all([
      new Runner().run(agentA, 'hello A', { stream: true }),
      new Runner().run(agentB, 'hello B', { stream: true }),
    ]);
    await Promise.all([resultA.completed, resultB.completed]);

    for (const [agent, model] of [
      [agentA, 'parallel-streamed-generation-model-a'],
      [agentB, 'parallel-streamed-generation-model-b'],
    ] as const) {
      const turnSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'turn' &&
          span.spanData.agent_name === agent.name,
      );
      const generationSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'generation' && span.spanData.model === model,
      );
      expect(generationSpan?.parentId).toBe(turnSpan?.spanId);
    }
  });

  it('keeps parallel generation spans under their own agents when task and turn spans are disabled', async () => {
    setTracingContextStorage(new BrowserAsyncLocalStorage());
    const waitForBothModels = createBarrier(2);
    const agentA = new Agent({
      name: 'Opt-out parallel generation agent A',
      model: new CoordinatedTracingModel(
        'opt-out-parallel-generation-model-a',
        waitForBothModels,
      ),
    });
    const agentB = new Agent({
      name: 'Opt-out parallel generation agent B',
      model: new CoordinatedTracingModel(
        'opt-out-parallel-generation-model-b',
        waitForBothModels,
      ),
    });

    await Promise.all([
      new Runner({ tracing: { includeTaskAndTurnSpans: false } }).run(
        agentA,
        'hello A',
      ),
      new Runner({ tracing: { includeTaskAndTurnSpans: false } }).run(
        agentB,
        'hello B',
      ),
    ]);

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
    for (const [agent, model] of [
      [agentA, 'opt-out-parallel-generation-model-a'],
      [agentB, 'opt-out-parallel-generation-model-b'],
    ] as const) {
      const agentSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'agent' && span.spanData.name === agent.name,
      );
      const generationSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'generation' && span.spanData.model === model,
      );
      expect(generationSpan?.parentId).toBe(agentSpan?.spanId);
    }
  });

  it('keeps every model retry span under the same turn and counts failed attempts', async () => {
    const agent = new Agent({
      name: 'Retry tracing agent',
      model: new RetryingTracingModel(),
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.httpStatus([429]),
        },
      },
    });

    await new Runner().run(agent, 'hello');

    const turnSpan = spanOfType(processor, 'turn');
    const taskSpan = spanOfType(processor, 'task');
    const generationSpans = processor.spansEnded.filter(
      (span) => span.spanData.type === 'generation',
    );
    expect(generationSpans).toHaveLength(2);
    expect(
      generationSpans.every((span) => span.parentId === turnSpan.spanId),
    ).toBe(true);
    expect(generationSpans[0]?.error?.message).toBe('Rate limited');
    expect(taskSpan.spanData.usage).toMatchObject({
      requests: 2,
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
  });

  it('preserves the inherited task and turn opt-out when a nested agent tool overrides the tracing API key', async () => {
    const agent = createNestedAgentToolScenario({
      apiKey: 'nested-agent-key',
    });

    await new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    }).run(agent, 'hello');

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
  });

  it('merges inherited and nested agent tool tracing fields in both directions', () => {
    expect(
      mergeAgentToolRunConfig(
        { tracing: { includeTaskAndTurnSpans: false } },
        { tracing: { apiKey: 'nested-agent-key' } },
      ).tracing,
    ).toEqual({
      apiKey: 'nested-agent-key',
      includeTaskAndTurnSpans: false,
    });
    expect(
      mergeAgentToolRunConfig(
        { tracing: { apiKey: 'parent-key' } },
        { tracing: { includeTaskAndTurnSpans: false } },
      ).tracing,
    ).toEqual({
      apiKey: 'parent-key',
      includeTaskAndTurnSpans: false,
    });
    expect(
      mergeAgentToolRunConfig(
        {
          tracing: {
            apiKey: 'parent-key',
            includeTaskAndTurnSpans: false,
          },
        },
        {
          tracing: {
            apiKey: undefined,
            includeTaskAndTurnSpans: undefined,
          },
        },
      ).tracing,
    ).toEqual({
      apiKey: 'parent-key',
      includeTaskAndTurnSpans: false,
    });
  });

  it('allows a nested agent tool to override the parent tracing opt-out', async () => {
    const agent = createNestedAgentToolScenario({
      includeTaskAndTurnSpans: true,
    });

    await new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    }).run(agent, 'hello');

    expect(
      processor.spansEnded.filter((span) => span.spanData.type === 'task'),
    ).toHaveLength(1);
    expect(
      processor.spansEnded.filter((span) => span.spanData.type === 'turn'),
    ).toHaveLength(1);
  });

  it('keeps task and turn spans active until a streamed run completes', async () => {
    const agent = new Agent({
      name: 'Streamer',
      model: new StreamingModel(responseWithUsage()),
    });
    const runner = new Runner();

    const result = await runner.run(agent, 'hello', { stream: true });
    await result.completed;

    const taskSpan = spanOfType(processor, 'task');
    const agentSpan = spanOfType(processor, 'agent');
    const turnSpan = spanOfType(processor, 'turn');
    expect(agentSpan.parentId).toBe(taskSpan.spanId);
    expect(turnSpan.parentId).toBe(agentSpan.spanId);
    expect(taskSpan.spanData.usage).toMatchObject({ requests: 1 });
    expect(turnSpan.spanData.usage).toMatchObject({ input_tokens: 12 });
  });

  it('ends task and turn spans exactly once when a streamed run is cancelled', async () => {
    const agent = new Agent({
      name: 'Cancelled streamer',
      model: new HangingStreamingModel(),
    });
    const result = await new Runner().run(agent, 'hello', { stream: true });
    const reader = (result.toStream() as any).getReader();

    await new Promise((resolve) => setImmediate(resolve));
    await reader.cancel('stop');
    await result._getStreamLoopPromise();

    for (const type of ['task', 'agent', 'turn']) {
      expect(
        processor.spansStarted.filter((span) => span.spanData.type === type),
      ).toHaveLength(1);
      expect(
        processor.spansEnded.filter((span) => span.spanData.type === type),
      ).toHaveLength(1);
    }
    expect(result.state._currentTurnInProgress).toBe(true);
  });

  it.each([false, true])(
    'keeps helper parent spans open until a streamed runner completes (browser=%s)',
    async (browser) => {
      if (browser) {
        setTracingContextStorage(new BrowserAsyncLocalStorage());
      }
      const agent = new Agent({
        name: 'Helper parent streamer',
        model: new HangingStreamingModel(),
      });

      const result = await withTrace('Helper parent workflow', async () =>
        withAgentSpan(
          async () => new Runner().run(agent, 'hello', { stream: true }),
          { data: { name: 'Helper parent' } },
        ),
      );
      const helperParent = processor.spansStarted.find(
        (span) =>
          span.spanData.type === 'agent' &&
          span.spanData.name === 'Helper parent',
      );
      const taskSpan = processor.spansStarted.find(
        (span) => span.spanData.type === 'task',
      );

      expect(helperParent?.endedAt).toBeNull();
      expect(taskSpan?.parentId).toBe(helperParent?.spanId);

      const reader = (result.toStream() as any).getReader();
      await new Promise((resolve) => setImmediate(resolve));
      await reader.cancel('stop');
      await result._getStreamLoopPromise();

      expect(taskSpan?.endedAt).not.toBeNull();
      expect(helperParent?.endedAt).not.toBeNull();
      expect(processor.spanErrorsAtEnd.get(helperParent!.spanId)).toBeNull();
      expect(Date.parse(taskSpan!.endedAt!)).toBeLessThanOrEqual(
        Date.parse(helperParent!.endedAt!),
      );
    },
  );

  it.each([false, true])(
    'marks helper parent spans when a streamed runner fails (browser=%s)',
    async (browser) => {
      if (browser) {
        setTracingContextStorage(new BrowserAsyncLocalStorage());
      }
      const failureError = Object.assign(new Error('stream model failed'), {
        data: { phase: 'model stream' },
      });
      const agent = new Agent({
        name: 'Helper parent failure streamer',
        model: new FailingModel(failureError),
      });

      const result = await withTrace(
        'Helper parent failure workflow',
        async () =>
          withAgentSpan(
            async () => new Runner().run(agent, 'hello', { stream: true }),
            { data: { name: 'Helper parent failure' } },
          ),
      );

      await expect(result.completed).rejects.toBe(failureError);
      await result._getStreamLoopPromise();
      await Promise.resolve();

      const helperParent = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'agent' &&
          span.spanData.name === 'Helper parent failure',
      );
      expect(helperParent).toBeDefined();
      expect(processor.spanErrorsAtEnd.get(helperParent!.spanId)).toMatchObject(
        {
          message: 'stream model failed',
          data: { phase: 'model stream' },
        },
      );
    },
  );

  it('attributes stream abort reconciliation usage to the open task and turn', async () => {
    const agent = new Agent({
      name: 'Abort reconciliation usage agent',
      model: new AbortReconciliationUsageModel(),
    });

    const result = await new Runner().run(agent, 'hello', {
      stream: true,
      conversationId: 'conversation-for-abort-reconciliation',
    });
    await result.completed;

    expect(result.state._context.usage).toMatchObject({
      requests: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(spanOfType(processor, 'task').spanData.usage).toMatchObject({
      requests: 1,
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
    expect(spanOfType(processor, 'turn').spanData.usage).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
    });
  });

  it('includes session compaction usage in task spans for non-streaming and streaming runs', async () => {
    const runner = new Runner();
    const nonStreamingAgent = new Agent({
      name: 'Non-streaming compaction agent',
      model: new FakeModel([responseWithUsage()]),
    });

    await runner.run(nonStreamingAgent, 'hello', {
      session: new UsageCompactionSession(),
    });

    const nonStreamingTaskSpan = spanOfType(processor, 'task');
    expect(nonStreamingTaskSpan.spanData.usage).toMatchObject({
      requests: 2,
      input_tokens: 17,
      output_tokens: 6,
      total_tokens: 23,
    });

    processor.spansStarted.length = 0;
    processor.spansEnded.length = 0;

    const streamingAgent = new Agent({
      name: 'Streaming compaction agent',
      model: new StreamingModel(responseWithUsage()),
    });
    const streamingResult = await runner.run(streamingAgent, 'hello', {
      stream: true,
      session: new UsageCompactionSession(),
    });
    await streamingResult.completed;

    const streamingTaskSpan = spanOfType(processor, 'task');
    expect(streamingTaskSpan.spanData.usage).toEqual(
      nonStreamingTaskSpan.spanData.usage,
    );
  });

  it.each([false, true])(
    'ends task and turn spans when session compaction fails (stream=%s)',
    async (stream) => {
      const agent = new Agent({
        name: stream
          ? 'Streaming compaction failure agent'
          : 'Compaction failure agent',
        model: stream
          ? new StreamingModel(responseWithUsage())
          : new FakeModel([responseWithUsage()]),
      });
      const runner = new Runner();
      const session = new FailingCompactionSession();

      if (stream) {
        const result = await runner.run(agent, 'hello', {
          stream: true,
          session,
        });
        await expect(result.completed).rejects.toBe(session.error);
      } else {
        await expect(runner.run(agent, 'hello', { session })).rejects.toBe(
          session.error,
        );
      }

      for (const type of ['task', 'agent', 'turn']) {
        const started = processor.spansStarted.filter(
          (span) => span.spanData.type === type,
        );
        const ended = processor.spansEnded.filter(
          (span) => span.spanData.type === type,
        );
        expect(started, `started ${type} spans`).toHaveLength(1);
        expect(ended, `ended ${type} spans`).toHaveLength(1);
        expect(ended[0]?.endedAt).not.toBeNull();
      }
      expect(spanOfType(processor, 'task').spanData.usage).toMatchObject({
        requests: 1,
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
      });
      const taskSpan = spanOfType(processor, 'task');
      expect(processor.spanErrorsAtEnd.get(taskSpan.spanId)).toEqual({
        message: 'Error in agent run',
        data: { error: String(session.error) },
      });
      expect(spanOfType(processor, 'turn').error).toBeNull();
    },
  );

  it('marks the task span when non-streaming session writes fail', async () => {
    const agent = new Agent({
      name: 'Session write failure agent',
      model: new FakeModel([responseWithUsage()]),
    });

    const session = new FailingAddItemsSession();
    await expect(new Runner().run(agent, 'hello', { session })).rejects.toBe(
      session.error,
    );

    const taskSpan = spanOfType(processor, 'task');
    expect(processor.spanErrorsAtEnd.get(taskSpan.spanId)).toEqual({
      message: 'Error in agent run',
      data: { error: String(session.error) },
    });
    expect(spanOfType(processor, 'turn').error).toBeNull();
  });

  it.each([false, true])(
    'marks the task span when sandbox finalization fails (stream=%s)',
    async (stream) => {
      const cleanupError = new Error('sandbox cleanup failed');
      const cleanupSpy = vi
        .spyOn(SandboxRuntimeManager.prototype, 'cleanup')
        .mockRejectedValue(cleanupError);
      const agent = new Agent({
        name: stream
          ? 'Streaming sandbox cleanup failure agent'
          : 'Sandbox cleanup failure agent',
        model: stream
          ? new StreamingModel(responseWithUsage())
          : new FakeModel([responseWithUsage()]),
      });

      try {
        if (stream) {
          const result = await new Runner().run(agent, 'hello', {
            stream: true,
          });
          await expect(result.completed).rejects.toBe(cleanupError);
        } else {
          await expect(new Runner().run(agent, 'hello')).rejects.toBe(
            cleanupError,
          );
        }
      } finally {
        cleanupSpy.mockRestore();
      }

      const taskSpan = spanOfType(processor, 'task');
      expect(processor.spanErrorsAtEnd.get(taskSpan.spanId)).toEqual({
        message: 'Error in agent run',
        data: { error: String(cleanupError) },
      });
      expect(spanOfType(processor, 'turn').error).toBeNull();
    },
  );

  it.each([false, true])(
    'keeps the turn span open until output guardrails settle (stream=%s)',
    async (stream) => {
      let signalGuardrailStarted: () => void = () => {};
      const guardrailStarted = new Promise<void>((resolve) => {
        signalGuardrailStarted = resolve;
      });
      let releaseGuardrail: () => void = () => {};
      const guardrailRelease = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const agent = new Agent({
        name: stream
          ? 'Streaming output guardrail tracing agent'
          : 'Output guardrail tracing agent',
        model: stream
          ? new StreamingModel(responseWithoutUsage())
          : new FakeModel([responseWithoutUsage()]),
        outputGuardrails: [
          {
            name: 'delayed output guardrail',
            execute: async () => {
              signalGuardrailStarted();
              await guardrailRelease;
              return {
                tripwireTriggered: true,
                outputInfo: { reason: 'blocked' },
              };
            },
          },
        ],
      });
      const runner = new Runner();

      let completion: Promise<unknown>;
      if (stream) {
        const result = await runner.run(agent, 'hello', { stream: true });
        completion = result.completed;
      } else {
        completion = runner.run(agent, 'hello');
      }

      await guardrailStarted;
      const turnSpan = processor.spansStarted.find(
        (span) => span.spanData.type === 'turn',
      );
      const guardrailSpan = processor.spansStarted.find(
        (span) => span.spanData.type === 'guardrail',
      );
      expect(turnSpan?.endedAt).toBeNull();
      expect(guardrailSpan?.endedAt).toBeNull();

      releaseGuardrail();
      await expect(completion).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );

      expect(guardrailSpan?.endedAt).not.toBeNull();
      expect(turnSpan?.endedAt).not.toBeNull();
      expect(Date.parse(guardrailSpan!.endedAt!)).toBeLessThanOrEqual(
        Date.parse(turnSpan!.endedAt!),
      );
    },
  );

  it.each(
    ['model', 'tool', 'guardrail'].flatMap((failure) =>
      [false, true].map((stream) => ({ failure, stream })),
    ),
  )(
    'marks task and turn spans when a $failure failure escapes (stream=$stream)',
    async ({ failure, stream }) => {
      const failureError = new Error(`${failure} failure`);
      const failingTool = tool({
        name: 'failing_tool',
        description: 'Fails for tracing verification.',
        parameters: z.object({}),
        execute: async () => {
          throw failureError;
        },
        errorFunction: null,
      });
      const response =
        failure === 'tool'
          ? approvalResponse(failingTool.name)
          : responseWithoutUsage();
      const agent = new Agent({
        name: `${failure} failure tracing agent`,
        model:
          failure === 'model'
            ? new FailingModel(failureError)
            : stream
              ? new StreamingModel(response)
              : new FakeModel([response]),
        tools: failure === 'tool' ? [failingTool] : [],
        outputGuardrails:
          failure === 'guardrail'
            ? [
                {
                  name: 'failing output guardrail',
                  execute: async () => {
                    throw failureError;
                  },
                },
              ]
            : [],
      });
      const runner = new Runner();

      let completion: Promise<unknown>;
      if (stream) {
        const result = await runner.run(agent, 'hello', { stream: true });
        completion = result.completed;
      } else {
        completion = runner.run(agent, 'hello');
      }

      let escapedError: unknown;
      try {
        await completion;
      } catch (error) {
        escapedError = error;
      }
      expect(escapedError).toBeDefined();

      for (const type of ['task', 'turn']) {
        const span = spanOfType(processor, type);
        const expectedError = {
          message: 'Error in agent run',
          data: { error: String(escapedError) },
        };
        expect(span.error).toEqual(expectedError);
        expect(processor.spanErrorsAtEnd.get(span.spanId)).toEqual(
          expectedError,
        );
      }
    },
  );

  it.each([false, true])(
    'does not mark a recovered task as failed or replace its turn error (stream=%s)',
    async (stream) => {
      const response: ModelResponse = {
        output: [fakeModelMessage('not valid json')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: 'Recovered tracing agent',
        outputType: z.object({ summary: z.string() }),
        model: stream
          ? new StreamingModel(response)
          : new FakeModel([response]),
      });
      const runner = new Runner();
      const options = {
        errorHandlers: {
          invalidFinalOutput: () => ({
            finalOutput: { summary: 'safe fallback' },
          }),
        },
      };

      if (stream) {
        const result = await runner.run(agent, 'hello', {
          ...options,
          stream: true,
        });
        await result.completed;
        expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
      } else {
        const result = await runner.run(agent, 'hello', options);
        expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
      }

      expect(spanOfType(processor, 'task').error).toBeNull();
      expect(spanOfType(processor, 'turn').error).toMatchObject({
        message: expect.stringContaining('Invalid output type'),
      });
    },
  );

  it.each([false, true])(
    'marks task and turn spans when an error handler fails (stream=%s)',
    async (stream) => {
      const response: ModelResponse = {
        output: [fakeModelMessage('not valid json')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: 'Failed error handler tracing agent',
        outputType: z.object({ summary: z.string() }),
        model: stream
          ? new StreamingModel(response)
          : new FakeModel([response]),
      });
      const handlerError = new Error('error handler failure');
      const options = {
        errorHandlers: {
          invalidFinalOutput: () => {
            throw handlerError;
          },
        },
      };

      let completion: Promise<unknown>;
      if (stream) {
        const result = await new Runner().run(agent, 'hello', {
          ...options,
          stream: true,
        });
        completion = result.completed;
      } else {
        completion = new Runner().run(agent, 'hello', options);
      }
      await expect(completion).rejects.toBe(handlerError);

      for (const type of ['task', 'turn']) {
        const span = spanOfType(processor, type);
        expect(processor.spanErrorsAtEnd.get(span.spanId)).toEqual({
          message: 'Error in agent run',
          data: { error: String(handlerError) },
        });
      }
    },
  );

  it('omits task and turn spans from streamed runs when disabled', async () => {
    const agent = new Agent({
      name: 'Streamer',
      model: new StreamingModel(responseWithUsage()),
    });
    const runner = new Runner({
      tracing: { includeTaskAndTurnSpans: false },
    });

    const result = await runner.run(agent, 'hello', { stream: true });
    await result.completed;

    expect(
      processor.spansEnded.some(
        (span) =>
          span.spanData.type === 'task' || span.spanData.type === 'turn',
      ),
    ).toBe(false);
    expect(spanOfType(processor, 'agent').parentId).toBeNull();
  });

  it('uses invocation-local usage and a fresh agent span when resuming', async () => {
    const agent = new Agent({
      name: 'Resumed agent',
      model: new FakeModel([responseWithUsage()]),
    });
    const state = new RunState(new RunContext(), 'hello', agent, 10);
    state._context.usage.add(
      new Usage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
    );
    const trace = getGlobalTraceProvider().createTrace({
      name: 'Resumed workflow',
    });
    const restoredAgentSpan = createAgentSpan(
      { data: { name: 'Resumed agent' } },
      trace,
    );
    restoredAgentSpan.start();
    state._trace = trace;
    state.setCurrentAgentSpan(restoredAgentSpan);

    await new Runner().run(agent, state);

    const taskSpan = spanOfType(processor, 'task');
    const turnSpan = spanOfType(processor, 'turn');
    const freshAgentSpan = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanId !== restoredAgentSpan.spanId,
    );
    expect(restoredAgentSpan.endedAt).not.toBeNull();
    expect(freshAgentSpan?.parentId).toBe(taskSpan.spanId);
    expect(turnSpan.parentId).toBe(freshAgentSpan?.spanId);
    expect(taskSpan.spanData.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
    });
  });

  it.each([false, true])(
    'ends an interrupted agent span before its task span (stream=%s)',
    async (stream) => {
      const approvalTool = tool({
        name: stream
          ? 'streaming_interrupted_span_tool'
          : 'interrupted_span_tool',
        description: 'Requires approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const response = approvalResponse(approvalTool.name);
      const agent = new Agent({
        name: stream
          ? 'Streaming interrupted span agent'
          : 'Interrupted span agent',
        model: stream
          ? new StreamingModel(response)
          : new FakeModel([response]),
        tools: [approvalTool],
      });

      const result = stream
        ? await new Runner().run(agent, 'hello', { stream: true })
        : await new Runner().run(agent, 'hello');
      if ('completed' in result) {
        await result.completed;
      }

      expect(result.interruptions).toHaveLength(1);
      const agentSpan = result.state._currentAgentSpan;
      const taskSpan = spanOfType(processor, 'task');
      expect(agentSpan?.endedAt).not.toBeNull();
      expect(processor.spansEnded).toContain(agentSpan);
      expect(Date.parse(agentSpan!.endedAt!)).toBeLessThanOrEqual(
        Date.parse(taskSpan.endedAt!),
      );
    },
  );

  it.each([false, true])(
    'preserves an interrupted agent span when task and turn spans are disabled (stream=%s)',
    async (stream) => {
      const approvalTool = tool({
        name: stream
          ? 'streaming_opt_out_interrupted_span_tool'
          : 'opt_out_interrupted_span_tool',
        description: 'Requires approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const responses = [
        approvalResponse(approvalTool.name),
        responseWithoutUsage(),
      ];
      const agent = new Agent({
        name: stream
          ? 'Streaming opt-out interrupted span agent'
          : 'Opt-out interrupted span agent',
        model: stream
          ? new StreamingModel(responses)
          : new FakeModel(responses),
        tools: [approvalTool],
      });
      const runner = new Runner({
        tracing: { includeTaskAndTurnSpans: false },
      });

      const result = stream
        ? await runner.run(agent, 'hello', { stream: true })
        : await runner.run(agent, 'hello');
      if ('completed' in result) {
        await result.completed;
      }

      expect(result.interruptions).toHaveLength(1);
      const preservedAgentSpan = result.state._currentAgentSpan;
      expect(preservedAgentSpan?.endedAt).toBeNull();
      expect(
        processor.spansStarted.some(
          (span) =>
            span.spanData.type === 'task' || span.spanData.type === 'turn',
        ),
      ).toBe(false);

      result.state.approve(result.interruptions[0]);
      const startedBeforeResume = processor.spansStarted.length;
      const endedBeforeResume = processor.spansEnded.length;
      const resumed = stream
        ? await runner.run(agent, result.state, { stream: true })
        : await runner.run(agent, result.state);
      if ('completed' in resumed) {
        await resumed.completed;
      }

      const resumedStartedSpans =
        processor.spansStarted.slice(startedBeforeResume);
      const resumedEndedSpans = processor.spansEnded.slice(endedBeforeResume);
      const functionSpan = resumedEndedSpans.find(
        (span) => span.spanData.type === 'function',
      );
      expect(
        resumedStartedSpans.some((span) => span.spanData.type === 'agent'),
      ).toBe(false);
      expect(functionSpan?.parentId).toBe(preservedAgentSpan?.spanId);
      expect(preservedAgentSpan?.endedAt).not.toBeNull();
    },
  );

  it.each([false, true])(
    'replaces an ended agent span when an approval resume opts out of task and turn spans (stream=%s)',
    async (stream) => {
      const approvalTool = tool({
        name: stream
          ? 'streaming_mixed_config_approval_tool'
          : 'mixed_config_approval_tool',
        description: 'Requires approval and then fails.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => {
          throw new Error('mixed-config approved tool failed');
        },
        errorFunction: null,
      });
      const agent = new Agent({
        name: stream
          ? 'Streaming mixed-config approval agent'
          : 'Mixed-config approval agent',
        model: stream
          ? new StreamingModel([approvalResponse(approvalTool.name)])
          : new FakeModel([approvalResponse(approvalTool.name)]),
        tools: [approvalTool],
      });

      const first = stream
        ? await new Runner().run(agent, 'hello', { stream: true })
        : await new Runner().run(agent, 'hello');
      if ('completed' in first) {
        await first.completed;
      }
      expect(first.interruptions).toHaveLength(1);
      const interruptedAgentSpan = first.state._currentAgentSpan;
      expect(interruptedAgentSpan?.endedAt).not.toBeNull();
      first.state.approve(first.interruptions[0]);

      const startedBeforeResume = processor.spansStarted.length;
      const endedBeforeResume = processor.spansEnded.length;
      const optOutRunner = new Runner({
        tracing: { includeTaskAndTurnSpans: false },
      });
      if (stream) {
        const resumed = await optOutRunner.run(agent, first.state, {
          stream: true,
        });
        await expect(resumed.completed).rejects.toThrow(
          'mixed-config approved tool failed',
        );
      } else {
        await expect(optOutRunner.run(agent, first.state)).rejects.toThrow(
          'mixed-config approved tool failed',
        );
      }

      const resumedStartedSpans =
        processor.spansStarted.slice(startedBeforeResume);
      const resumedEndedSpans = processor.spansEnded.slice(endedBeforeResume);
      const resumedAgentSpan = resumedStartedSpans.find(
        (span) =>
          span.spanData.type === 'agent' &&
          span.spanId !== interruptedAgentSpan?.spanId,
      );
      const functionSpan = resumedEndedSpans.find(
        (span) => span.spanData.type === 'function',
      );

      expect(resumedAgentSpan?.parentId).toBeNull();
      expect(functionSpan?.parentId).toBe(resumedAgentSpan?.spanId);
      expect(resumedAgentSpan?.error).toMatchObject({
        message: 'Error in agent run',
      });
      expect(resumedAgentSpan?.endedAt).not.toBeNull();
      expect(
        resumedStartedSpans.some(
          (span) =>
            span.spanData.type === 'task' || span.spanData.type === 'turn',
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    'finishes a preserved opt-out agent span when tracing is disabled for resume (stream=%s)',
    async (stream) => {
      const approvalTool = tool({
        name: stream
          ? 'streaming_disable_tracing_on_resume_tool'
          : 'disable_tracing_on_resume_tool',
        description: 'Requires approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const responses = [
        approvalResponse(approvalTool.name),
        responseWithoutUsage(),
      ];
      const agent = new Agent({
        name: stream
          ? 'Streaming disable tracing on resume agent'
          : 'Disable tracing on resume agent',
        model: stream
          ? new StreamingModel(responses)
          : new FakeModel(responses),
        tools: [approvalTool],
      });
      const firstRunner = new Runner({
        tracing: { includeTaskAndTurnSpans: false },
      });

      const first = stream
        ? await firstRunner.run(agent, 'hello', { stream: true })
        : await firstRunner.run(agent, 'hello');
      if ('completed' in first) {
        await first.completed;
      }
      const preservedAgentSpan = first.state._currentAgentSpan;
      expect(preservedAgentSpan?.endedAt).toBeNull();
      first.state.approve(first.interruptions[0]);

      const disabledRunner = new Runner({ tracingDisabled: true });
      const resumed = stream
        ? await disabledRunner.run(agent, first.state, { stream: true })
        : await disabledRunner.run(agent, first.state);
      if ('completed' in resumed) {
        await resumed.completed;
      }

      expect(preservedAgentSpan?.endedAt).not.toBeNull();
      expect(
        processor.spansEnded.filter(
          (span) => span.spanId === preservedAgentSpan?.spanId,
        ),
      ).toHaveLength(1);
      expect(resumed.state._trace).toBeNull();
      expect(resumed.state._currentAgentSpan).toBeUndefined();
    },
  );

  it('creates an agent parent under the resumed task for an approved tool', async () => {
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const agent = new Agent({
      name: 'Approval agent',
      model: new FakeModel([
        approvalResponse(approvalTool.name),
        responseWithUsage(),
      ]),
      tools: [approvalTool],
    });
    const runner = new Runner();

    const first = await runner.run(agent, 'hello');
    expect(first.interruptions).toHaveLength(1);
    const restoredState = await RunState.fromString(
      agent,
      first.state.toString(),
    );
    const restoredAgentSpan = restoredState._currentAgentSpan;
    expect(restoredAgentSpan).toBeDefined();

    expect(restoredState.getInterruptions()).toHaveLength(1);
    restoredState.approve(restoredState.getInterruptions()[0]);
    const endedBeforeResume = processor.spansEnded.length;
    await runner.run(agent, restoredState);

    const resumedSpans = processor.spansEnded.slice(endedBeforeResume);
    const functionSpan = resumedSpans.find(
      (span) => span.spanData.type === 'function',
    );
    const turnSpan = resumedSpans.find((span) => span.spanData.type === 'turn');
    const taskSpan = resumedSpans.find((span) => span.spanData.type === 'task');
    const resumedAgentSpan = resumedSpans.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanId !== restoredAgentSpan?.spanId,
    );
    expect(
      processor.spansEnded.filter(
        (span) => span.spanId === restoredAgentSpan?.spanId,
      ),
    ).toHaveLength(1);
    expect(taskSpan?.parentId).toBeNull();
    expect(restoredAgentSpan?.endedAt).not.toBeNull();
    expect(resumedAgentSpan?.parentId).toBe(taskSpan?.spanId);
    expect(resumedAgentSpan?.spanData.tools).toContain(approvalTool.name);
    expect(functionSpan?.parentId).toBe(turnSpan?.spanId);
    expect(turnSpan?.parentId).toBe(resumedAgentSpan?.spanId);
  });

  it('creates an agent parent under the resumed task for streamed approval resumes', async () => {
    const approvalTool = tool({
      name: 'streaming_approval_tool',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const agent = new Agent({
      name: 'Streaming approval agent',
      model: new StreamingModel([
        approvalResponse(approvalTool.name),
        responseWithUsage(),
      ]),
      tools: [approvalTool],
    });
    const runner = new Runner();

    const first = await runner.run(agent, 'hello', { stream: true });
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    const restoredAgentSpan = first.state._currentAgentSpan;
    expect(restoredAgentSpan).toBeDefined();

    first.state.approve(first.interruptions[0]);
    const endedBeforeResume = processor.spansEnded.length;
    const resumed = await runner.run(agent, first.state, { stream: true });
    await resumed.completed;

    const resumedSpans = processor.spansEnded.slice(endedBeforeResume);
    const functionSpan = resumedSpans.find(
      (span) => span.spanData.type === 'function',
    );
    const turnSpan = resumedSpans.find((span) => span.spanData.type === 'turn');
    const taskSpan = resumedSpans.find((span) => span.spanData.type === 'task');
    const resumedAgentSpan = resumedSpans.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanId !== restoredAgentSpan?.spanId,
    );
    expect(taskSpan?.parentId).toBeNull();
    expect(restoredAgentSpan?.endedAt).not.toBeNull();
    expect(resumedAgentSpan?.parentId).toBe(taskSpan?.spanId);
    expect(functionSpan?.parentId).toBe(turnSpan?.spanId);
    expect(turnSpan?.parentId).toBe(resumedAgentSpan?.spanId);
  });

  it.each([false, true])(
    'keeps rejected approval resumes in the resumed turn (stream=%s)',
    async (stream) => {
      let executions = 0;
      const approvalTool = tool({
        name: stream ? 'streaming_rejected_tool' : 'rejected_tool',
        description: 'Requires approval and must not execute when rejected.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => {
          executions += 1;
          return 'unexpected execution';
        },
      });
      const agentName = stream
        ? 'Streaming rejection agent'
        : 'Rejection agent';
      const responses = [
        approvalResponse(approvalTool.name),
        responseWithUsage(),
      ];
      const agent = new Agent({
        name: agentName,
        model: stream
          ? new StreamingModel(responses)
          : new FakeModel(responses),
        tools: [approvalTool],
      });
      const runner = new Runner();

      const first = stream
        ? await runner.run(agent, 'hello', { stream: true })
        : await runner.run(agent, 'hello');
      if ('completed' in first) {
        await first.completed;
      }
      expect(first.interruptions).toHaveLength(1);
      const interruptedAgentSpan = first.state._currentAgentSpan;
      first.state.reject(first.interruptions[0]);

      const endedBeforeResume = processor.spansEnded.length;
      const resumed = stream
        ? await runner.run(agent, first.state, { stream: true })
        : await runner.run(agent, first.state);
      if ('completed' in resumed) {
        await resumed.completed;
      }

      expect(executions).toBe(0);
      const resumedSpans = processor.spansEnded.slice(endedBeforeResume);
      const taskSpan = resumedSpans.find(
        (span) => span.spanData.type === 'task' && span.parentId === null,
      );
      const agentSpan = resumedSpans.find(
        (span) =>
          span.spanData.type === 'agent' &&
          span.spanData.name === agentName &&
          span.spanId !== interruptedAgentSpan?.spanId,
      );
      const turnSpans = resumedSpans.filter(
        (span) =>
          span.spanData.type === 'turn' &&
          span.spanData.agent_name === agentName,
      );
      const functionSpan = resumedSpans.find(
        (span) => span.spanData.type === 'function',
      );

      expect(turnSpans).toHaveLength(1);
      expect(agentSpan?.parentId).toBe(taskSpan?.spanId);
      expect(turnSpans[0]?.parentId).toBe(agentSpan?.spanId);
      expect(functionSpan?.parentId).toBe(turnSpans[0]?.spanId);
      expect(turnSpans[0]?.spanData.usage).toMatchObject({
        input_tokens: 12,
        output_tokens: 4,
      });
    },
  );

  it('attributes approved agent-tool usage to the resumed turn', async () => {
    const agent = createApprovedAgentToolScenario(false);
    const runner = new Runner();

    const first = await runner.run(agent, 'hello');
    expect(first.interruptions).toHaveLength(1);
    const interruptedAgentSpan = first.state._currentAgentSpan;
    first.state.approve(first.interruptions[0]);

    const endedBeforeResume = processor.spansEnded.length;
    await runner.run(agent, first.state);

    const resumedSpans = processor.spansEnded.slice(endedBeforeResume);
    const functionSpan = resumedSpans.find(
      (span) => span.spanData.type === 'function',
    );
    const turnSpans = resumedSpans.filter(
      (span) =>
        span.spanData.type === 'turn' &&
        span.spanData.agent_name === 'Outer approval agent',
    );
    expect(turnSpans).toHaveLength(1);
    const [turnSpan] = turnSpans;
    const taskSpan = resumedSpans.find(
      (span) => span.spanData.type === 'task' && span.parentId === null,
    );
    const resumedAgentSpan = resumedSpans.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === 'Outer approval agent' &&
        span.spanId !== interruptedAgentSpan?.spanId,
    );
    expect(resumedAgentSpan?.parentId).toBe(taskSpan?.spanId);
    expect(turnSpan?.parentId).toBe(resumedAgentSpan?.spanId);
    expect(functionSpan?.parentId).toBe(turnSpan?.spanId);
    expect(turnSpan?.spanData.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      cached_input_tokens: 2,
      cache_write_input_tokens: 3,
    });
  });

  it('attributes approved agent-tool usage to the resumed streamed turn', async () => {
    const agent = createApprovedAgentToolScenario(true);
    const runner = new Runner();

    const first = await runner.run(agent, 'hello', { stream: true });
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    const interruptedAgentSpan = first.state._currentAgentSpan;
    first.state.approve(first.interruptions[0]);

    const endedBeforeResume = processor.spansEnded.length;
    const resumed = await runner.run(agent, first.state, { stream: true });
    await resumed.completed;

    const resumedSpans = processor.spansEnded.slice(endedBeforeResume);
    const functionSpan = resumedSpans.find(
      (span) => span.spanData.type === 'function',
    );
    const turnSpans = resumedSpans.filter(
      (span) =>
        span.spanData.type === 'turn' &&
        span.spanData.agent_name === 'Outer approval agent',
    );
    expect(turnSpans).toHaveLength(1);
    const [turnSpan] = turnSpans;
    const taskSpan = resumedSpans.find(
      (span) => span.spanData.type === 'task' && span.parentId === null,
    );
    const resumedAgentSpan = resumedSpans.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanData.name === 'Outer approval agent' &&
        span.spanId !== interruptedAgentSpan?.spanId,
    );
    expect(resumedAgentSpan?.parentId).toBe(taskSpan?.spanId);
    expect(turnSpan?.parentId).toBe(resumedAgentSpan?.spanId);
    expect(functionSpan?.parentId).toBe(turnSpan?.spanId);
    expect(turnSpan?.spanData.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      cached_input_tokens: 2,
      cache_write_input_tokens: 3,
    });
  });

  it('marks the resumed task agent span when an approved tool fails', async () => {
    const approvalTool = tool({
      name: 'failing_approval_tool',
      description: 'Requires approval and then fails.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => {
        throw new Error('approved tool failed');
      },
      errorFunction: null,
    });
    const agent = new Agent({
      name: 'Failing approval agent',
      model: new FakeModel([approvalResponse(approvalTool.name)]),
      tools: [approvalTool],
    });
    const runner = new Runner();

    const first = await runner.run(agent, 'hello');
    expect(first.interruptions).toHaveLength(1);
    const restoredAgentSpan = first.state._currentAgentSpan;
    expect(restoredAgentSpan).toBeDefined();

    first.state.approve(first.interruptions[0]);
    const endedBeforeResume = processor.spansEnded.length;
    const startedBeforeResume = processor.spansStarted.length;
    await expect(runner.run(agent, first.state)).rejects.toThrow(
      'approved tool failed',
    );

    const resumedSpans = processor.spansEnded.slice(endedBeforeResume);
    const resumedStartedSpans =
      processor.spansStarted.slice(startedBeforeResume);
    const functionSpan = resumedSpans.find(
      (span) => span.spanData.type === 'function',
    );
    const turnSpan = resumedSpans.find((span) => span.spanData.type === 'turn');
    const taskSpan = resumedSpans.find((span) => span.spanData.type === 'task');
    const resumedAgentSpan = resumedStartedSpans.find(
      (span) =>
        span.spanData.type === 'agent' &&
        span.spanId !== restoredAgentSpan?.spanId,
    );
    expect(restoredAgentSpan?.endedAt).not.toBeNull();
    expect(resumedAgentSpan?.parentId).toBe(taskSpan?.spanId);
    expect(functionSpan?.parentId).toBe(turnSpan?.spanId);
    expect(turnSpan?.parentId).toBe(resumedAgentSpan?.spanId);
    expect(resumedAgentSpan?.error).toMatchObject({
      message: 'Error in agent run',
    });
    expect(turnSpan?.error).toMatchObject({
      message: 'Error in agent run',
    });
    expect(taskSpan?.error).toMatchObject({
      message: 'Error in agent run',
    });
  });
});
