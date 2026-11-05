import { describe, expect, it } from 'vitest';
import { Agent, Runner, RunState, Usage } from '../src';
import { ScriptedModel, assistantMessage, modelResponse } from '../src/testing';

describe('guardrail checkpoint metadata', () => {
  it.each([undefined, null, { checked: true }])(
    'restores input and output guardrail metadata: %j',
    async (outputInfo) => {
      const agent = new Agent({
        name: 'Checkpoint guardrails',
        model: new ScriptedModel([
          modelResponse({
            output: [assistantMessage('done')],
            usage: new Usage(),
          }),
        ]),
        inputGuardrails: [
          {
            name: 'input check',
            runInParallel: false,
            execute: async () => ({ tripwireTriggered: false, outputInfo }),
          },
        ],
        outputGuardrails: [
          {
            name: 'output check',
            execute: async () => ({ tripwireTriggered: false, outputInfo }),
          },
        ],
      });
      const result = await new Runner({ tracingDisabled: true }).run(
        agent,
        'hi',
      );
      const restored = await RunState.fromString(
        agent,
        result.state.toString(),
      );
      const serialized = restored.toJSON();
      expect(serialized.inputGuardrailResults).toHaveLength(1);
      expect(serialized.outputGuardrailResults).toHaveLength(1);
      for (const guardrail of [
        serialized.inputGuardrailResults[0],
        serialized.outputGuardrailResults[0],
      ]) {
        expect(guardrail.output.tripwireTriggered).toBe(false);
        expect(guardrail.output.outputInfo).toEqual(outputInfo);
      }
    },
  );
});
