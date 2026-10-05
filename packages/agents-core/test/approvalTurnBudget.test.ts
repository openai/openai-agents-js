import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, MaxTurnsExceededError, Runner, RunState, tool } from '../src';
import { ScriptedModel, modelResponse, functionCall } from '../src/testing';

for (const stream of [false, true]) {
  for (const decision of ['approve', 'reject'] as const) {
    it(`bounds repeated ${decision} resumes (stream=${stream})`, async () => {
      let executions = 0;
      const model = new ScriptedModel(
        Array.from({ length: 4 }, (_, i) =>
          modelResponse([functionCall('check', {}, { callId: `call_${i}` })]),
        ),
      );
      const agent = new Agent({
        name: 'Budget',
        model,
        tools: [
          tool({
            name: 'check',
            description: 'Approval tool',
            parameters: z.object({}),
            needsApproval: true,
            execute: () => {
              executions++;
              return 'ok';
            },
          }),
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      const execute = async (
        input: string | RunState<any, any>,
        maxTurns?: number,
      ) => {
        const result = stream
          ? await runner.run(agent, input, { stream: true, maxTurns })
          : await runner.run(agent, input, { maxTurns });
        if ('completed' in result) {
          for await (const _event of result.toStream()) {
            /* drain */
          }
          await result.completed;
        }
        return result;
      };
      let input: string | RunState<any, any> = 'Check';
      for (let i = 0; i < 3; i++) {
        const result = await execute(input, i === 0 ? 3 : undefined);
        expect(result.interruptions).toHaveLength(1);
        expect(model.calls).toHaveLength(i + 1);
        // Alternate direct and serialized resumes, preserving the initial budget.
        input =
          i === 1
            ? result.state
            : await RunState.fromString(agent, result.state.toString());
        input[decision](input.getInterruptions()[0]);
      }
      const error = await execute(input).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(MaxTurnsExceededError);
      expect(model.calls).toHaveLength(3);
      expect(executions).toBe(decision === 'approve' ? 3 : 0);
      // Retrying the error checkpoint must not restore the spent exemption or rerun tools.
      const checkpoint = (error as MaxTurnsExceededError).state!;
      const restored = await RunState.fromString(agent, checkpoint.toString());
      await expect(execute(restored)).rejects.toBeInstanceOf(
        MaxTurnsExceededError,
      );
      expect(model.calls).toHaveLength(3);
      expect(executions).toBe(decision === 'approve' ? 3 : 0);
      // A caller can explicitly extend the existing budget.
      const extended = await execute(restored, 4);
      expect(extended.interruptions).toHaveLength(1);
      expect(model.calls).toHaveLength(4);
    });
  }

  it(`resolves pending tool approvals at the limit without another model call (stream=${stream})`, async () => {
    const model = new ScriptedModel([
      modelResponse([functionCall('check', {}, { callId: 'call_1' })]),
    ]);
    let executions = 0;
    const agent = new Agent({
      name: 'StopAfterTool',
      model,
      toolUseBehavior: 'stop_on_first_tool',
      tools: [
        tool({
          name: 'check',
          description: 'Approval tool',
          parameters: z.object({}),
          needsApproval: true,
          execute: () => {
            executions++;
            return 'done';
          },
        }),
      ],
    });
    const runner = new Runner({ tracingDisabled: true });
    const execute = async (input: string | RunState<any, any>) => {
      const result = stream
        ? await runner.run(agent, input, { stream: true, maxTurns: 1 })
        : await runner.run(agent, input, { maxTurns: 1 });
      if ('completed' in result) {
        for await (const _event of result.toStream()) {
          /* drain */
        }
        await result.completed;
      }
      return result;
    };
    const first = await execute('Check');
    const state = await RunState.fromString(agent, first.state.toString());
    const undecided = await execute(state);
    expect(undecided.interruptions).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    undecided.state.approve(undecided.interruptions[0]);
    const result = await execute(undecided.state);
    expect(result.finalOutput).toBe('done');
    expect(model.calls).toHaveLength(1);
    expect(executions).toBe(1);
  });
}
