import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import {
  createRunUsageRecorder,
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
            {
              cached_tokens: 2,
              cache_write_tokens: 10,
              cache_write_tokens_details: {
                ttl_30m_tokens: 6,
                ttl_12h_tokens: 4,
              },
            },
            { cached_input_tokens: 3 },
          ],
        }),
      );
      finishRunnerSpan(taskSpan);

      expect(taskSpan.span.spanData.usage).toMatchObject({
        cached_input_tokens: 5,
        cache_write_input_tokens: 10,
      });
    });
  });
  it('keeps late usage on the current turn and the original parent recorder', async () => {
    await withTrace('usage ownership', async () => {
      const parentTask = startTaskSpan('parent');
      const parentTurn = startTurnSpan(1, 'parent agent', parentTask.span);
      const task = startTaskSpan('task', parentTurn.span);
      const first = startTurnSpan(1, 'agent', task.span);
      const second = startTurnSpan(2, 'agent', task.span);
      const holder: { current: typeof first | undefined } = { current: first };
      const parent = createRunUsageRecorder(
        parentTask,
        { current: parentTurn },
        undefined,
      );
      const record = createRunUsageRecorder(task, holder, parent);
      const usage = new Usage({
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      });
      record(usage);
      holder.current = second;
      finishRunnerSpan(second);
      record(usage);
      expect(first.ownedUsage.inputTokens).toBe(2);
      expect(second.ownedUsage.inputTokens).toBe(2);
      expect(task.ownedUsage.totalTokens).toBe(10);
      holder.current = undefined;
      record(usage);
      expect(second.ownedUsage.inputTokens).toBe(2);
      expect(task.ownedUsage.requests).toBe(3);
      expect(parentTask.ownedUsage.totalTokens).toBe(15);
      expect(parentTurn.ownedUsage.inputTokens).toBe(6);
      finishRunnerSpan(first);
      finishRunnerSpan(task);
      finishRunnerSpan(parentTurn);
      finishRunnerSpan(parentTask);
    });
  });
});
