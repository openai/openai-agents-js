import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Agent } from '../src/agent';
import { handoff } from '../src/handoff';
import { Runner } from '../src/run';
import { RunState } from '../src/runState';
import {
  ModelBehaviorError,
  OutputGuardrailTripwireTriggered,
} from '../src/errors';
import { MemorySession } from '../src/memory/memorySession';
import { tool } from '../src/tool';
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from '../src/testing/scriptedModel';
import { RunContext } from '../src/runContext';

describe('handoff callback errors', () => {
  it('preserves an onHandoff error after valid input is parsed', async () => {
    const target = new Agent({ name: 'Target' });
    const callbackError = new Error('database unavailable');
    const h = handoff(target, {
      inputType: z.object({ reason: z.string() }),
      onHandoff: async () => {
        throw callbackError;
      },
    });

    await expect(
      h.onInvokeHandoff(new RunContext(), '{"reason":"billing"}'),
    ).rejects.toBe(callbackError);
  });

  const feedback = 'Include a reason for the transfer.';
  function transfer(args: string, callId = 'attempt') {
    return functionCall('transfer_to_Target', args, { callId });
  }
  function runner() {
    return new Runner({ tracingDisabled: true });
  }

  it('streams feedback to the source, then transfers only after corrected arguments', async () => {
    const sourceModel = new ScriptedModel([
      [transfer('{}')],
      [transfer('{"reason":"billing"}', 'retry')],
    ]);
    const target = new Agent({
      name: 'Target',
      model: new ScriptedModel([[assistantMessage('transferred')]]),
    });
    const onHandoff = vi.fn();
    const inputFilter = vi.fn((input) => input);
    const h = handoff(target, {
      inputType: z.object({ reason: z.string() }),
      onHandoff,
      inputFilter,
      errorFunction: (_context, error) => {
        if (!(error instanceof ModelBehaviorError)) throw error;
        return feedback;
      },
    }).clone();
    const source = new Agent({
      name: 'Source',
      model: sourceModel,
      handoffs: [h],
    });
    const r = runner();
    const transferred = vi.fn();
    r.on('agent_handoff', transferred);
    source.on('agent_handoff', transferred);
    const stream = await r.run(source, 'route me', { stream: true });
    const events: string[] = [];
    for await (const event of stream) {
      if (event.type === 'run_item_stream_event') events.push(event.name);
    }
    await stream.completed;
    expect(stream.finalOutput).toBe('transferred');
    expect(sourceModel.calls[1].request.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'attempt',
          output: { type: 'text', text: feedback },
        }),
      ]),
    );
    expect(
      events.filter((name) =>
        ['handoff_requested', 'tool_output', 'handoff_occurred'].includes(name),
      ),
    ).toEqual([
      'handoff_requested',
      'tool_output',
      'handoff_requested',
      'handoff_occurred',
    ]);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(transferred).toHaveBeenCalledTimes(2);
    expect(inputFilter).toHaveBeenCalledTimes(1);
  });

  it('balances a managed continuation when the first of two requested transfers fails', async () => {
    const failure = new Error('private diagnostic');
    const onHandoff = vi.fn(() => {
      throw failure;
    });
    const target = new Agent({ name: 'Target' });
    const ignored = new Agent({ name: 'Ignored' });
    const model = new ScriptedModel([
      [
        transfer('{}'),
        functionCall('transfer_to_Ignored', {}, { callId: 'ignored' }),
      ],
      [assistantMessage('source answered')],
    ]);
    const errorFunction = vi.fn(async (_context, error) => {
      if (error !== failure) throw error;
      return 'Answer directly.';
    });
    const source = new Agent({
      name: 'Source',
      model,
      handoffs: [handoff(target, { onHandoff, errorFunction }), ignored],
    });
    const result = await runner().run(source, 'route me', {
      previousResponseId: 'initial',
    });
    expect(result.finalOutput).toBe('source answered');
    expect(result.lastAgent).toBe(source);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(errorFunction).toHaveBeenCalledTimes(1);
    expect(model.calls[1].request.input).toEqual([
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'attempt',
        output: { type: 'text', text: 'Answer directly.' },
      }),
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'ignored',
      }),
    ]);
    expect(result.history).not.toContainEqual(
      expect.objectContaining({ callId: 'ignored' }),
    );
  });

  it('pairs the first fresh handoff after a committed replay with its own feedback', async () => {
    const model = new ScriptedModel([
      [transfer('{}', 'a')],
      [transfer('{}', 'a'), transfer('{}', 'b'), transfer('{}', 'b')],
      [transfer('{}', 'b')],
      [assistantMessage('done')],
    ]);
    const onHandoff = vi.fn(() => {
      throw new Error('busy');
    });
    const source = new Agent({
      name: 'Source',
      model,
      handoffs: [
        handoff(new Agent({ name: 'Target' }), {
          onHandoff,
          errorFunction: () => feedback,
        }),
      ],
    });
    const result = await runner().run(source, 'route me', {
      previousResponseId: 'initial',
    });
    expect(result.finalOutput).toBe('done');
    expect(onHandoff).toHaveBeenCalledTimes(2);
    expect(
      result.history
        .filter((item) => 'callId' in item && item.callId === 'b')
        .map((item) => item.type),
    ).toEqual(['function_call', 'function_call_result']);
    expect(model.calls[2].request.input).toEqual([
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'b',
        output: { type: 'text', text: feedback },
      }),
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'a',
        output: { type: 'text', text: feedback },
      }),
    ]);
    expect(model.calls[3].request.input).toEqual([
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'b',
        output: { type: 'text', text: feedback },
      }),
    ]);
  });

  it('preserves a handled invocation across approval and restore', async () => {
    const onHandoff = vi.fn(() => {
      throw new Error('try later');
    });
    const gate = tool({
      name: 'gate',
      description: 'Request approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: () => 'approved',
    });
    const model = new ScriptedModel([
      [transfer('{}')],
      [functionCall('gate', {}, { callId: 'approval' })],
      [transfer('{}')],
      [assistantMessage('done')],
    ]);
    const source = new Agent({
      name: 'Source',
      model,
      tools: [gate],
      handoffs: [
        handoff(new Agent({ name: 'Target' }), {
          onHandoff,
          errorFunction: () => feedback,
        }),
      ],
    });
    const r = runner();
    const pending = await r.run(source, 'route me');
    const snapshot = pending.state.toJSON();
    expect(snapshot.$schemaVersion).toBe('1.24');
    await expect(
      RunState.fromString(
        source,
        JSON.stringify({ ...snapshot, $schemaVersion: '1.23' }),
      ),
    ).rejects.toThrow('recovered handoff evidence');
    const restored = await RunState.fromString(
      source,
      pending.state.toString(),
    );
    restored.approve(restored.getInterruptions()[0]);
    const result = await r.run(source, restored);
    expect(result.finalOutput).toBe('done');
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });

  it('preserves the handoff pair in a Session when the next answer trips an output guardrail', async () => {
    const model = new ScriptedModel([
      [transfer('{}')],
      [assistantMessage('blocked')],
    ]);
    const session = new MemorySession();
    const source = new Agent({
      name: 'Source',
      model,
      handoffs: [
        handoff(new Agent({ name: 'Target' }), {
          onHandoff: () => {
            throw Error();
          },
          errorFunction: () => feedback,
        }),
      ],
      outputGuardrails: [
        {
          name: 'block',
          execute: async () => ({ tripwireTriggered: true, outputInfo: {} }),
        },
      ],
    });
    await expect(
      runner().run(source, 'route me', { session }),
    ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
    const items = await session.getItems();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', callId: 'attempt' }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'attempt',
        }),
      ]),
    );
    expect(JSON.stringify(items)).not.toContain('"blocked"');
  });

  function runHandoff(
    config: Parameters<typeof handoff>[1],
    options: { signal?: AbortSignal } = {},
  ) {
    const source = new Agent({
      name: 'Source',
      model: new ScriptedModel([[transfer('{}')]]),
      handoffs: [handoff(new Agent({ name: 'Target' }), config)],
    });
    return runner().run(source, 'route me', options);
  }

  it('propagates the original callback error by default and lets a formatter decline recovery', async () => {
    const failure = new Error('external state uncertain');
    const onHandoff = () => {
      throw failure;
    };
    await expect(runHandoff({ onHandoff })).rejects.toBe(failure);
    await expect(
      runHandoff({
        onHandoff,
        errorFunction: (_ctx, error) => {
          throw error;
        },
      }),
    ).rejects.toBe(failure);
  });

  it.each(['async validator', 'validator cancellation'] as const)(
    'keeps %s outside model-input recovery',
    async (mode) => {
      const aborted = new DOMException('validator cancelled', 'AbortError');
      const errorFunction = vi.fn(() => feedback);
      const config = {
        inputType: {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            jsonSchema: {
              input: () => ({ type: 'object' }),
              output: () => ({ type: 'object' }),
            },
            validate: () => {
              if (mode === 'validator cancellation') throw aborted;
              return Promise.resolve({ value: {} });
            },
          },
        },
        onHandoff: vi.fn(),
        errorFunction,
      };
      await expect(
        handoff(new Agent({ name: 'Target' }), config).onInvokeHandoff(
          new RunContext(),
          '{}',
        ),
      ).rejects.toBeInstanceOf(ModelBehaviorError);
      const result = runHandoff(config);
      if (mode === 'validator cancellation')
        await expect(result).rejects.toBe(aborted);
      else
        await expect(result).rejects.toThrow(
          'Async Standard Schema validation is not supported',
        );
      expect(errorFunction).not.toHaveBeenCalled();
    },
  );

  it('propagates formatter errors', async () => {
    const failure = new Error('formatter unavailable');
    await expect(
      runHandoff({
        onHandoff: () => {
          throw new Error('invocation failed');
        },
        errorFunction: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('keeps transfer filter and listener failures outside recovery', async () => {
    const failure = new Error('post-invocation failure');
    const errorFunction = vi.fn(() => feedback);
    await expect(
      runHandoff({
        inputFilter: () => {
          throw failure;
        },
        errorFunction,
      }),
    ).rejects.toBe(failure);
    const r = runner();
    r.on('agent_handoff', () => {
      throw failure;
    });
    const agent = new Agent({
      name: 'Source',
      model: new ScriptedModel([[transfer('{}')]]),
      handoffs: [handoff(new Agent({ name: 'Target' }), { errorFunction })],
    });
    await expect(r.run(agent, 'route me')).rejects.toBe(failure);
    expect(errorFunction).not.toHaveBeenCalled();
  });

  it('propagates a callback AbortError without offering recovery', async () => {
    const failure = new DOMException('cancelled', 'AbortError');
    const errorFunction = vi.fn(() => feedback);
    await expect(
      runHandoff({
        onHandoff: () => {
          throw failure;
        },
        errorFunction,
      }),
    ).rejects.toBe(failure);
    expect(errorFunction).not.toHaveBeenCalled();
  });

  it.each(['invocation', 'formatter'] as const)(
    'preserves caller cancellation while awaiting the %s',
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error('cancelled by caller');
      let enter!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const suspended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const errorFunction = vi.fn(async () => {
        enter();
        await suspended;
        return feedback;
      });
      const result = runHandoff(
        {
          onHandoff: async () => {
            if (phase === 'invocation') {
              enter();
              await suspended;
            }
            throw new Error('invocation failed');
          },
          errorFunction,
        },
        { signal: controller.signal },
      );
      await entered;
      controller.abort(reason);
      finish();
      await expect(result).rejects.toBe(reason);
      expect(errorFunction).toHaveBeenCalledTimes(
        phase === 'formatter' ? 1 : 0,
      );
    },
  );
});
