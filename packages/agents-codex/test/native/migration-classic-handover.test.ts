import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  RunState,
  setTracingDisabled,
  tool,
} from '@openai/agents-core';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
  modelResponder,
} from '@openai/agents-core/testing';
import { parseSessionState } from '../../src';
import { SDKRunner } from '../../src/migration';
import { runClassicHandover } from '../../examples/migration-classic-handover';

setTracingDisabled(true);

describe('classic approval to completed Session handover', () => {
  it.each(['approve', 'reject'] as const)(
    'runs the maintained example with an explicit %s decision',
    async (decision) => {
      const decide = vi.fn(async () => decision);
      const { result, effects } = await runClassicHandover(decide);

      expect(decide).toHaveBeenCalledExactlyOnceWith({
        name: 'record_approved',
        callId: 'original-held-call',
        arguments: '{}',
      });
      expect(effects).toBe(decision === 'approve' ? 1 : 0);
      expect(result.finalOutput).toBe('Native continuation complete.');
      expect(result.native.sessionId).toBeTruthy();
    },
  );

  it('finishes the original held call once before continuing through the native adapter', async () => {
    const execute = vi.fn(({ value }: { value: string }) => value);
    const heldTool = tool({
      name: 'record_value',
      description: 'Record a value after application approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute,
    });
    const originalCall = functionCall(
      'record_value',
      { value: 'approved value' },
      { callId: 'original-held-call', id: 'original-call-item' },
    );
    const identity = {
      callId: originalCall.callId,
      name: originalCall.name,
      arguments: originalCall.arguments,
    };
    const classicModel = new ScriptedModel([
      modelResponse([originalCall]),
      modelResponse([assistantMessage('Classic work completed.')]),
    ]);
    const classicAgent = new Agent({
      name: 'Original classic approval owner',
      instructions: 'Record the requested value and then finish.',
      model: classicModel,
      tools: [heldTool],
    });
    const classicRunner = new Runner({ tracingDisabled: true });
    const session = new MemorySession();
    const pending = await classicRunner.run(classicAgent, 'Record a value.', {
      session,
    });
    expect(pending.interruptions).toHaveLength(1);
    expect(pending.interruptions[0]!.rawItem).toMatchObject(identity);
    expect(execute).not.toHaveBeenCalled();
    expect(classicModel.calls).toHaveLength(1);
    const heldHistory = await session.getItems();
    expect(heldHistory).toHaveLength(2);
    expect(heldHistory[1]).toMatchObject({
      type: 'function_call',
      ...identity,
    });

    // A new approval-free declaration does not change the original classic owner.
    const nativeTool = tool({
      name: 'record_value',
      description: 'Record a value.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const rejectedAgent = new Agent({
      name: 'Reject classic state as native input',
      instructions: 'Continue only from completed history.',
      model: 'selected',
      tools: [nativeTool],
    });
    const getModel = vi.fn(() => new ScriptedModel([]));
    const getItems = vi.spyOn(session, 'getItems');
    const addItems = vi.spyOn(session, 'addItems');
    const callback = vi.fn(
      (history: AgentInputItem[], fresh: AgentInputItem[]) => [
        ...history,
        ...fresh,
      ],
    );
    await expect(
      SDKRunner.run(
        rejectedAgent,
        // @ts-expect-error Classic RunState is deliberately not native input.
        pending.state,
        {
          context: undefined,
          session,
          sessionInputCallback: callback,
          modelProvider: { getModel },
        },
      ),
    ).rejects.toThrow('requires completed text or inline-image history');
    const serialized = pending.state.toString();
    expect(() => parseSessionState(serialized)).toThrow();
    expect(getModel).not.toHaveBeenCalled();
    expect(getItems).not.toHaveBeenCalled();
    expect(addItems).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    getItems.mockRestore();
    addItems.mockRestore();

    const restored = await RunState.fromString<undefined, typeof classicAgent>(
      classicAgent,
      serialized,
    );
    const interruptions = restored.getInterruptions();
    expect(interruptions[0]!.agent).toBe(classicAgent);
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]!.rawItem).toMatchObject(identity);
    expect(execute).not.toHaveBeenCalled();

    // This application decision authorizes only the displayed restored call.
    restored.approve(interruptions[0]!);
    const finished = await classicRunner.run(classicAgent, restored, {
      session,
    });
    expect(finished.interruptions).toHaveLength(0);
    expect(finished.finalOutput).toBe('Classic work completed.');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ value: 'approved value' });
    expect(classicModel.calls).toHaveLength(2);

    const completedHistory = await session.getItems();
    expect(completedHistory).toHaveLength(4);
    expect(completedHistory.slice(0, 2)).toEqual(heldHistory);
    expect(completedHistory.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_result',
      'message',
    ]);
    const calls = completedHistory.filter(
      (item) => item.type === 'function_call',
    );
    const results = completedHistory.filter(
      (item) => item.type === 'function_call_result',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(identity);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      callId: identity.callId,
      name: identity.name,
      status: 'completed',
      output: { type: 'text', text: 'approved value' },
    });

    const nativeModel = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.input).toEqual([
          ...completedHistory,
          { type: 'message', role: 'user', content: 'Continue natively.' },
        ]);
        return [assistantMessage('Native continuation completed.')];
      }),
    ]);
    const result = await SDKRunner.run(
      new Agent({
        name: 'Fresh approval-free native continuation',
        instructions: 'Continue from completed history without repeating work.',
        model: nativeModel,
        tools: [nativeTool],
      }),
      'Continue natively.',
      { context: undefined, session },
    );
    expect(result.finalOutput).toBe('Native continuation completed.');
    expect(nativeModel.calls).toHaveLength(1);
    expect(classicModel.calls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const stored = await session.getItems();
    expect(stored).toEqual([
      ...completedHistory,
      { type: 'message', role: 'user', content: 'Continue natively.' },
      ...result.newItems.map((item) => item.rawItem),
    ]);
    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]!.rawItem).toEqual(
      assistantMessage('Native continuation completed.'),
    );
  });
});
