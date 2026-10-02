import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent';
import { Runner } from '../src/run';
import { computerTool } from '../src/tool';
import { ScriptedModel } from '../src/testing';
import { setTraceProcessors, setTracingDisabled } from '../src/tracing';
import { defaultProcessor } from '../src/tracing/processor';
import type { Span } from '../src/tracing/spans';
import { FakeComputer } from './stubs';

let spans: Span<any>[];

beforeEach(() => {
  spans = [];
  setTracingDisabled(false);
  setTraceProcessors([
    {
      async onTraceStart() {},
      async onTraceEnd() {},
      async onSpanStart() {},
      async onSpanEnd(span) {
        spans.push(span);
      },
      async shutdown() {},
      async forceFlush() {},
    },
  ]);
});

afterEach(() => {
  setTraceProcessors([defaultProcessor()]);
  setTracingDisabled(true);
  vi.restoreAllMocks();
});

it.each([
  { callback: 'safety', sensitive: false, stream: false },
  { callback: 'safety', sensitive: false, stream: true },
  { callback: 'safety', sensitive: true, stream: false },
  { callback: 'start', sensitive: false, stream: false },
  { callback: 'end', sensitive: false, stream: false },
])(
  'applies tool trace policy to escaping callbacks: %j',
  async ({ callback, sensitive, stream }) => {
    const secret = 'synthetic-confidential-callback-context';
    const error = Object.assign(new Error('Callback failed'), {
      data: { confidentialContext: secret },
    });
    const computer = new FakeComputer();
    const screenshot = vi.spyOn(computer, 'screenshot');
    const safety = vi.fn(async () => {
      if (callback === 'safety') throw error;
      return true;
    });
    const agent = new Agent({
      name: 'Computer callback test',
      model: new ScriptedModel([
        [
          {
            type: 'computer_call',
            callId: 'callback-call',
            status: 'completed',
            action: { type: 'screenshot' },
            providerData: {
              pending_safety_checks: [
                { id: 'check', code: 'test', message: 'Confirm action' },
              ],
            },
          },
        ],
      ]),
      tools: [computerTool({ computer, onSafetyCheck: safety })],
    });
    const runner = new Runner({ traceIncludeSensitiveData: sensitive });
    if (callback !== 'safety') {
      runner.on(
        callback === 'start' ? 'agent_tool_start' : 'agent_tool_end',
        () => {
          throw error;
        },
      );
    }
    const run = async () => {
      if (stream) {
        const result = await runner.run(agent, 'start', { stream: true });
        await result.completed;
      } else {
        await runner.run(agent, 'start');
      }
    };
    await expect(run()).rejects.toBe(error);
    expect(screenshot).toHaveBeenCalledTimes(callback === 'end' ? 1 : 0);
    expect(safety).toHaveBeenCalledTimes(callback === 'start' ? 0 : 1);
    const functionSpans = spans.filter(
      (span) => span.spanData.type === 'function',
    );
    expect(functionSpans).toHaveLength(1);
    expect(functionSpans[0].endedAt).not.toBeNull();
    if (sensitive) {
      expect(functionSpans[0].error).toEqual({
        message: error.message,
        data: error.data,
      });
    } else {
      expect(functionSpans[0].error).toMatchObject({
        message: 'Error running tool',
        data: { error: 'Tool execution failed. Error details are redacted.' },
      });
      expect(JSON.stringify(spans.map((span) => span.toJSON()))).not.toContain(
        secret,
      );
    }
    expect(error.data.confidentialContext).toBe(secret);
  },
);
