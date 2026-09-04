import { describe, expect, it } from 'vitest';
import { Agent, run, Usage } from '../../src';
import { GuardrailExecutionError } from '../../src/errors';
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from '../../src/testing';

describe('guardrail tripwire runtime validation', () => {
  it('rejects a non-boolean blocking input tripwire before model execution', async () => {
    const guardrail = {
      name: 'policy',
      runInParallel: false,
      execute: async () =>
        ({ tripwireTriggered: undefined, outputInfo: undefined }) as any,
    };
    const model = new ScriptedModel([
      modelResponse({
        output: [assistantMessage('should not run')],
        usage: new Usage(),
      }),
    ]);
    const agent = new Agent({
      name: 'guardrail-test',
      model,
      inputGuardrails: [guardrail],
    });

    await expect(run(agent, 'sensitive input')).rejects.toThrow(
      GuardrailExecutionError,
    );
    expect(model.calls).toHaveLength(0);
  });
});
