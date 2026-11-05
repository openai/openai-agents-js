import { describe, expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  Agent,
  MemorySession,
  setTracingDisabled,
  tool,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
  modelResponder,
} from '@openai/agents-core/testing';
import { z } from 'zod';
import { SDKRunner } from '../../src/migration';

setTracingDisabled(true);

function completedHistory(): AgentInputItem[] {
  return [
    {
      type: 'message',
      id: 'history-system',
      role: 'system',
      content: 'Retain the supplied conversation.',
      providerData: { id: 'history-system', type: 'message' },
    },
    {
      type: 'message',
      id: 'history-user',
      role: 'user',
      content: [{ type: 'input_text', text: 'Read the old value.' }],
    },
    {
      type: 'message',
      id: 'history-assistant',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [
        {
          type: 'output_text',
          text: 'Looking up the old value.',
          providerData: { annotations: [], logprobs: [] },
        },
      ],
      providerData: {
        id: 'history-assistant',
        type: 'message',
        phase: 'commentary',
      },
    },
    functionCall('retired_effect', ' { "value": "old" } ', {
      callId: 'historical-call',
      id: 'historical-call-item',
      providerData: { id: 'historical-call-item', type: 'function_call' },
    }),
    {
      type: 'function_call_result',
      id: 'historical-result-item',
      callId: 'historical-call',
      name: 'retired_effect',
      status: 'completed',
      output: 'old accepted value',
      providerData: {
        id: 'historical-result-item',
        type: 'function_call_result',
      },
    },
  ];
}

describe('caller-supplied completed history on the native adapter', () => {
  it.each(['response', 'stream'] as const)(
    'continues a completed function result without a fresh user in %s mode',
    async (modelInvocation) => {
      const input = completedHistory();
      const expectedInput = structuredClone(input);
      const effects: string[] = [];
      const currentCall = functionCall(
        'current_effect',
        { value: 'fresh' },
        {
          callId: 'current-call',
          id: 'current-call-item',
        },
      );
      const finalMessage = assistantMessage('Current complete.', {
        id: 'current-final-message',
      });
      const model = new ScriptedModel([
        modelResponder(({ request }) => {
          expect(request.input).toEqual(expectedInput);
          expect(request.tools.map((entry) => entry.name)).toEqual([
            'current_effect',
          ]);
          expect(effects).toEqual([]);
          return [currentCall];
        }),
        modelResponder(({ request }) => {
          if (!Array.isArray(request.input))
            throw new Error('Expected SDK history items');
          expect(request.input.slice(0, expectedInput.length)).toEqual(
            expectedInput,
          );
          const generated = request.input.slice(expectedInput.length);
          expect(generated.map((item) => item.type)).toEqual([
            'function_call',
            'function_call_result',
          ]);
          expect(generated[0]).toMatchObject({
            type: 'function_call',
            callId: 'current-call',
            name: 'current_effect',
            arguments: JSON.stringify({ value: 'fresh' }),
          });
          expect(generated[1]).toMatchObject({
            type: 'function_call_result',
            callId: 'current-call',
            name: 'current_effect',
            status: 'completed',
            output: 'accepted:fresh',
          });
          expect(effects).toEqual(['fresh']);
          return [finalMessage];
        }),
      ]);
      const agent = new Agent({
        name: 'Caller history consumer',
        instructions: 'Continue the supplied history using current tools.',
        model,
        modelSettings: {},
        tools: [
          tool({
            name: 'current_effect',
            description: 'Record one new value.',
            parameters: z.object({ value: z.string() }),
            execute({ value }) {
              effects.push(value);
              return `accepted:${value}`;
            },
          }),
        ],
      });
      const result = await SDKRunner.run(agent, input, {
        context: undefined,
        modelInvocation,
        signal: AbortSignal.timeout(20_000),
      });

      expect(result.finalOutput).toBe('Current complete.');
      expect(result.lastAgent).toBe(agent);
      expect(result.input).toEqual(expectedInput);
      expect(result.input).not.toBe(input);
      expect(input).toEqual(expectedInput);
      expect(effects).toEqual(['fresh']);
      expect(model.calls).toHaveLength(2);
      expect(model.calls.map((call) => call.streamed)).toEqual([
        modelInvocation === 'stream',
        modelInvocation === 'stream',
      ]);
      expect(result.modelResponses).toHaveLength(2);
      expect(result.modelResponses[0]!.output).toEqual([currentCall]);
      expect(result.modelResponses[1]!.output).toEqual([finalMessage]);
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
        'message_output_item',
      ]);
      const generated = result.newItems.map((item) => item.rawItem);
      expect(generated[0]).toEqual(currentCall);
      expect(generated[1]).toMatchObject({
        type: 'function_call_result',
        callId: 'current-call',
        output: 'accepted:fresh',
      });
      expect(generated[2]).toEqual(finalMessage);
      expect(result.toInputList()).toEqual([...expectedInput, ...generated]);
      expect(result.history).toEqual(result.toInputList());
      model.assertComplete();
    },
    30_000,
  );

  it('rejects a newly emitted historical call ID before the current tool executes', async () => {
    const input = completedHistory();
    let effects = 0;
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.input).toEqual(input);
        return [
          functionCall('current_effect', {}, { callId: 'historical-call' }),
        ];
      }),
    ]);
    const agent = new Agent({
      name: 'Historical call identity collision',
      instructions: 'Continue without replaying prior calls.',
      model,
      modelSettings: {},
      tools: [
        tool({
          name: 'current_effect',
          description: 'An effect that must remain unexecuted.',
          parameters: z.object({}),
          execute() {
            effects++;
            return 'must not run';
          },
        }),
      ],
    });
    await expect(
      SDKRunner.run(agent, input, {
        context: undefined,
        signal: AbortSignal.timeout(20_000),
      }),
    ).rejects.toThrow(/cannot replay an existing function call/);
    expect(effects).toBe(0);
    expect(model.calls).toHaveLength(1);
    model.assertComplete();
  }, 30_000);

  it('selects stored history with a caller image and appends only the canonical delta', async () => {
    const retained = completedHistory();
    const imageUser: AgentInputItem = {
      type: 'message',
      id: 'caller-image-user',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Before the image.' },
        {
          type: 'input_image',
          image:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
          detail: 'auto',
        },
        { type: 'input_text', text: 'After the image.' },
      ],
      providerData: { id: 'caller-image-user', type: 'message' },
    };
    const supplied = [...structuredClone(retained), imageUser];
    const expectedInput = structuredClone(supplied);
    const writes: AgentInputItem[][] = [];
    class BoundMemorySession extends MemorySession {
      override async getItems(limit?: number): Promise<AgentInputItem[]> {
        expect(this).toBe(store);
        return super.getItems(limit);
      }
      override async addItems(items: AgentInputItem[]): Promise<void> {
        expect(this).toBe(store);
        writes.push(structuredClone(items));
        await super.addItems(items);
      }
    }
    const store = new BoundMemorySession({ initialItems: retained });
    let callbacks = 0;
    const finalMessage = assistantMessage('Image history accepted.', {
      id: 'image-history-answer',
    });
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(callbacks).toBe(1);
        expect(request.input).toEqual(expectedInput);
        expect(request.tools).toEqual([]);
        expect(writes).toEqual([]);
        return [finalMessage];
      }),
    ]);
    const result = await SDKRunner.run(
      new Agent({
        name: 'Caller image and stored conversation',
        instructions: 'Continue the supplied conversation.',
        model,
        modelSettings: {},
      }),
      supplied,
      {
        context: { tenant: 'image-history' },
        session: store,
        signal: AbortSignal.timeout(20_000),
        sessionInputCallback(history, fresh) {
          callbacks++;
          expect(history).toEqual(retained);
          expect(fresh).toEqual(expectedInput);
          const selectedUser = fresh.at(-1)!;
          expect(selectedUser).toEqual(imageUser);
          // Select Core's retained objects, not caller copies of the old turns.
          return [...history, selectedUser];
        },
      },
    );

    expect(callbacks).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(result.finalOutput).toBe('Image history accepted.');
    expect(result.input).toEqual(expectedInput);
    expect(result.newItems.map((item) => item.rawItem)).toEqual([finalMessage]);
    expect(writes).toEqual([[imageUser, finalMessage]]);
    expect(await store.getItems()).toEqual([
      ...retained,
      imageUser,
      finalMessage,
    ]);
    expect(result.toInputList()).toEqual([...expectedInput, finalMessage]);
    expect(result.history).toEqual(result.toInputList());
    expect(supplied).toEqual(expectedInput);
    model.assertComplete();

    const nextAnswer = assistantMessage('Retained image accepted.', {
      id: 'empty-delta-answer',
    });
    const nextModel = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.input).toEqual(result.toInputList());
        return [nextAnswer];
      }),
    ]);
    const next = await SDKRunner.run(
      new Agent({
        name: 'Stored conversation without a fresh delta',
        model: nextModel,
        modelSettings: {},
      }),
      [],
      {
        context: undefined,
        session: store,
        signal: AbortSignal.timeout(20_000),
        sessionInputCallback(history, fresh) {
          expect(fresh).toEqual([]);
          return history;
        },
      },
    );
    expect(next.finalOutput).toBe('Retained image accepted.');
    expect(writes).toEqual([[imageUser, finalMessage], [nextAnswer]]);
    expect(await store.getItems()).toEqual(next.toInputList());
    expect(next.toInputList()).toEqual([...result.toInputList(), nextAnswer]);
    nextModel.assertComplete();
  }, 30_000);

  it('holds only a new current call while continuing caller-supplied completed history', async () => {
    const input = completedHistory();
    const expectedInput = structuredClone(input);
    const context = { tenant: 'held-history' };
    const effects: string[] = [];
    const currentCall = functionCall(
      'current_effect',
      { value: 'approved' },
      {
        callId: 'approved-current-call',
        id: 'approved-current-item',
      },
    );
    const finalMessage = assistantMessage('Approved history complete.', {
      id: 'approved-history-answer',
    });
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.input).toEqual(expectedInput);
        expect(request.tools.map((entry) => entry.name)).toEqual([
          'current_effect',
        ]);
        expect(effects).toEqual([]);
        return [currentCall];
      }),
      modelResponder(({ request }) => {
        if (!Array.isArray(request.input))
          throw new Error('Expected SDK history items');
        expect(request.input.slice(0, expectedInput.length)).toEqual(
          expectedInput,
        );
        const generated = request.input.slice(expectedInput.length);
        expect(generated.map((item) => item.type)).toEqual([
          'function_call',
          'function_call_result',
        ]);
        expect(generated[0]).toMatchObject({
          type: 'function_call',
          name: 'current_effect',
          callId: 'approved-current-call',
          arguments: JSON.stringify({ value: 'approved' }),
        });
        expect(generated[1]).toMatchObject({
          type: 'function_call_result',
          name: 'current_effect',
          callId: 'approved-current-call',
          status: 'completed',
          output: 'accepted:approved',
        });
        expect(effects).toEqual(['approved']);
        return [finalMessage];
      }),
    ]);
    const agent = new Agent({
      name: 'Approved caller history consumer',
      instructions: 'Continue the supplied history using the current tool.',
      model,
      modelSettings: {},
      tools: [
        tool({
          name: 'current_effect',
          description: 'Record a new value only after approval.',
          parameters: z.object({ value: z.string() }),
          needsApproval: true,
          execute({ value }, received) {
            expect(received?.context).toBe(context);
            effects.push(value);
            return `accepted:${value}`;
          },
        }),
      ],
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Caller history approval deadline')),
      20_000,
    );
    let completion: Promise<unknown> | undefined;
    try {
      const paused = await SDKRunner.run(agent, input, {
        context,
        approvals: 'manual',
        signal: controller.signal,
      });
      if (!('status' in paused) || paused.status !== 'paused')
        throw new Error('Expected the new current function call to be held');
      completion = paused.completed;
      void completion.catch(() => {});
      expect(paused.lastAgent).toBe(agent);
      expect(paused.runContext.context).toBe(context);
      expect(paused.interruptions).toHaveLength(1);
      expect(paused.interruptions[0]!.rawItem).toEqual(currentCall);
      expect(effects).toEqual([]);
      expect(model.calls).toHaveLength(1);

      paused.approve(paused.interruptions[0]!);
      expect(effects).toEqual([]);
      expect(model.calls).toHaveLength(1);
      const result = await paused.continue();

      expect(result.finalOutput).toBe('Approved history complete.');
      expect(result.lastAgent).toBe(agent);
      expect(result.runContext).toBe(paused.runContext);
      expect(result.input).toEqual(expectedInput);
      expect(effects).toEqual(['approved']);
      expect(model.calls).toHaveLength(2);
      expect(result.interruptions).toEqual([]);
      const generated = result.newItems.map((item) => item.rawItem);
      expect(generated).toHaveLength(3);
      expect(generated[0]).toEqual(currentCall);
      expect(generated[1]).toMatchObject({
        type: 'function_call_result',
        name: 'current_effect',
        callId: 'approved-current-call',
        output: 'accepted:approved',
      });
      expect(generated[2]).toEqual(finalMessage);
      expect(result.toInputList()).toEqual([...expectedInput, ...generated]);
      expect(input).toEqual(expectedInput);
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Caller history approval cleanup'));
      await completion?.catch(() => {});
    }
  }, 30_000);

  it('preserves caller history across a failed Model attempt and retries without replaying effects', async () => {
    const input = completedHistory();
    const expectedInput = structuredClone(input);
    const effects: string[] = [];
    let retries = 0;
    const currentCall = functionCall(
      'current_effect',
      { value: 'retried' },
      {
        callId: 'retry-current-call',
        id: 'retry-current-item',
      },
    );
    const finalMessage = assistantMessage('Retried history complete.', {
      id: 'retry-history-answer',
    });
    const model = new ScriptedModel([
      modelError(new Error('First history Model attempt failed'), {
        replaySafety: 'safe',
      }),
      modelResponder(({ request }) => {
        expect(model.calls).toHaveLength(2);
        expect(model.calls[0]!.request.input).toEqual(expectedInput);
        expect(request.input).toEqual(expectedInput);
        expect(effects).toEqual([]);
        return [currentCall];
      }),
      modelResponder(({ request }) => {
        if (!Array.isArray(request.input))
          throw new Error('Expected SDK history items');
        expect(request.input.slice(0, expectedInput.length)).toEqual(
          expectedInput,
        );
        const generated = request.input.slice(expectedInput.length);
        expect(generated.map((item) => item.type)).toEqual([
          'function_call',
          'function_call_result',
        ]);
        expect(generated[0]).toMatchObject({
          type: 'function_call',
          callId: 'retry-current-call',
          name: 'current_effect',
          arguments: JSON.stringify({ value: 'retried' }),
        });
        expect(generated[1]).toMatchObject({
          type: 'function_call_result',
          callId: 'retry-current-call',
          name: 'current_effect',
          status: 'completed',
          output: 'accepted:retried',
        });
        expect(effects).toEqual(['retried']);
        return [finalMessage];
      }),
    ]);
    const agent = new Agent({
      name: 'Retried caller history consumer',
      instructions: 'Continue the supplied history using the current tool.',
      model,
      modelSettings: {},
      tools: [
        tool({
          name: 'current_effect',
          description: 'Record one new value after a successful Model attempt.',
          parameters: z.object({ value: z.string() }),
          execute({ value }) {
            effects.push(value);
            return `accepted:${value}`;
          },
        }),
      ],
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Caller history retry deadline')),
      20_000,
    );
    const running = SDKRunner.run(agent, input, {
      context: undefined,
      signal: controller.signal,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy: () => {
            retries++;
            return { retry: true, delayMs: 0 };
          },
        },
      },
    });
    try {
      const result = await running;
      expect(retries).toBe(1);
      expect(model.calls).toHaveLength(3);
      for (const call of model.calls) {
        expect(Array.isArray(call.request.input)).toBe(true);
        expect(call.request.input.slice(0, expectedInput.length)).toEqual(
          expectedInput,
        );
        expect(call.request.tools.map((entry) => entry.name)).toEqual([
          'current_effect',
        ]);
      }
      expect(effects).toEqual(['retried']);
      expect(result.finalOutput).toBe('Retried history complete.');
      expect(result.input).toEqual(expectedInput);
      expect(result.modelResponses.map((response) => response.output)).toEqual([
        [currentCall],
        [finalMessage],
      ]);
      const generated = result.newItems.map((item) => item.rawItem);
      expect(generated).toHaveLength(3);
      expect(generated[0]).toEqual(currentCall);
      expect(generated[1]).toMatchObject({
        type: 'function_call_result',
        callId: 'retry-current-call',
        output: 'accepted:retried',
      });
      expect(generated[2]).toEqual(finalMessage);
      expect(result.toInputList()).toEqual([...expectedInput, ...generated]);
      expect(result.history).toEqual(result.toInputList());
      expect(input).toEqual(expectedInput);
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Caller history retry cleanup'));
      await running.catch(() => {});
    }
  }, 30_000);
});
