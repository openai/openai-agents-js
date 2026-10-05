import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunContext,
  RunState,
  Runner,
  Usage,
  tool,
  user,
} from '../src';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '../src/testing';

const privateRecord = 'SYNTHETIC_PRIVATE_RECORD';

function pendingLookup() {
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const toolCanFinish = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const execute = vi.fn(async () => {
    started();
    await toolCanFinish;
    return privateRecord;
  });
  const lookup = tool({
    name: 'lookup',
    description: 'Returns a synthetic record',
    parameters: z.object({}),
    execute,
  });
  const model = new ScriptedModel([
    modelResponse({
      usage: new Usage(),
      output: [functionCall('lookup', {}, { callId: 'lookup-call' })],
    }),
  ]);
  return { lookup, model, execute, toolStarted, finish };
}

describe('cancelled terminal tool output', () => {
  it.each([
    { source: 'agent', reject: true },
    { source: 'runner', reject: false },
  ] as const)(
    'defers persistence until the $source guardrail validates on resume',
    async ({ source, reject }) => {
      const controller = new AbortController();
      const abortReason = new Error('cancel pending tool');
      const pending = pendingLookup();
      const guardrail = vi.fn(async () => ({
        tripwireTriggered: reject,
        outputInfo: {},
      }));
      const outputGuardrails = [
        { name: 'Check private records', execute: guardrail },
      ];
      const agent = new Agent({
        name: 'Cancelled terminal output',
        model: pending.model,
        tools: [pending.lookup],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: source === 'agent' ? outputGuardrails : [],
      });
      const runner = new Runner({
        tracingDisabled: true,
        outputGuardrails: source === 'runner' ? outputGuardrails : [],
      });
      const earlier = user('earlier accepted input');
      const session = new MemorySession();
      await session.addItems([earlier]);
      const cancelledState = new RunState(
        new RunContext(),
        'lookup',
        agent,
        10,
      );
      const promise = runner.run(agent, cancelledState, {
        session,
        signal: controller.signal,
      });
      const rejected = expect(promise).rejects.toBe(abortReason);
      await pending.toolStarted;
      controller.abort(abortReason);
      pending.finish();
      await rejected;

      expect(guardrail).not.toHaveBeenCalled();
      expect(await session.getItems()).toEqual([earlier]);
      const resumed = runner.run(agent, cancelledState, { session });
      if (reject) {
        await expect(resumed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        expect(JSON.stringify(await session.getItems())).not.toContain(
          privateRecord,
        );
      } else {
        expect((await resumed).finalOutput).toBe(privateRecord);
        expect(
          (await session.getItems()).filter(
            (item) => item.type === 'function_call_result',
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(await session.getItems())).toContain(
          privateRecord,
        );
      }
      expect(guardrail).toHaveBeenCalledTimes(1);
      expect(pending.execute).toHaveBeenCalledTimes(1);
      expect((await session.getItems())[0]).toEqual(earlier);
    },
  );

  it.each(['string', 'array'] as const)(
    'preserves redacted completion history for ordinary %s input',
    async (inputKind) => {
      const pending = pendingLookup();
      const controller = new AbortController();
      const abortReason = new Error('cancel ordinary tool call');
      const guardrail = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const model = new ScriptedModel([
        modelResponse({
          usage: new Usage(),
          output: [functionCall('lookup', {}, { callId: 'lookup-call' })],
        }),
        {
          type: 'responder',
          respond: ({ request }) => {
            expect(JSON.stringify(request.input)).not.toContain(privateRecord);
            expect(request.input).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: 'function_call',
                  callId: 'lookup-call',
                }),
                expect.objectContaining({
                  type: 'function_call_result',
                  callId: 'lookup-call',
                  output:
                    'Tool output discarded because the run was cancelled before output validation.',
                }),
              ]),
            );
            return [assistantMessage('The tool already completed.')];
          },
        },
      ]);
      const agent = new Agent({
        name: 'Ordinary cancelled output',
        model,
        tools: [pending.lookup],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [{ name: 'Validate output', execute: guardrail }],
      });
      const session = new MemorySession();
      const earlier = user('earlier accepted input');
      await session.addItems([earlier]);
      const runner = new Runner({ tracingDisabled: true });
      const promise = runner.run(
        agent,
        inputKind === 'string' ? 'lookup' : [user('lookup')],
        {
          session,
          signal: controller.signal,
        },
      );
      const rejected = expect(promise).rejects.toBe(abortReason);
      await pending.toolStarted;
      controller.abort(abortReason);
      pending.finish();
      await rejected;
      expect(guardrail).not.toHaveBeenCalled();
      const history = await session.getItems();
      expect(history[0]).toEqual(earlier);
      expect(JSON.stringify(history)).not.toContain(privateRecord);
      expect(
        history.filter((item) => item.type === 'function_call_result'),
      ).toHaveLength(1);
      const continued = await runner.run(agent, 'What happened?', { session });
      expect(continued.finalOutput).toBe('The tool already completed.');
      expect(pending.execute).toHaveBeenCalledTimes(1);
      expect(guardrail).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an unguarded terminal checkpoint after cancellation', async () => {
    const pending = pendingLookup();
    const controller = new AbortController();
    const abortReason = new Error('cancel unguarded tool');
    const agent = new Agent({
      name: 'Unguarded terminal output',
      model: pending.model,
      tools: [pending.lookup],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const session = new MemorySession();
    const promise = new Runner({ tracingDisabled: true }).run(agent, 'lookup', {
      session,
      signal: controller.signal,
    });
    const rejected = expect(promise).rejects.toBe(abortReason);
    await pending.toolStarted;
    controller.abort(abortReason);
    pending.finish();
    await rejected;
    expect(JSON.stringify(await session.getItems())).toContain(privateRecord);
    expect(pending.execute).toHaveBeenCalledTimes(1);
  });
});
