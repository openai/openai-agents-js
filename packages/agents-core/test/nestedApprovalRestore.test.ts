import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  RunContext,
  Runner,
  RunState,
  ToolCallError,
  UserError,
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

  it.each(['display-only', 'JSON string'] as const)(
    'handles a %s result before publishing a second nested approval',
    async (representation) => {
      const result =
        representation === 'display-only' ? new Uint8Array([1]) : 'retained';
      const read = vi.fn(async () => result);
      const approve = vi.fn(async () => 'approved');
      const nestedModel = new ScriptedModel([
        [call('approve', 'first')],
        [call('read', 'result'), call('approve', 'second')],
      ]);
      const seen: unknown[][] = [];
      const nested = new Agent({
        name: 'Nested',
        model: nestedModel,
        tools: [
          tool({
            name: 'read',
            description: '',
            parameters: z.object({}),
            execute: read,
          }),
          tool({
            name: 'approve',
            description: '',
            parameters: z.object({}),
            needsApproval: true,
            execute: approve,
          }),
        ],
        toolUseBehavior: (_context, results) => {
          seen.push(
            results
              .filter((item) => item.type === 'function_output')
              .map((item) => item.output),
          );
          return results.length === 1
            ? { isFinalOutput: false, isInterrupted: undefined }
            : {
                isFinalOutput: true,
                isInterrupted: undefined,
                finalOutput: 'nested done',
              };
        },
      });
      const parent = new Agent({
        name: 'Parent',
        model: new ScriptedModel([
          [functionCall('nested', { input: 'work' }, { callId: 'outer' })],
          [message('Parent done')],
        ]),
        tools: [
          nested.asTool({ toolName: 'nested', toolDescription: 'Nested' }),
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      const paused = await runner.run(parent, 'start');
      paused.state.approve(paused.interruptions[0]);
      const toolEnd = vi.fn();
      parent.on('agent_tool_end', toolEnd);
      const resume = runner.run(parent, paused.state);
      if (representation === 'display-only') {
        const error = await resume.catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ToolCallError);
        if (!(error instanceof ToolCallError)) throw error;
        expect(error.error).toBeInstanceOf(UserError);
        expect(error.message).toMatch(
          /Return a JSON-compatible value from the child tool/,
        );
        expect(toolEnd).toHaveBeenCalledTimes(1);
        expect(toolEnd.mock.calls[0][2]).toContain('Cannot request approval');
        expect(error.state?.getInterruptions()).not.toContainEqual(
          expect.objectContaining({
            rawItem: expect.objectContaining({ callId: 'second' }),
          }),
        );
        const childCheckpoint = error.state!.getPendingAgentToolRun(
          'nested',
          'outer',
        )!;
        const child = await RunState.fromString(nested, childCheckpoint);
        expect(child.getInterruptions()[0].rawItem).toMatchObject({
          callId: 'second',
        });
        expect(approve).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([['approved']]);
      } else {
        const next = await resume;
        expect(next.interruptions[0].rawItem).toMatchObject({
          callId: 'second',
        });
        next.state.approve(next.interruptions[0]);
        const completed = await runner.run(parent, next.state);
        expect(completed.finalOutput).toBe('Parent done');
        expect(approve).toHaveBeenCalledTimes(2);
        expect(seen).toEqual([['approved'], ['retained', 'approved']]);
      }
      expect(read).toHaveBeenCalledTimes(1);
      expect(nestedModel.calls).toHaveLength(2);
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
