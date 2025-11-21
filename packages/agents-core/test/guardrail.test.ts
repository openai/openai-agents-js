import { describe, it, expect, vi, expectTypeOf } from 'vitest';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
  type InputGuardrailDefinition,
  type OutputGuardrailDefinition,
  type InputGuardrailResult,
  type OutputGuardrailResult,
  type InputGuardrailFunctionArgs,
  type OutputGuardrailFunctionArgs,
  type OutputGuardrail,
  type InputGuardrail,
} from '../src/guardrail';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { TextOutput } from '../src';

const agent = new Agent({ name: 'TestAgent' });
const context = new RunContext();

describe('guardrail helpers', () => {
  it('initialize an Agent with input/output guardrails', () => {
    const ig: InputGuardrail = {
      name: 'ig',
      execute: async (_args) => ({
        outputInfo: { ok: true },
        tripwireTriggered: false,
      }),
    };
    const og: OutputGuardrail<TextOutput> = {
      name: 'og',
      execute: async (_args) => ({
        outputInfo: { ok: true },
        tripwireTriggered: true,
      }),
    };
    const agent = new Agent({
      name: 'TestAgent',
      instructions: 'Test instructions',
      inputGuardrails: [ig],
      outputGuardrails: [og],
    });
    expect(agent.inputGuardrails[0].name).toEqual('ig');
    expect(agent.outputGuardrails[0].name).toEqual('og');
  });

  it('defaults input guardrails to run in parallel', () => {
    const guardrail = defineInputGuardrail({
      name: 'ig',
      execute: async (_args) => ({
        outputInfo: { ok: true },
        tripwireTriggered: false,
      }),
    });

    expect(guardrail.runInParallel).toBe(true);
  });

  it('uses configured runInParallel value for input guardrails', () => {
    const guardrail = defineInputGuardrail({
      name: 'blocking',
      execute: async (_args) => ({
        outputInfo: { ok: true },
        tripwireTriggered: false,
      }),
      runInParallel: false,
    });

    expect(guardrail.runInParallel).toBe(false);
  });

  it('executes input guardrail and returns expected result', async () => {
    const guardrailFn = vi.fn(async (_args: InputGuardrailFunctionArgs) => ({
      outputInfo: { ok: true },
      tripwireTriggered: false,
    }));

    const def = defineInputGuardrail({ name: 'in1', execute: guardrailFn });

    expectTypeOf(def).toEqualTypeOf<InputGuardrailDefinition>();

    const result = await def.run({ agent, input: 'hi', context });

    expect(guardrailFn).toHaveBeenCalledTimes(1);
    expect(result.guardrail).toEqual({ type: 'input', name: 'in1' });
    expect(result.output).toEqual({
      outputInfo: { ok: true },
      tripwireTriggered: false,
    });
    expectTypeOf(result).toEqualTypeOf<InputGuardrailResult>();
  });

  it('executes output guardrail and returns expected result', async () => {
    const guardrailFn = vi.fn(async (_args: OutputGuardrailFunctionArgs) => ({
      outputInfo: { ok: true },
      tripwireTriggered: true,
    }));

    const def = defineOutputGuardrail({ name: 'out1', execute: guardrailFn });

    expectTypeOf(def).toEqualTypeOf<OutputGuardrailDefinition>();

    const result = await def.run({ agent, agentOutput: 'hello', context });

    expect(guardrailFn).toHaveBeenCalledTimes(1);
    expect(result.guardrail).toEqual({ type: 'output', name: 'out1' });
    expect(result.agent).toBe(agent);
    expect(result.agentOutput).toBe('hello');
    expect(result.output).toEqual({
      outputInfo: { ok: true },
      tripwireTriggered: true,
    });
    expectTypeOf(result).toEqualTypeOf<OutputGuardrailResult>();
  });

  it('propagates errors from input guardrail', async () => {
    const guardrailFn = vi.fn(async () => {
      throw new Error('fail');
    });

    const def = defineInputGuardrail({ name: 'error', execute: guardrailFn });

    await expect(def.run({ agent, input: 'bad', context })).rejects.toThrow(
      'fail',
    );
    expect(guardrailFn).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from output guardrail', async () => {
    const guardrailFn = vi.fn(async () => {
      throw new Error('boom');
    });

    const def = defineOutputGuardrail({ name: 'error', execute: guardrailFn });

    await expect(
      def.run({ agent, agentOutput: 'bad', context }),
    ).rejects.toThrow('boom');
    expect(guardrailFn).toHaveBeenCalledTimes(1);
  });
});
