import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  setTracingDisabled,
  tool,
  type RunContext,
} from '@openai/agents-core';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelResponse,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';

setTracingDisabled(true);

type Context = { account: string };
const allowed = { tripwireTriggered: false, outputInfo: 'checked' };

function completedHistory(text = 'Read the old value.'): AgentInputItem[] {
  return [
    {
      type: 'message',
      id: 'history-user',
      role: 'user',
      content: [{ type: 'input_text', text }],
      providerData: { id: 'history-user', type: 'message' },
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

describe('caller history composed with native instruction controls', () => {
  it('bounds the combined history and resolved instructions before Model dispatch', async () => {
    const limit = 4 * 1024 * 1024;
    const input = completedHistory('h'.repeat(limit / 2));
    const instructionText = 'i'.repeat(limit / 2);
    // Each component fits; only their combined final request exceeds the bound.
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(limit);
    expect(Buffer.byteLength(JSON.stringify(instructionText))).toBeLessThan(
      limit,
    );
    const context: Context = { account: 'original' };
    const model = new ScriptedModel([
      modelResponse([assistantMessage('This Model must not be dispatched.')]),
    ]);
    const execute = vi.fn(() => 'Must not execute.');
    const guard = vi.fn(async () => allowed);
    const end = vi.fn();
    const instructions = vi.fn(
      async (received: RunContext<Context>, owner: Agent<Context>) => {
        expect(owner).toBe(agent);
        expect(received.context).toBe(context);
        return instructionText;
      },
    );
    const agent = new Agent<Context>({
      name: 'Combined request bound',
      model,
      modelSettings: {},
      instructions,
      tools: [
        tool({
          name: 'current_effect',
          description: 'Current effect.',
          parameters: z.object({}),
          execute,
        }),
      ],
      outputGuardrails: [{ name: 'not before dispatch', execute: guard }],
    });
    agent.on('agent_end', end);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Combined request bound deadline')),
      20_000,
    );
    const running = SDKRunner.run(agent, input, {
      context,
      signal: controller.signal,
      modelInvocation: 'response',
    });
    try {
      await expect(running).rejects.toBeInstanceOf(TypeError);
      await expect(running).rejects.toThrow(
        'Migration Model payload exceeds 4 MiB',
      );
      expect(instructions).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      expect(guard).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Combined request bound cleanup'));
      await running.catch(() => {});
    }
  }, 30_000);

  it('preserves completed history and finishes from the checked current tool without another Model request', async () => {
    const input = completedHistory();
    const expectedInput = structuredClone(input);
    const context: Context = { account: 'original' };
    const checked = 'Checked current output.';
    const currentCall = functionCall('current_effect', '{}', {
      callId: 'current-call',
      id: 'current-call-item',
    });
    const instructions = vi.fn(
      (received: RunContext<Context>, owner: Agent<Context>) => {
        expect(owner).toBe(agent);
        expect(received.context).toBe(context);
        return `Continue for ${received.context.account}.`;
      },
    );
    const execute = vi.fn(
      (_args: Record<string, never>, received?: RunContext<Context>) => {
        expect(received).toBe(instructions.mock.calls[0][0]);
        return 'Private unchecked output.';
      },
    );
    const action = tool({
      name: 'current_effect',
      description: 'Perform one current effect.',
      parameters: z.object({}),
      execute,
      outputGuardrails: [
        {
          name: 'replace private output',
          async run({ agent: owner, context: received, output }) {
            expect(owner).toBe(agent);
            expect(received).toBe(instructions.mock.calls[0][0]);
            expect(output).toBe('Private unchecked output.');
            return guardOutput.rejectContent(checked, 'sanitized');
          },
        },
      ],
    });
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.input).toEqual(expectedInput);
        expect(request.systemInstructions).toBe('Continue for original.');
        expect(request.tools.map((entry) => entry.name)).toEqual([action.name]);
        expect(execute).not.toHaveBeenCalled();
        return [currentCall];
      }),
    ]);
    const guard = vi.fn(async (_args: { agentOutput: string }) => allowed);
    const end = vi.fn();
    const agent = new Agent<Context>({
      name: 'History and checked tool finish',
      model,
      modelSettings: {},
      instructions,
      tools: [action],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [{ name: 'checked final candidate', execute: guard }],
    });
    agent.on('agent_end', end);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('History instruction finish deadline')),
      20_000,
    );
    const running = SDKRunner.run(agent, input, {
      context,
      signal: controller.signal,
      modelInvocation: 'response',
    });
    try {
      const result = await running;
      expect(instructions).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        agent,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(result.modelResponses).toHaveLength(1);
      expect(result.modelResponses[0].output).toEqual([currentCall]);
      expect(result.finalOutput).toBe(checked);
      expect(result.lastAgent).toBe(agent);
      expect(result.runContext.context).toBe(context);
      expect(result.input).toEqual(expectedInput);
      expect(input).toEqual(expectedInput);
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
      ]);
      expect(result.newItems[0].rawItem).toEqual(currentCall);
      expect(result.newItems[1]).toMatchObject({
        agent,
        output: checked,
        rawItem: {
          type: 'function_call_result',
          callId: 'current-call',
          name: action.name,
          status: 'completed',
          output: checked,
        },
      });
      expect(result.toInputList()).toEqual([
        ...expectedInput,
        ...result.newItems.map((item) => item.rawItem),
      ]);
      expect(result.history).toEqual(result.toInputList());
      expect(result.native.outcome).toEqual({
        type: 'turn_aborted',
        reason: 'interrupted',
      });
      expect(guard).toHaveBeenCalledTimes(1);
      expect(guard.mock.calls[0][0].agentOutput).toBe(checked);
      expect(end).toHaveBeenCalledExactlyOnceWith(result.runContext, checked);
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('History instruction finish cleanup'));
      await running.catch(() => {});
    }
  }, 30_000);
});
