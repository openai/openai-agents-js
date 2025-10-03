import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AgentInputItem,
  run,
  Runner,
  setDefaultModelProvider,
  setTracingDisabled,
  Usage,
  RunStreamEvent,
  RunAgentUpdatedStreamEvent,
  RunItemStreamEvent,
  StreamedRunResult,
  handoff,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  FunctionCallItem,
  tool,
} from '../src';
import { FakeModel, FakeModelProvider, fakeModelMessage } from './stubs';
import * as protocol from '../src/types/protocol';

// Test for unhandled rejection when stream loop throws

describe('Runner.run (streaming)', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
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
});
