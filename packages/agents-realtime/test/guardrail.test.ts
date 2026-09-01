import { describe, expect, it } from 'vitest';

import { RunContext, UserError } from '@openai/agents-core';

import {
  defineRealtimeOutputGuardrail,
  getRealtimeGuardrailFeedbackMessage,
  getRealtimeGuardrailSettings,
} from '../src/guardrail';

describe('realtime guardrail helpers', () => {
  it('provides default settings and honors supported overrides', () => {
    expect(getRealtimeGuardrailSettings({})).toEqual({
      debounceTextLength: 100,
    });
    expect(getRealtimeGuardrailSettings({ debounceTextLength: 12 })).toEqual({
      debounceTextLength: 12,
    });
    expect(getRealtimeGuardrailSettings({ debounceTextLength: -1 })).toEqual({
      debounceTextLength: -1,
    });
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid debounceTextLength %s',
    (debounceTextLength) => {
      expect(() =>
        getRealtimeGuardrailSettings({ debounceTextLength }),
      ).toThrow(
        new UserError(
          'Realtime output guardrail debounceTextLength must be a positive finite number or -1.',
        ),
      );
    },
  );

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
