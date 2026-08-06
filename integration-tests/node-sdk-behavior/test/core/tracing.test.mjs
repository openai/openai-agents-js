import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Agent,
  Runner,
  setTraceProcessors,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import { integrationModel } from '../helpers.mjs';

class CollectingTraceProcessor {
  tracesStarted = [];
  tracesEnded = [];
  spansStarted = [];
  spansEnded = [];

  async onTraceStart(trace) {
    this.tracesStarted.push(trace);
  }

  async onTraceEnd(trace) {
    this.tracesEnded.push(trace);
  }

  async onSpanStart(span) {
    this.spansStarted.push(span);
  }

  async onSpanEnd(span) {
    this.spansEnded.push(span);
  }

  async shutdown() {}

  async forceFlush() {}
}

test('live spans finish without exposing sensitive model or tool data', async () => {
  const calls = [];
  const inspectSecret = tool({
    name: 'inspect_secret',
    description: 'Inspect a deterministic sensitive verification value.',
    parameters: z.object({ value: z.string() }),
    execute: async ({ value }) => {
      calls.push(value);
      return 'TRACE_READY';
    },
  });
  const agent = new Agent({
    name: 'Published traced agent',
    model: integrationModel,
    instructions:
      "Call inspect_secret with value 'secret-token-42', then reply exactly TRACE_READY.",
    tools: [inspectSecret],
    modelSettings: { maxTokens: 384, toolChoice: 'inspect_secret' },
  });
  const processor = new CollectingTraceProcessor();
  setTraceProcessors([processor]);
  setTracingDisabled(false);

  let result;
  try {
    result = await new Runner({
      tracingDisabled: false,
      traceIncludeSensitiveData: false,
      workflowName: 'Published tracing compatibility',
    }).run(agent, 'Inspect the secret.');
  } finally {
    setTraceProcessors([]);
    setTracingDisabled(true);
  }

  assert.deepEqual(calls, ['secret-token-42']);
  assert.equal(result.finalOutput, 'TRACE_READY');
  assert.equal(processor.tracesStarted.length, 1);
  assert.equal(processor.tracesEnded.length, 1);
  assert.equal(processor.spansStarted.length, processor.spansEnded.length);
  assert.ok(processor.spansEnded.length > 0);
  assert.ok(processor.spansEnded.every((span) => span.endedAt !== null));

  const spanTypes = new Set(
    processor.spansEnded.map((span) => span.spanData.type),
  );
  assert.ok(spanTypes.has('agent'));
  assert.ok(spanTypes.has('response'));
  assert.ok(spanTypes.has('function'));
  assert.ok(
    processor.spansEnded.every(
      (span) => !JSON.stringify(span.toJSON()).includes('secret-token-42'),
    ),
  );
});
