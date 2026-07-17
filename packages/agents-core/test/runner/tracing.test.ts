import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import {
  ensureAgentSpan,
  finishRunnerSpan,
  getTracing,
  recordRunnerSpanUsage,
  startTaskSpan,
  startTurnSpan,
} from '../../src/runner/tracing';
import {
  createAgentSpan,
  setCurrentSpan,
  setTracingDisabled,
  withTrace,
} from '../../src/tracing';
import { Usage } from '../../src/usage';

describe('getTracing', () => {
  it('returns the correct tracing mode for each combination', () => {
    expect(getTracing(true, true)).toEqual(false);
    expect(getTracing(true, false)).toEqual(false);
    expect(getTracing(false, true)).toEqual(true);
    expect(getTracing(false, false)).toEqual('enabled_without_data');
  });

  it('updates handoffs on an existing agent span', async () => {
    await withTrace('workflow', async () => {
      const agent = new Agent({ name: 'router' });
      const span = ensureAgentSpan({
        agent,
        handoffs: [],
        tools: [],
      });
      const updated = ensureAgentSpan({
        agent,
        handoffs: [{ agentName: 'delegate' }] as any,
        tools: [],
        currentSpan: span,
      });

      expect(updated.spanData.handoffs).toEqual(['delegate']);
      updated.end();
    });
  });

  it('uses explicit runner-owned parents instead of the ambient span', async () => {
    setTracingDisabled(false);
    try {
      await withTrace('workflow', async () => {
        const taskSpan = startTaskSpan('workflow');
        const ambientSpan = createAgentSpan({
          data: { name: 'ambient sibling' },
        });
        ambientSpan.start();
        setCurrentSpan(ambientSpan);

        const agent = new Agent({ name: 'runner-owned agent' });
        const agentSpan = ensureAgentSpan({
          agent,
          handoffs: [],
          tools: [],
          parent: taskSpan.span,
        });

        setCurrentSpan(ambientSpan);
        const turnSpan = startTurnSpan(1, agent.name, agentSpan);

        expect(agentSpan.parentId).toBe(taskSpan.span.spanId);
        expect(turnSpan.span.parentId).toBe(agentSpan.spanId);

        finishRunnerSpan(turnSpan);
        agentSpan.end();
        ambientSpan.end();
        finishRunnerSpan(taskSpan);
      });
    } finally {
      setTracingDisabled(true);
    }
  });

  it('sums cached input token aliases in runner span usage', async () => {
    await withTrace('workflow', async () => {
      const taskSpan = startTaskSpan('workflow');

      recordRunnerSpanUsage(
        taskSpan,
        new Usage({
          inputTokens: 8,
          outputTokens: 2,
          totalTokens: 10,
          inputTokensDetails: [
            { cached_tokens: 2 },
            { cached_input_tokens: 3 },
          ],
        }),
      );
      finishRunnerSpan(taskSpan);

      expect(taskSpan.span.spanData.usage).toMatchObject({
        cached_input_tokens: 5,
      });
    });
  });
});
