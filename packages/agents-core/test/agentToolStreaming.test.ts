import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  RunContext,
  Runner,
  type FunctionTool,
  type RunStreamEvent,
  type StreamEvent,
} from '../src';
import {
  assistantMessage,
  functionCall,
  modelStreamResponder,
  ScriptedModel,
} from '../src/testing';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function completed(): StreamEvent {
  return {
    type: 'response_done',
    response: {
      id: 'nested-response',
      usage: { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: [assistantMessage('nested success')],
    },
  };
}

function isStart(event: RunStreamEvent) {
  return (
    event.type === 'raw_model_stream_event' &&
    event.data.type === 'response_started'
  );
}

function parentFor(nestedTool: FunctionTool<unknown, any>) {
  return new Agent({
    name: 'parent',
    model: new ScriptedModel([
      [
        functionCall(nestedTool.name, JSON.stringify({ input: 'hello' }), {
          callId: 'nested-call',
        }),
      ],
    ]),
    tools: [nestedTool],
    toolUseBehavior: 'stop_on_first_tool',
  });
}

const runner = new Runner({ tracingDisabled: true });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent tool streaming backlog', () => {
  it.each([
    { limit: undefined, budget: 1024, stream: false, registration: 'onStream' },
    { limit: 2, budget: 2, stream: true, registration: 'on' },
  ])(
    'aborts a blocked nested producer with $registration and budget $budget',
    async ({ limit, budget, stream, registration }) => {
      const handlerStarted = barrier();
      const releaseHandler = barrier();
      const producerClosed = vi.fn();
      let modelSignal: AbortSignal | undefined;
      const nested = new Agent({
        name: 'nested',
        model: new ScriptedModel([
          modelStreamResponder((call) =>
            (async function* () {
              modelSignal = call.request.signal;
              try {
                yield { type: 'response_started' } as StreamEvent;
                await handlerStarted.promise;
                for (let i = 0; i <= budget; i++) {
                  yield {
                    type: 'output_text_delta',
                    delta: String(i),
                  } as StreamEvent;
                }
                yield completed();
              } finally {
                producerClosed();
              }
            })(),
          ),
        ]),
      });
      const handler = vi.fn(async ({ event }: { event: RunStreamEvent }) => {
        if (isStart(event)) {
          handlerStarted.release();
          await releaseHandler.promise;
          throw new Error('late observer rejection');
        }
      });
      const extractor = vi.fn(() => 'unexpected success');
      const nestedTool = nested.asTool({
        toolDescription: 'nested events',
        onStreamMaxPendingEvents: limit,
        customOutputExtractor: extractor,
        ...(registration === 'onStream' ? { onStream: handler } : {}),
      });
      if (registration === 'on') nestedTool.on('*', handler);
      try {
        const result = stream
          ? await runner.run(parentFor(nestedTool), 'start', {
              stream: true,
            })
          : await runner.run(parentFor(nestedTool), 'start', {});
        if (stream) {
          for await (const _ of result as AsyncIterable<RunStreamEvent>) {
            /* Drain the parent. */
          }
        }
        expect(result.finalOutput).toBe(
          'An error occurred while running the tool. Please try again.',
        );
        expect(result.finalOutput).not.toContain('nested success');
        expect(modelSignal?.aborted).toBe(true);
        expect(producerClosed).toHaveBeenCalledOnce();
        expect(extractor).not.toHaveBeenCalled();
        expect(
          handler.mock.calls.filter(
            ([payload]) => payload.event.type === 'raw_model_stream_event',
          ),
        ).toHaveLength(1);
      } finally {
        releaseHandler.release();
      }
    },
  );

  it.each([5, null])(
    'drains pending events before returning with limit %s',
    async (limit) => {
      const handlerStarted = barrier();
      const producerFinished = barrier();
      const releaseHandler = barrier();
      const events: RunStreamEvent[] = [];
      const nested = new Agent({
        name: 'draining',
        model: new ScriptedModel([
          modelStreamResponder(() =>
            (async function* () {
              yield { type: 'response_started' } as StreamEvent;
              await handlerStarted.promise;
              for (let i = 0; i < 3; i++)
                yield {
                  type: 'output_text_delta',
                  delta: String(i),
                } as StreamEvent;
              yield completed();
              producerFinished.release();
            })(),
          ),
        ]),
      });
      const nestedTool = nested.asTool({
        toolDescription: 'drain events',
        onStreamMaxPendingEvents: limit,
        onStream: async ({ event }) => {
          events.push(event);
          if (isStart(event)) {
            handlerStarted.release();
            await releaseHandler.promise;
          }
        },
      });
      let settled = false;
      const invocation = runner
        .run(parentFor(nestedTool), 'start', {})
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await producerFinished.promise;
        expect(settled).toBe(false);
      } finally {
        releaseHandler.release();
      }
      const result = await invocation;
      expect(result.finalOutput).toBe('nested success');
      expect(
        events
          .filter((event) => event.type === 'raw_model_stream_event')
          .map((event) => event.data.type),
      ).toEqual([
        'response_started',
        'output_text_delta',
        'output_text_delta',
        'output_text_delta',
        'response_done',
      ]);
    },
  );

  it('stops awaiting a blocked handler when the parent aborts', async () => {
    const handlerStarted = barrier();
    const releaseHandler = barrier();
    const producerClosed = vi.fn();
    const abort = new AbortController();
    const nested = new Agent({
      name: 'cancelled',
      model: new ScriptedModel([
        modelStreamResponder((call) =>
          (async function* () {
            try {
              yield { type: 'response_started' } as StreamEvent;
              await handlerStarted.promise;
              await new Promise<void>((resolve) => {
                if (call.request.signal?.aborted) resolve();
                else
                  call.request.signal?.addEventListener(
                    'abort',
                    () => resolve(),
                    { once: true },
                  );
              });
              call.request.signal?.throwIfAborted();
            } finally {
              producerClosed();
            }
          })(),
        ),
      ]),
    });
    const nestedTool = nested.asTool({
      toolDescription: 'cancel',
      onStream: async ({ event }) => {
        if (isStart(event)) {
          handlerStarted.release();
          await releaseHandler.promise;
        }
      },
    });
    const result = await runner.run(parentFor(nestedTool), 'start', {
      stream: true,
      signal: abort.signal,
    });
    try {
      await handlerStarted.promise;
      abort.abort();
      await result.completed;
      expect(result.cancelled).toBe(true);
      expect(producerClosed).toHaveBeenCalledOnce();
    } finally {
      releaseHandler.release();
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects invalid budget %s at construction',
    (limit) => {
      expect(() =>
        new Agent({ name: 'invalid' }).asTool({
          toolDescription: 'invalid',
          onStreamMaxPendingEvents: limit,
        }),
      ).toThrow('positive safe integer or null');
    },
  );

  it('keeps tools without observers non-streaming', async () => {
    const model = new ScriptedModel([[assistantMessage('plain')]]);
    const nestedTool = new Agent({ name: 'plain', model }).asTool({
      toolDescription: 'plain',
      onStreamMaxPendingEvents: 1,
      runConfig: { tracingDisabled: true },
    });
    expect(await nestedTool.invoke(new RunContext(), '{"input":"hello"}')).toBe(
      'plain',
    );
    expect(model.calls[0].streamed).toBe(false);
  });
});

describe('agent tool streaming lifecycle', () => {
  it('keeps per-event handlers parallel, ordered, and non-fatal', async () => {
    const specificStarted = barrier();
    const calls: string[] = [];
    const nested = new Agent({
      name: 'ordered',
      model: new ScriptedModel([[assistantMessage('nested success')]]),
    });
    const nestedTool = nested.asTool({
      toolDescription: 'observe',
      onStream: async ({ event }) => {
        calls.push(`onStream:${event.type}`);
        if (isStart(event)) {
          await specificStarted.promise;
          throw new Error('observer only');
        }
      },
    });
    nestedTool
      .on('raw_model_stream_event', ({ event }) => {
        calls.push(`specific:${event.type}`);
        if (isStart(event)) specificStarted.release();
      })
      .on('*', ({ event }) => {
        calls.push(`wildcard:${event.type}`);
      });
    const result = await runner.run(parentFor(nestedTool), 'start');
    expect(result.finalOutput).toBe('nested success');
    expect(calls.slice(0, 3)).toEqual([
      'onStream:raw_model_stream_event',
      'specific:raw_model_stream_event',
      'wildcard:raw_model_stream_event',
    ]);
    const rawCount = calls.filter(
      (value) => value === 'specific:raw_model_stream_event',
    ).length;
    expect(rawCount).toBeGreaterThan(1);
    expect(
      calls.filter((value) => value === 'onStream:raw_model_stream_event'),
    ).toHaveLength(rawCount);
    expect(
      calls.filter((value) => value === 'wildcard:raw_model_stream_event'),
    ).toHaveLength(rawCount);
  });

  it('keeps a concurrent invocation alive when its sibling overflows', async () => {
    const handlerStarted = barrier();
    const allowOverflow = barrier();
    const releaseHandler = barrier();
    let starts = 0;
    const nested = new Agent({
      name: 'shared',
      model: new ScriptedModel([
        modelStreamResponder(() =>
          (async function* () {
            yield { type: 'response_started' } as StreamEvent;
            await allowOverflow.promise;
            for (let i = 0; i < 9; i++)
              yield {
                type: 'output_text_delta',
                delta: String(i),
              } as StreamEvent;
            yield completed();
          })(),
        ),
        [assistantMessage('surviving invocation')],
      ]),
    });
    const nestedTool = nested.asTool({
      toolDescription: 'shared',
      onStreamMaxPendingEvents: 8,
      onStream: async ({ event }) => {
        if (isStart(event) && starts++ === 0) {
          handlerStarted.release();
          await releaseHandler.promise;
        }
      },
    });
    const first = runner.run(parentFor(nestedTool), 'first');
    try {
      await handlerStarted.promise;
      const second = await runner.run(parentFor(nestedTool), 'second');
      expect(second.finalOutput).toBe('surviving invocation');
      allowOverflow.release();
      expect((await first).finalOutput).toBe(
        'An error occurred while running the tool. Please try again.',
      );
      expect(second.finalOutput).toBe('surviving invocation');
    } finally {
      allowOverflow.release();
      releaseHandler.release();
    }
  });

  it('bounds SDK item bursts after the model completes', async () => {
    const handlerStarted = barrier();
    const releaseHandler = barrier();
    const closed = vi.fn();
    const nested = new Agent({
      name: 'items',
      model: new ScriptedModel([
        modelStreamResponder(() =>
          (async function* () {
            try {
              yield { type: 'response_started' } as StreamEvent;
              await handlerStarted.promise;
              const terminal = completed();
              if (terminal.type !== 'response_done')
                throw new Error('Expected terminal response');
              terminal.response.output = Array.from({ length: 5 }, () =>
                assistantMessage('item'),
              );
              yield terminal;
            } finally {
              closed();
            }
          })(),
        ),
      ]),
    });
    const nestedTool = nested.asTool({
      toolDescription: 'items',
      onStreamMaxPendingEvents: 2,
      onStream: async ({ event }) => {
        if (isStart(event)) {
          handlerStarted.release();
          await releaseHandler.promise;
        }
      },
    });
    try {
      expect(
        (await runner.run(parentFor(nestedTool), 'start')).finalOutput,
      ).toBe('An error occurred while running the tool. Please try again.');
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      releaseHandler.release();
    }
  });

  it('redacts overflow and secondary model iterator cleanup failures', async () => {
    const handlerStarted = barrier();
    const releaseHandler = barrier();
    const nested = new Agent({
      name: 'cleanup',
      model: new ScriptedModel([
        modelStreamResponder(() =>
          (async function* () {
            try {
              yield { type: 'response_started' } as StreamEvent;
              await handlerStarted.promise;
              for (let i = 0; i < 3; i++)
                yield {
                  type: 'output_text_delta',
                  delta: 'data',
                } as StreamEvent;
            } finally {
              await Promise.reject(
                new Error('secondary model cleanup failure'),
              );
            }
          })(),
        ),
      ]),
    });
    const nestedTool = nested.asTool({
      toolDescription: 'cleanup',
      onStreamMaxPendingEvents: 2,
      onStream: async ({ event }) => {
        if (isStart(event)) {
          handlerStarted.release();
          await releaseHandler.promise;
        }
      },
    });
    try {
      const result = await runner.run(parentFor(nestedTool), 'start');
      expect(result.finalOutput).toBe(
        'An error occurred while running the tool. Please try again.',
      );
      expect(result.finalOutput).not.toContain('secondary');
    } finally {
      releaseHandler.release();
    }
  });

  it('observes producer failure without waiting for a blocked handler', async () => {
    const handlerStarted = barrier();
    const releaseHandler = barrier();
    const nested = new Agent({
      name: 'failed',
      model: new ScriptedModel([
        modelStreamResponder(() =>
          (async function* () {
            yield { type: 'response_started' } as StreamEvent;
            await handlerStarted.promise;
            throw new Error('primary producer failure');
          })(),
        ),
      ]),
    });
    const nestedTool = nested.asTool({
      toolDescription: 'failed',
      onStream: async ({ event }) => {
        if (isStart(event)) {
          handlerStarted.release();
          await releaseHandler.promise;
        }
      },
    });
    try {
      expect(
        (await runner.run(parentFor(nestedTool), 'start')).finalOutput,
      ).toBe('An error occurred while running the tool. Please try again.');
    } finally {
      releaseHandler.release();
    }
  });

  it('does not bound standalone streams or explicitly unlimited observers', async () => {
    function burst() {
      return new ScriptedModel([
        modelStreamResponder(() =>
          (async function* () {
            yield { type: 'response_started' } as StreamEvent;
            for (let i = 0; i < 1030; i++)
              yield { type: 'output_text_delta', delta: 'x' } as StreamEvent;
            yield completed();
          })(),
        ),
      ]);
    }
    const standalone = await runner.run(
      new Agent({ name: 'standalone', model: burst() }),
      'start',
      { stream: true },
    );
    await standalone.completed;
    const events: RunStreamEvent[] = [];
    for await (const event of standalone) events.push(event);
    expect(
      events.filter((event) => event.type === 'raw_model_stream_event'),
    ).toHaveLength(1032);
    expect(standalone.finalOutput).toBe('nested success');

    const releaseHandler = barrier();
    const produced = barrier();
    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          yield { type: 'response_started' } as StreamEvent;
          for (let i = 0; i < 1030; i++)
            yield { type: 'output_text_delta', delta: 'x' } as StreamEvent;
          yield completed();
          produced.release();
        })(),
      ),
    ]);
    const observed = vi.fn(async ({ event }: { event: RunStreamEvent }) => {
      if (isStart(event)) await releaseHandler.promise;
    });
    const nestedTool = new Agent({ name: 'unlimited', model }).asTool({
      toolDescription: 'unlimited',
      onStreamMaxPendingEvents: null,
      onStream: observed,
    });
    const invocation = runner.run(parentFor(nestedTool), 'start');
    await produced.promise;
    releaseHandler.release();
    expect((await invocation).finalOutput).toBe('nested success');
    expect(
      observed.mock.calls.filter(
        ([{ event }]) => event.type === 'raw_model_stream_event',
      ),
    ).toHaveLength(1032);
  });
});
