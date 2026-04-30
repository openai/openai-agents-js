import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import { getTracing, ensureAgentSpan } from '../../src/runner/tracing';
import { withTrace } from '../../src/tracing';

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
});
