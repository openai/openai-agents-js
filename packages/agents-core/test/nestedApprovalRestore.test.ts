import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  RunContext,
  Runner,
  RunState,
  tool,
  toolNamespace,
} from '../src';
import {
  ScriptedModel,
  assistantMessage as message,
  functionCall,
} from '../src/testing';

function call(name: string, callId: string) {
  return functionCall(
    name,
    {},
    {
      callId,
      namespace: name === 'protected_tool' ? 'secure' : undefined,
    },
  );
}

describe('nested approval restoration', () => {
  it.each([false, true])(
    'keeps a current permanent rejection after nested resume (round trip: %s)',
    async (roundTrip) => {
      const execute = vi.fn(async () => 'executed');
      const protectedTool = tool({
        name: 'protected_tool',
        description: 'Run a protected function',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      });
      const checkpoint = tool({
        name: 'checkpoint',
        description: 'Pause the nested run',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'continued',
      });
      const nestedModel = new ScriptedModel([
        [call('protected_tool', 'initial')],
        [call('checkpoint', 'pause')],
        [call('protected_tool', 'fresh')],
        [message('Nested done')],
      ]);
      const nested = new Agent({
        name: 'Nested',
        model: nestedModel,
        tools: [
          ...toolNamespace({
            name: 'secure',
            description: 'Protected functions',
            tools: [protectedTool],
          }),
          checkpoint,
        ],
      });
      const outer = new Agent({
        name: 'Outer',
        model: new ScriptedModel([
          [
            {
              ...call('nested', 'outer'),
              arguments: JSON.stringify({ input: 'start' }),
            },
          ],
          [message('Outer done')],
        ]),
        tools: [
          nested.asTool({ toolName: 'nested', toolDescription: 'Nested' }),
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      const first = await runner.run(outer, 'start');
      expect(first.interruptions).toHaveLength(1);
      const grant = first.interruptions[0];
      first.state.approve(grant, { alwaysApprove: true });
      const paused = await runner.run(outer, first.state);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(paused.interruptions).toHaveLength(1);
      const current = roundTrip
        ? await RunState.fromString<undefined, typeof outer>(
            outer,
            paused.state.toString(),
          )
        : paused.state;
      current.reject(grant, { alwaysReject: true, message: 'Grant revoked' });
      current.approve(current.getInterruptions()[0]);
      const resumed = await runner.run(outer, current);
      expect(resumed.finalOutput).toBe('Outer done');
      expect(resumed.interruptions).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(nestedModel.lastCall?.request.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'fresh',
            output: expect.objectContaining({ text: 'Grant revoked' }),
          }),
        ]),
      );
    },
  );

  it.each(['merge', 'replace', 'current approval'] as const)(
    'restores saved decisions with %s semantics',
    async (strategy) => {
      const execute = vi.fn(async () => 'executed');
      const protectedTool = tool({
        name: 'protected_tool',
        description: 'Run a protected function',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      });
      const checkpoint = tool({
        name: 'checkpoint',
        description: 'Pause the nested run',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'continued',
      });
      const agent = new Agent({
        name: 'Worker',
        model: new ScriptedModel([
          [call('protected_tool', 'initial')],
          [call('checkpoint', 'pause')],
          [call('protected_tool', 'fresh')],
          [message('Done')],
        ]),
        tools: [
          ...toolNamespace({
            name: 'secure',
            description: 'Protected functions',
            tools: [protectedTool],
          }),
          checkpoint,
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      const first = await runner.run(agent, 'start');
      const decision = first.interruptions[0];
      if (strategy === 'current approval') {
        first.state.reject(decision, {
          alwaysReject: true,
          message: 'Old rejection',
        });
      } else {
        first.state.approve(decision, { alwaysApprove: true });
      }
      const paused = await runner.run(agent, first.state);
      expect(paused.interruptions).toHaveLength(1);
      const context = new RunContext();
      if (strategy === 'current approval') {
        context.approveTool(decision, { alwaysApprove: true });
      }
      const restored = await RunState.fromStringWithContext(
        agent,
        paused.state.toString(),
        context,
        { contextStrategy: strategy === 'replace' ? 'replace' : 'merge' },
      );
      restored.approve(restored.getInterruptions()[0]);
      const resumed = await runner.run(agent, restored);
      if (strategy === 'replace') {
        expect(resumed.interruptions).toHaveLength(1);
        expect(resumed.interruptions[0].rawItem).toMatchObject({
          callId: 'fresh',
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } else {
        expect(resumed.finalOutput).toBe('Done');
        expect(resumed.interruptions).toHaveLength(0);
        expect(execute).toHaveBeenCalledTimes(strategy === 'merge' ? 2 : 1);
      }
      // The saved decision belongs to Worker, even when another owner exposes
      // the same qualified function and reuses the model's call id.
      const other = new Agent({
        name: 'Other worker',
        model: new ScriptedModel([[call('protected_tool', 'fresh')]]),
        tools: agent.tools,
      });
      const otherResult = await runner.run(other, 'start', { context });
      expect(otherResult.interruptions).toHaveLength(1);
    },
  );
});
