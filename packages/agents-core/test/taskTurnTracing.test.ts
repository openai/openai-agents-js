import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  Runner,
  RunContext,
  RunState,
  Span,
  Trace,
  Usage,
  createAgentSpan,
  getGlobalTraceProvider,
  setTraceProcessors,
  setTracingDisabled,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type TracingProcessor,
} from '../src';
import { defaultProcessor } from '../src/tracing/processor';
import { fakeModelMessage, FakeModel } from './stubs';

class RecordingProcessor implements TracingProcessor {
  readonly spansStarted: Span<any>[] = [];
  readonly spansEnded: Span<any>[] = [];

  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(span: Span<any>): Promise<void> {
    this.spansStarted.push(span);
  }
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

class StreamingModel implements Model {
  constructor(private readonly response: ModelResponse) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error('Use getStreamedResponse for this model.');
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    yield {
      type: 'response_done',
      response: {
        id: 'stream-response',
        output: this.response.output,
        usage: this.response.usage,
      },
    } as StreamEvent;
  }
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
});
