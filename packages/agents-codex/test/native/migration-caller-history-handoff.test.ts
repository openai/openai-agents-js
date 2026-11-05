import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  handoff,
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type HandoffInputData,
  type OutputGuardrailFunctionArgs,
  type RunContext,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';

setTracingDisabled(true);

function completedPrefix(): AgentInputItem[] {
  return [
    {
      type: 'message',
      id: 'retained-user',
      role: 'user',
      content: [{ type: 'input_text', text: 'Read the old order.' }],
      providerData: { id: 'retained-user', type: 'message' },
    },
    functionCall('retired_effect', ' { "value": "old" } ', {
      callId: 'retained-call',
      id: 'retained-call-item',
      providerData: { id: 'retained-call-item', type: 'function_call' },
    }),
    {
      type: 'function_call_result',
      id: 'retained-result-item',
      callId: 'retained-call',
      name: 'retired_effect',
      status: 'completed',
      output: 'old accepted order',
      providerData: {
        id: 'retained-result-item',
        type: 'function_call_result',
      },
    },
  ];
}

describe('caller history composed with native active Agent handoff', () => {
  it.each(['image/text last user', 'history-only ending pair'] as const)(
    'retains logical history and accepted transfer with %s',
    async (route) => {
      type Context = { account: string };
      const context: Context = { account: 'test-account' };
      const input = completedPrefix();
      if (route === 'image/text last user') {
        input.push({
          type: 'message',
          id: 'image-user',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Before the order image.' },
            {
              type: 'input_image',
              image:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
              detail: 'auto',
            },
            {
              type: 'input_text',
              text: 'After the image: transfer this order.',
            },
          ],
          providerData: { id: 'image-user', type: 'message' },
        });
      }
      const expected = structuredClone(input);
      const transfer = functionCall('transfer_to_Target', '{}', {
        callId: 'current-transfer',
        id: 'current-transfer-item',
      });
      const final = assistantMessage('Target checked the retained order.', {
        id: 'target-final-message',
      });
      let originalContext: RunContext<Context> | undefined;
      let targetInput: AgentInputItem[] | undefined;
      const oldEffect = vi.fn(() => 'must not replay');
      const model = new ScriptedModel([
        modelResponder(({ request }) => {
          expect(request.systemInstructions).toBe('Root instructions.');
          expect(request.input).toEqual(expected);
          expect(request.handoffs.map((entry) => entry.toolName)).toEqual([
            'transfer_to_Target',
          ]);
          expect(oldEffect).not.toHaveBeenCalled();
          return [transfer];
        }),
        modelResponder(({ request }) => {
          expect(request.systemInstructions).toBe('Target instructions.');
          expect(request.tools).toEqual([]);
          expect(request.handoffs).toEqual([]);
          expect(Array.isArray(request.input)).toBe(true);
          if (!Array.isArray(request.input))
            throw new Error('Expected logical history');
          expect(request.input.slice(0, expected.length)).toEqual(expected);
          expect(request.input).toHaveLength(expected.length + 2);
          expect(request.input[expected.length]).toEqual(transfer);
          expect(request.input[expected.length + 1]).toMatchObject({
            type: 'function_call_result',
            callId: 'current-transfer',
            name: 'transfer_to_Target',
            status: 'completed',
            output: {
              type: 'text',
              text: JSON.stringify({ assistant: 'Target' }),
            },
          });
          targetInput = structuredClone(request.input);
          return [final];
        }),
      ]);
      const source = new Agent<Context>({
        name: 'Root',
        instructions: 'Root instructions.',
        model,
        tools: [
          tool({
            name: 'retired_effect',
            description: 'A historical effect that must not replay.',
            parameters: z.object({ value: z.string() }),
            execute: oldEffect,
          }),
        ],
      });
      const targetGuard = vi.fn(
        async ({
          agent,
          context: received,
          agentOutput,
        }: OutputGuardrailFunctionArgs<Context>) => {
          expect(agent).toBe(target);
          expect(received).toBe(originalContext);
          expect(received.context).toBe(context);
          expect(agentOutput).toBe('Target checked the retained order.');
          return { tripwireTriggered: false, outputInfo: 'checked Target' };
        },
      );
      const target: Agent<Context> = new Agent<Context>({
        name: 'Target',
        instructions: 'Target instructions.',
        model,
        outputGuardrails: [{ name: 'Target completion', execute: targetGuard }],
      });
      source.on('agent_start', (received, agent) => {
        expect(agent).toBe(source);
        expect(received.context).toBe(context);
        originalContext = received;
      });
      const targetEnd = vi.fn(
        (received: RunContext<Context>, output: string) => {
          expect(received).toBe(originalContext);
          expect(output).toBe('Target checked the retained order.');
        },
      );
      target.on('agent_end', targetEnd);
      const onHandoff = vi.fn((received: RunContext<Context>) => {
        expect(received).toBe(originalContext);
        expect(received.context).toBe(context);
      });
      const filter = vi.fn((data: HandoffInputData) => {
        expect(data.runContext).toBe(originalContext);
        expect(data.inputHistory).toEqual(expected);
        expect(data.preHandoffItems).toEqual([]);
        expect(data.newItems.map((item) => item.type)).toEqual([
          'handoff_call_item',
          'handoff_output_item',
        ]);
        return { ...data, inputHistory: structuredClone(expected) };
      });
      source.handoffs = [handoff(target, { onHandoff, inputFilter: filter })];
      const result = await SDKRunner.run(source, input, {
        context,
        signal: AbortSignal.timeout(20_000),
      });

      expect(model.calls).toHaveLength(2);
      expect(model.calls.every((call) => !call.streamed)).toBe(true);
      model.assertComplete();
      expect(oldEffect).not.toHaveBeenCalled();
      expect(onHandoff).toHaveBeenCalledOnce();
      expect(filter).toHaveBeenCalledOnce();
      expect(targetGuard).toHaveBeenCalledOnce();
      expect(targetEnd).toHaveBeenCalledOnce();
      expect(result.lastAgent).toBe(target);
      expect(result.runContext).toBe(originalContext);
      expect(result.finalOutput).toBe('Target checked the retained order.');
      expect(result.input).toEqual(expected);
      expect(input).toEqual(expected);
      expect(result.newItems).toHaveLength(3);
      const [requested, accepted, message] = result.newItems;
      expect(requested).toBeInstanceOf(RunHandoffCallItem);
      expect(accepted).toBeInstanceOf(RunHandoffOutputItem);
      expect(message).toBeInstanceOf(RunMessageOutputItem);
      if (
        !(requested instanceof RunHandoffCallItem) ||
        !(accepted instanceof RunHandoffOutputItem) ||
        !(message instanceof RunMessageOutputItem)
      )
        throw new Error('Expected genuine transfer and Target message items');
      expect(requested.agent).toBe(source);
      expect(requested.rawItem).toEqual(transfer);
      expect(accepted.sourceAgent).toBe(source);
      expect(accepted.targetAgent).toBe(target);
      expect(accepted.rawItem).toEqual(targetInput?.at(-1));
      expect(message.agent).toBe(target);
      expect(message.rawItem).toEqual(final);
      const generated = result.newItems.map((item) => item.rawItem);
      expect(result.output).toEqual(generated);
      expect(result.history).toEqual([...expected, ...generated]);
      expect(result.toInputList()).toEqual(result.history);
      expect(result.rawResponses.map((response) => response.output)).toEqual([
        [transfer],
        [final],
      ]);
      expect(result.native.sessionId.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it('bounds the final filtered Target request before calling its Model', async () => {
    const input = completedPrefix();
    const targetResponse = vi.fn(() => [
      assistantMessage('Must not dispatch.'),
    ]);
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.input).toEqual(input);
        return [
          functionCall('transfer_to_Target', '{}', {
            callId: 'expanding-transfer',
          }),
        ];
      }),
      modelResponder(targetResponse),
    ]);
    const source = new Agent({
      name: 'Root',
      instructions: 'Transfer.',
      model,
    });
    const target = new Agent({
      name: 'Target',
      instructions: 'Continue.',
      model,
    });
    const onHandoff = vi.fn();
    const filter = vi.fn((data: HandoffInputData) => ({
      ...data,
      inputHistory: [
        ...input,
        {
          type: 'message' as const,
          role: 'user' as const,
          content: 'x'.repeat(4 * 1024 * 1024),
        },
      ],
    }));
    source.handoffs = [handoff(target, { onHandoff, inputFilter: filter })];
    await expect(
      SDKRunner.run(source, input, {
        context: undefined,
        signal: AbortSignal.timeout(20_000),
      }),
    ).rejects.toThrow('Migration Model payload exceeds 4 MiB');
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(filter).toHaveBeenCalledOnce();
    expect(model.calls).toHaveLength(1);
    expect(targetResponse).not.toHaveBeenCalled();
  }, 30_000);
});
