import { describe, expect, it } from 'vitest';

import { Agent, RunState, UserError, run } from '../src';
import { RunContext } from '../src/runContext';
import { ScriptedModel, assistantMessage } from '../src/testing';

describe('maxTurns runtime validation', () => {
  it.each([Number.NaN, Infinity, -Infinity, -1, 1.5])(
    'rejects invalid maxTurns %s before invoking the model',
    async (maxTurns) => {
      const model = new ScriptedModel([[assistantMessage('unused')]]);
      const agent = new Agent({ name: 'test', model });

      await expect(run(agent, 'go', { maxTurns })).rejects.toThrow(
        new UserError(
          'maxTurns must be a non-negative integer or null when provided.',
        ),
      );
      expect(model.calls).toHaveLength(0);
    },
  );

  it('validates maxTurns overrides before resuming a RunState', async () => {
    const model = new ScriptedModel([[assistantMessage('unused')]]);
    const agent = new Agent({ name: 'test', model });
    const state = new RunState(new RunContext(), 'go', agent, 1);

    await expect(
      run(agent, state, { maxTurns: Number.NaN }),
    ).rejects.toBeInstanceOf(UserError);
    expect(model.calls).toHaveLength(0);
    expect(state._maxTurns).toBe(1);
  });

  it('preserves the explicit unlimited null value', async () => {
    const model = new ScriptedModel([[assistantMessage('done')]]);
    const agent = new Agent({ name: 'test', model });

    const result = await run(agent, 'go', { maxTurns: null });

    expect(result.finalOutput).toBe('done');
    expect(model.calls).toHaveLength(1);
  });
});
