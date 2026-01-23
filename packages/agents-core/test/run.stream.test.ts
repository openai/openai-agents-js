import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AgentInputItem,
  MaxTurnsExceededError,
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
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  FunctionCallItem,
  tool,
  user,
  Session,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  RunState,
} from '../src';
import { FakeModel, FakeModelProvider, fakeModelMessage } from './stubs';
import * as protocol from '../src/types/protocol';
import * as sessionPersistence from '../src/runner/sessionPersistence';
import type { GuardrailFunctionOutput } from '../src/guardrail';
import { ServerConversationTracker } from '../src/runner/conversation';
import logger from '../src/logger';
import { getEventListeners } from 'node:events';

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

// Test for unhandled rejection when stream loop throws

describe('Runner.run (streaming)', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not emit unhandled rejection when stream loop fails', async () => {
    const agent = new Agent({ name: 'StreamFail', model: new FakeModel() });

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
    const agent = new Agent({ name: 'StreamError', model: new FakeModel() });

    const result = await run(agent, 'hi', { stream: true });
    await expect(result.completed).rejects.toThrow('Not implemented');

    expect((result.error as Error).message).toBe('Not implemented');
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

  it('emits agent_updated_stream_event with new agent on handoff', async () => {
    class SimpleStreamingModel implements Model {
      constructor(private resp: ModelResponse) {}
      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return this.resp;
      }
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        yield {
          type: 'response_done',
          response: {
            id: 'r',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: this.resp.output,
          },
        } as any;
      }
    }

    const agentB = new Agent({
      name: 'B',
      model: new SimpleStreamingModel({
        output: [fakeModelMessage('done B')],
        usage: new Usage(),
      }),
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
      model: new SimpleStreamingModel({
        output: [callItem],
        usage: new Usage(),
      }),
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

  it('emits agent_end lifecycle event for streaming agents', async () => {
    class SimpleStreamingModel implements Model {
      constructor(private resp: ModelResponse) {}
      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return this.resp;
      }
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        yield {
          type: 'response_done',
          response: {
            id: 'r',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: this.resp.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'TestAgent',
      model: new SimpleStreamingModel({
        output: [fakeModelMessage('Final output')],
        usage: new Usage(),
      }),
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
    class LifecycleStreamingModel implements Model {
      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return {
          output: [fakeModelMessage('Final output')],
          usage: new Usage(),
        };
      }

      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        yield {
          type: 'response_done',
          response: {
            id: 'r_lifecycle',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: [fakeModelMessage('Final output')],
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'StreamLifecycleAgent',
      model: new LifecycleStreamingModel(),
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

    class MultiTurnStreamingModel implements Model {
      #callCount = 0;

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        const current = this.#callCount++;
        return current === 0 ? firstResponse : secondResponse;
      }

      async *getStreamedResponse(
        req: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        const response = await this.getResponse(req);
        yield {
          type: 'response_done',
          response: {
            id: `r_${this.#callCount}`,
            usage: {
              requests: 1,
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              totalTokens: response.usage.totalTokens,
            },
            output: response.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'UsageTracker',
      model: new MultiTurnStreamingModel(),
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

    class ExpensiveStreamingModel implements Model {
      #callCount = 0;

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return responses[this.#callCount++] ?? responses[responses.length - 1];
      }

      async *getStreamedResponse(
        req: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        const response = await this.getResponse(req);
        yield {
          type: 'response_done',
          response: {
            id: `r_${this.#callCount}`,
            usage: {
              requests: 1,
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              totalTokens: response.usage.totalTokens,
            },
            output: response.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'ExpensiveAgent',
      model: new ExpensiveStreamingModel(),
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

    class DelayedStreamingModel implements Model {
      constructor(private readonly delayMs: number) {}

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return {
          output: [fakeModelMessage('final')],
          usage: new Usage(),
        };
      }

      async *getStreamedResponse(
        request: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        yield { type: 'output_text_delta', delta: 'hello' } as any;
        await waitWithAbort(this.delayMs, request.signal);
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
        } as any;
      }
    }

    const agent = new Agent({
      name: 'SlowStream',
      model: new DelayedStreamingModel(400),
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

    class SlowFirstEventStreamingModel implements Model {
      async getResponse(): Promise<ModelResponse> {
        throw new Error('not used');
      }

      async *getStreamedResponse(
        request: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        streamStarted?.();
        await waitWithAbort(500, request.signal);
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
        } as any;
      }
    }

    const markSpy = vi.spyOn(
      ServerConversationTracker.prototype,
      'markInputAsSent',
    );

    const agent = new Agent({
      name: 'AbortBeforeFirstEvent',
      model: new SlowFirstEventStreamingModel(),
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

    class BlockingStreamModel implements Model {
      #callCount = 0;

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return this.#callCount === 0 ? toolResponse : finalMessageResponse;
      }

      async *getStreamedResponse(
        _req: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        const currentCall = this.#callCount++;
        const response =
          currentCall === 0 ? toolResponse : finalMessageResponse;
        yield {
          type: 'response_done',
          response: {
            id: `resp-${currentCall}`,
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: response.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'BlockingAgent',
      model: new BlockingStreamModel(),
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

    class SimpleStreamingModel implements Model {
      #callCount = 0;

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        const current = this.#callCount++;
        return current === 0 ? firstResponse : secondResponse;
      }

      async *getStreamedResponse(
        req: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        const response = await this.getResponse(req);
        yield {
          type: 'response_done',
          response: {
            id: `r_${this.#callCount}`,
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: response.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'StreamTurnCounter',
      model: new SimpleStreamingModel(),
      tools: [testTool],
      toolUseBehavior: 'run_llm_again',
    });

    // With maxTurns=1, this should throw MaxTurnsExceededError after the first model call
    // Currently fails because turn counter doesn't advance after first call
    const result = await run(agent, 'hi', { stream: true, maxTurns: 1 });
    await expect(result.completed).rejects.toBeInstanceOf(
      MaxTurnsExceededError,
    );
  });

  it('handles maxTurns errors with an error handler', async () => {
    const agent = new Agent({
      name: 'MaxTurnsHandlerStream',
      model: new FakeModel([
        { output: [fakeModelMessage('nope')], usage: new Usage() },
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

  it('does not advance the turn for streaming runs resuming an interruption without persisted items', async () => {
    const approvalTool = tool({
      name: 'get_weather',
      description: 'Gets weather for a city.',
      parameters: z.object({ city: z.string() }),
      needsApproval: async () => true,
      execute: async ({ city }) => `Weather in ${city}`,
    });

    class ApprovalStreamingModel implements Model {
      constructor(private readonly responses: ModelResponse[]) {}

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        const response = this.responses.shift();
        if (!response) {
          throw new Error('No response found');
        }
        return response;
      }

      async *getStreamedResponse(
        req: ModelRequest,
      ): AsyncIterable<protocol.StreamEvent> {
        const response = await this.getResponse(req);
        yield {
          type: 'response_done',
          response: {
            id: 'approval-stream',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: response.output,
          },
        } as protocol.StreamEvent;
      }
    }

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
      model: new ApprovalStreamingModel(modelResponses),
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

    class SequencedStreamModel implements Model {
      #turn = 0;

      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return this.#turn === 0 ? firstTurnResponse : secondTurnResponse;
      }

      async *getStreamedResponse(
        _req: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        const response =
          this.#turn === 0 ? firstTurnResponse : secondTurnResponse;
        this.#turn += 1;
        yield {
          type: 'response_done',
          response: {
            id: `resp-${this.#turn}`,
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: response.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'SequencedAgent',
      model: new SequencedStreamModel(),
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

    class TrackingStreamingModel implements Model {
      public requests: ModelRequest[] = [];
      public firstRequest: ModelRequest | undefined;
      public lastRequest: ModelRequest | undefined;

      constructor(private readonly turns: Turn[]) {}

      private recordRequest(request: ModelRequest) {
        const clonedInput: string | AgentInputItem[] =
          typeof request.input === 'string'
            ? request.input
            : (JSON.parse(JSON.stringify(request.input)) as AgentInputItem[]);

        const recorded: ModelRequest = {
          ...request,
          input: clonedInput,
        };

        this.requests.push(recorded);
        this.lastRequest = recorded;
        this.firstRequest ??= recorded;
      }

      async getResponse(_request: ModelRequest): Promise<ModelResponse> {
        throw new Error('Not implemented');
      }

      async *getStreamedResponse(
        request: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        this.recordRequest(request);
        const turn = this.turns.shift();
        if (!turn) {
          throw new Error('No response configured');
        }

        const responseId = turn.responseId ?? `resp-${this.requests.length}`;
        yield {
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
        } as StreamEvent;
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
      /* eslint-disable require-yield */
      class ThrowingStreamingModel implements Model {
        async getResponse(): Promise<ModelResponse> {
          throw new Error('not used');
        }

        async *getStreamedResponse(): AsyncIterable<StreamEvent> {
          throw new Error('stream failure');
        }
      }
      /* eslint-enable require-yield */

      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );
      const agent = new Agent({
        name: 'StreamFail',
        model: new ThrowingStreamingModel(),
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

  it('persists streaming input only after the run completes successfully', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();

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

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    const [sessionArg, persistedItems] = saveInputSpy.mock.calls[0];
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

  it('persists filtered streaming input instead of the raw turn payload', async () => {
    const saveInputSpy = vi
      .spyOn(sessionPersistence, 'saveStreamInputToSession')
      .mockResolvedValue();

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

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    const [, persistedItems] = saveInputSpy.mock.calls[0];
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

  it('persists streaming input but drops the result when an output guardrail trips', async () => {
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

    await expect(result.completed).rejects.toBeInstanceOf(
      OutputGuardrailTripwireTriggered,
    );

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).not.toHaveBeenCalled();
    expect(guardrail.execute).toHaveBeenCalledTimes(1);
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
      | ((value: GuardrailFunctionOutput) => void)
      | undefined;
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
    class HangingStreamingModel implements Model {
      async getResponse(): Promise<ModelResponse> {
        throw new Error('unused');
      }

      async *getStreamedResponse(
        request: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        const abortError = new Error('aborted');
        (abortError as any).name = 'AbortError';
        const signal = (request as any).signal as AbortSignal | undefined;
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

        // Keep the generator shape for the streaming contract while intentionally yielding nothing.
        yield* [] as any;
      }
    }

    const agent = new Agent({
      name: 'ResumeAfterCancel',
      model: new HangingStreamingModel(),
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

    agent.model = new ImmediateStreamingModel({
      output: [fakeModelMessage('resumed')],
      usage: new Usage(),
    });

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

    expect(saveInputSpy).toHaveBeenCalledTimes(1);
    expect(saveResultSpy).toHaveBeenCalledTimes(1);
  });

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

    class ExpectGuardrailBeforeStreamModel implements Model {
      getResponse(_request: ModelRequest): Promise<ModelResponse> {
        throw new Error('Unexpected call to getResponse');
      }

      async *getStreamedResponse(
        _request: ModelRequest,
      ): AsyncIterable<StreamEvent> {
        expect(guardrailFinished).toBe(true);
        yield {
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
        } satisfies StreamEvent;
      }
    }

    const agent = new Agent({
      name: 'BlockingStreamAgent',
      model: new ExpectGuardrailBeforeStreamModel(),
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

class ImmediateStreamingModel implements Model {
  constructor(private readonly response: ModelResponse) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    return this.response;
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const usage = this.response.usage;
    const output = this.response.output.map((item) =>
      protocol.OutputModelItem.parse(item),
    );
    yield {
      type: 'response_done',
      response: {
        id: 'r',
        usage: {
          requests: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
        output,
      },
    } satisfies StreamEvent;
  }
}

class RejectingStreamingModel implements Model {
  constructor(private readonly error: Error) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw this.error;
  }

  getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    const error = this.error;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw error;
          },
        } satisfies AsyncIterator<StreamEvent>;
      },
    } satisfies AsyncIterable<StreamEvent>;
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
