import { describe, expect, it } from 'vitest';

import { RunContext } from '@openai/agents-core';

import {
  defineRealtimeOutputGuardrail,
  getRealtimeGuardrailFeedbackMessage,
  getRealtimeGuardrailSettings,
} from '../src/guardrail';

describe('realtime guardrail helpers', () => {
  it('provides default settings and honors overrides', () => {
    expect(getRealtimeGuardrailSettings({})).toEqual({
      debounceTextLength: 100,
    });
    expect(getRealtimeGuardrailSettings({ debounceTextLength: 12 })).toEqual({
      debounceTextLength: 12,
    });
  });

  it('propagates policyHint and generates feedback text', async () => {
    const context = new RunContext({});
    const args = {
      agent: { name: 'demo' } as any,
      agentOutput: { output: 'ok' } as any,
      context,
    };

    const guardrail = defineRealtimeOutputGuardrail({
      name: 'Blocklist',
      execute: async () => ({
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked' },
      }),
    });

    expect(guardrail.policyHint).toBe('Blocklist');
    const result = await guardrail.run(args);
    expect(result.guardrail.policyHint).toBe('Blocklist');

    const message = getRealtimeGuardrailFeedbackMessage(result as any);
    expect(message).toContain('Failed Guardrail Reason: Blocklist.');
    expect(message).toContain(JSON.stringify({ reason: 'blocked' }));
  });

  it('respects explicit policyHint overrides', async () => {
    const guardrail = defineRealtimeOutputGuardrail({
      name: 'Policy',
      policyHint: 'Custom hint',
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: { ok: true },
      }),
    });

    const result = await guardrail.run({
      agent: { name: 'demo' } as any,
      agentOutput: { output: 'ok' } as any,
      context: new RunContext({}),
    });

    expect(guardrail.policyHint).toBe('Custom hint');
    expect(result.guardrail.policyHint).toBe('Custom hint');
  });
});
