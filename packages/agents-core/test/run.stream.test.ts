import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  run,
  Runner,
  setDefaultModelProvider,
  setTracingDisabled,
  Usage,
  RunStreamEvent,
  RunAgentUpdatedStreamEvent,
  RunItemStreamEvent,
  handoff,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  FunctionCallItem,
  tool,
} from '../src';
import { FakeModel, FakeModelProvider, fakeModelMessage } from './stubs';

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
});
