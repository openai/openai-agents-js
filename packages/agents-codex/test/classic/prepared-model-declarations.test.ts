import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  ModelBehaviorError,
  Runner,
  tool,
  type AgentInputItem,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents/classic/testing';
import { z } from 'zod';
import {
  runPreparedDeclarationsExample,
  withPreparedRequest,
} from '../../examples/prepared-model-declarations';

function scenario(name = 'reserve_seats', args = '{"seats":2}') {
  const execute = vi.fn(({ seats }: { seats: number }) => `original:${seats}`);
  const disabledExecute = vi.fn(() => 'must not execute');
  const reserve = tool({
    name: 'reserve_seats',
    description: 'Reserve up to three seats.',
    parameters: z.object({ seats: z.number().int().min(1).max(3) }),
    needsApproval: true,
    execute,
  });
  const disabled = tool({
    name: 'erase_bookings',
    description: 'Erase bookings.',
    parameters: z.object({}),
    isEnabled: false,
    execute: disabledExecute,
  });
  const sampling = new ScriptedModel([
    modelResponse([functionCall(name, args, { callId: 'booking' })]),
    modelResponse([assistantMessage('Finished.')]),
  ]);
  const model = withPreparedRequest(sampling, (prepared) => {
    prepared.systemInstructions = 'Prepared booking instructions';
    if (Array.isArray(prepared.input)) {
      const first = prepared.input[0];
      if (first?.type === 'message' && Array.isArray(first.content)) {
        const text = first.content[0];
        if (text?.type === 'input_text') text.text = 'Prepared history';
      }
    }
    const declaration = prepared.tools.find(
      (entry) => entry.type === 'function',
    );
    if (declaration?.type === 'function') {
      declaration.description = 'Prepared booking description';
      declaration.parameters.properties.seats = {
        type: 'integer',
        minimum: 1,
        maximum: 99,
      };
    }
  });
  const received = vi.spyOn(model, 'getResponse');
  const agent = new Agent({
    name: 'Bookings',
    instructions: 'Original booking instructions',
    tools: [reserve, disabled],
    model,
  });
  const input: AgentInputItem[] = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Original history' }],
    },
  ];
  return {
    agent,
    model,
    sampling,
    received,
    reserve,
    disabled,
    execute,
    disabledExecute,
    input,
    runner: new Runner({ tracingDisabled: true }),
  };
}

describe('prepared model declarations through the classic Runner', () => {
  it('edits detached sampling data and waits for approval of the original handler', async () => {
    const f = scenario();
    const originalSchema = structuredClone(f.reserve.parameters);
    const originalInvoke = f.reserve.invoke;
    const pending = await f.runner.run(f.agent, f.input);
    expect(pending.interruptions).toHaveLength(1);
    expect(pending.interruptions[0].agent).toBe(f.agent);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.disabledExecute).not.toHaveBeenCalled();
    const sampled = f.sampling.firstCall!.request;
    expect(sampled.systemInstructions).toBe('Prepared booking instructions');
    expect(JSON.stringify(sampled.input)).toContain('Prepared history');
    expect(
      sampled.tools.map((entry) =>
        entry.type === 'function' ? entry.name : entry.type,
      ),
    ).toEqual(['reserve_seats']);
    expect(sampled.tools[0]).toMatchObject({
      description: 'Prepared booking description',
      parameters: { properties: { seats: { maximum: 99 } } },
    });
    expect(f.received.mock.calls[0][0].systemInstructions).toBe(
      'Original booking instructions',
    );
    expect(JSON.stringify(f.received.mock.calls[0][0].input)).toContain(
      'Original history',
    );
    expect(JSON.stringify(f.input)).toContain('Original history');
    expect(f.reserve.parameters).toEqual(originalSchema);
    expect(f.agent.tools[0]).toBe(f.reserve);
    expect(f.reserve.invoke).toBe(originalInvoke);
    pending.state.approve(pending.interruptions[0]);
    const result = await f.runner.run(f.agent, pending.state);
    expect(result.finalOutput).toBe('Finished.');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][0]).toEqual({ seats: 2 });
    expect(f.disabledExecute).not.toHaveBeenCalled();
    expect(f.reserve.parameters).toEqual(originalSchema);
    expect(f.agent.instructions).toBe('Original booking instructions');
    expect(f.received.mock.calls.at(-1)![0].tools[0]).toMatchObject({
      parameters: { properties: { seats: { maximum: 3 } } },
    });
    f.sampling.assertComplete();
  });

  it('keeps rejection authoritative despite a prepared declaration', async () => {
    const f = scenario();
    const pending = await f.runner.run(f.agent, f.input);
    pending.state.reject(pending.interruptions[0]);
    const result = await f.runner.run(f.agent, pending.state);
    expect(result.finalOutput).toBe('Finished.');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.disabledExecute).not.toHaveBeenCalled();
    f.sampling.assertComplete();
  });

  it('validates against the registered schema after approval despite widening the sampled schema', async () => {
    const f = scenario('reserve_seats', '{"seats":9}');
    const originalSchema = structuredClone(f.reserve.parameters);
    const pending = await f.runner.run(f.agent, f.input);
    expect(pending.interruptions).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    pending.state.approve(pending.interruptions[0]);
    await f.runner.run(f.agent, pending.state);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.reserve.parameters).toEqual(originalSchema);
    expect(JSON.stringify(f.sampling.lastCall!.request.input)).toContain(
      'An error occurred while running the tool',
    );
    f.sampling.assertComplete();
  });

  it.each(['erase_bookings', 'invented_tool'])(
    'does not execute a disabled or invented call: %s',
    async (name) => {
      const f = scenario(name, '{}');
      const outcome = await f.runner.run(f.agent, f.input).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.disabledExecute).not.toHaveBeenCalled();
      expect(JSON.stringify(f.sampling.firstCall!.request.tools)).not.toContain(
        'erase_bookings',
      );
      if (outcome.error !== undefined) {
        expect(outcome.error).toBeInstanceOf(ModelBehaviorError);
        expect((outcome.error as Error).message).toContain(name);
        expect(f.sampling.calls).toHaveLength(1);
      } else {
        expect(outcome.result?.finalOutput).toBe('Finished.');
        expect(JSON.stringify(f.sampling.lastCall!.request.input)).toContain(
          `Tool '${name}' not found.`,
        );
        f.sampling.assertComplete();
      }
    },
  );

  it('runs the maintained offline example', async () => {
    expect(await runPreparedDeclarationsExample()).toMatchObject({
      finalOutput: 'Your two seats are reserved.',
      bookings: [2],
    });
  });
});
