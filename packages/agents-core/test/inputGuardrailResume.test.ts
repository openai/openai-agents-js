import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  ModelBehaviorError,
  Runner,
  RunState,
  RunContext,
  setTracingDisabled,
  tool,
} from '../src';
import {
  assistantMessage,
  functionCall,
  modelResponder,
  modelError,
  modelResponse,
  ScriptedModel,
} from '../src/testing';

beforeAll(() => setTracingDisabled(true));

describe.each([false, true])(
  'input guardrail recovery (stream=%s)',
  (stream) => {
    it.each([false, true])(
      'rejects a failed input checkpoint before another model or tool call (serialized=%s)',
      async (serialized) => {
        let markModelStarted!: () => void;
        const modelStarted = new Promise<void>((resolve) => {
          markModelStarted = resolve;
        });
        const execute = vi.fn().mockResolvedValue('tool result');
        const guardedTool = tool({
          name: 'record_action',
          description: 'Record a synthetic action',
          parameters: z.object({}),
          execute,
        });
        const model = new ScriptedModel([
          modelResponder(() => {
            markModelStarted();
            return [assistantMessage('unaccepted response')];
          }),
          modelResponse([
            functionCall('record_action', '{}', { callId: 'synthetic-call' }),
          ]),
          modelResponse([assistantMessage('accepted response')]),
        ]);
        const validate = vi
          .fn()
          .mockImplementationOnce(async () => {
            await modelStarted;
            throw new Error('synthetic classifier unavailable');
          })
          .mockResolvedValue({ tripwireTriggered: true, outputInfo: null });
        const agent = new Agent({
          name: 'Guarded agent',
          model,
          tools: [guardedTool],
          inputGuardrails: [
            { name: 'validate input', execute: validate },
            {
              name: 'successful sibling',
              execute: async () => ({
                tripwireTriggered: false,
                outputInfo: null,
              }),
            },
          ],
        });
        const runner = new Runner({ tracingDisabled: true });
        const run = async (input: string | RunState<unknown, typeof agent>) => {
          if (stream) {
            const result = await runner.run(agent, input, {
              stream: true,
              maxTurns: 4,
            });
            await result.completed;
            return result;
          }
          return runner.run(agent, input, { maxTurns: 4 });
        };

        const error = await run('synthetic input').catch((error) => error);
        expect(error).toBeInstanceOf(GuardrailExecutionError);
        expect(model.calls).toHaveLength(1);
        expect(execute).not.toHaveBeenCalled();
        expect(error.state._currentTurn).toBe(1);
        const checkpoint = serialized
          ? await RunState.fromString(agent, error.state.toString())
          : error.state;

        await expect(
          run(checkpoint).then((result) => result.finalOutput),
        ).rejects.toThrow(/fresh run/i);
        expect(model.calls).toHaveLength(1);
        expect(execute).not.toHaveBeenCalled();
        expect(checkpoint._currentTurn).toBe(1);
        expect(validate).toHaveBeenCalledTimes(1);
        checkpoint.addInput('additional synthetic input');
        await expect(run(checkpoint)).rejects.toThrow(/fresh run/i);
        expect(model.calls).toHaveLength(1);

        await expect(run('synthetic input')).rejects.toBeInstanceOf(
          InputGuardrailTripwireTriggered,
        );
        expect(validate).toHaveBeenCalledTimes(2);
        expect(execute).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      'invalidates earlier completion when initial checks restart (serialized=%s)',
      async (serialized) => {
        let markModelStarted!: () => void;
        const modelStarted = new Promise<void>((resolve) => {
          markModelStarted = resolve;
        });
        const model = new ScriptedModel([
          modelResponder(() => {
            markModelStarted();
            return [assistantMessage('unaccepted')];
          }),
          modelResponse([assistantMessage('must not be reached')]),
        ]);
        const validate = vi
          .fn()
          .mockResolvedValueOnce({ tripwireTriggered: false, outputInfo: null })
          .mockImplementation(async () => {
            await modelStarted;
            throw new Error('synthetic classifier failure');
          });
        const instructions = vi
          .fn()
          .mockRejectedValueOnce(new Error('synthetic preparation failure'))
          .mockResolvedValue('synthetic instructions');
        const agent = new Agent({
          name: 'Preparation retry',
          model,
          instructions,
          inputGuardrails: [{ name: 'validate input', execute: validate }],
        });
        const runner = new Runner({ tracingDisabled: true });
        const invoke = async (state: RunState<unknown, typeof agent>) => {
          const result = await (stream
            ? runner.run(agent, state, { stream: true })
            : runner.run(agent, state));
          if ('completed' in result) await result.completed;
          return result;
        };
        let state = new RunState(new RunContext(), 'input', agent, 4);
        await expect(invoke(state)).rejects.toThrow(
          'synthetic preparation failure',
        );
        expect(state._currentTurn).toBe(0);
        expect(model.calls).toHaveLength(0);
        if (serialized)
          state = await RunState.fromString(agent, state.toString());
        await expect(invoke(state)).rejects.toBeInstanceOf(
          GuardrailExecutionError,
        );
        expect(state._currentTurn).toBe(1);
        expect(model.calls).toHaveLength(1);
        if (serialized)
          state = await RunState.fromString(agent, state.toString());
        await expect(invoke(state)).rejects.toThrow(/fresh run/i);
        expect(model.calls).toHaveLength(1);
        expect(validate).toHaveBeenCalledTimes(2);
      },
    );

    it('preserves model-error recovery after completed input checks', async () => {
      const validate = vi
        .fn()
        .mockResolvedValue({ tripwireTriggered: false, outputInfo: null });
      const model = new ScriptedModel([
        modelError(new ModelBehaviorError('synthetic model failure')),
        modelResponse([assistantMessage('accepted')]),
      ]);
      const agent = new Agent({
        name: 'Model recovery',
        model,
        inputGuardrails: [{ name: 'check', execute: validate }],
      });
      const runner = new Runner({ tracingDisabled: true });
      const invoke = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        const result = await (stream
          ? runner.run(agent, input, { stream: true })
          : runner.run(agent, input));
        if ('completed' in result) await result.completed;
        return result;
      };
      const initial = new RunState(new RunContext(), 'input', agent, 4);
      const error = await invoke(initial).catch((error) => error);
      expect(error.message).toBe('synthetic model failure');
      const restored = await RunState.fromString(agent, initial.toString());
      expect((await invoke(restored)).finalOutput).toBe('accepted');
      expect(validate).toHaveBeenCalledTimes(1);
    });

    it('rejects legacy started checkpoints but permits never-started snapshots', async () => {
      const model = new ScriptedModel([
        modelResponse([assistantMessage('accepted')]),
      ]);
      const agent = new Agent({ name: 'Legacy recovery', model });
      const runner = new Runner({ tracingDisabled: true });
      // Historical schemas have no completion evidence, even for empty batches.
      const neverStarted = new RunState(new RunContext(), 'input', agent, 4);
      const legacy = JSON.parse(neverStarted.toString());
      legacy.$schemaVersion = '1.20';
      delete legacy.initialInputGuardrailsCompleted;
      legacy.currentTurn = 1;
      const started = await RunState.fromString(agent, JSON.stringify(legacy));
      const getItems = vi.fn().mockResolvedValue([]);
      const session = {
        getSessionId: async () => 'synthetic-session',
        getItems,
        addItems: vi.fn(),
        popItem: vi.fn(),
        clearSession: vi.fn(),
      };
      await expect(
        stream
          ? runner.run(agent, started, { stream: true, session })
          : runner.run(agent, started, { session }),
      ).rejects.toThrow(/fresh run/i);
      expect(getItems).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(0);
      legacy.currentTurn = 0;
      const fresh = await RunState.fromString(agent, JSON.stringify(legacy));
      const result = await (stream
        ? runner.run(agent, fresh, { stream: true })
        : runner.run(agent, fresh));
      if ('completed' in result) await result.completed;
      expect(result.finalOutput).toBe('accepted');
    });
  },
);
