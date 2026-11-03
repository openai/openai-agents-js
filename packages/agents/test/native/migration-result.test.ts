import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  RunHooks,
  Usage,
  tool,
  setTracingDisabled,
  OutputGuardrailTripwireTriggered,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  type RunContext,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';
import { NativeProvider } from '../../src/runtime/provider';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());
const allowed = { tripwireTriggered: false, outputInfo: 'checked' };
const parameters = z.object({});

describe('completed migration consumers on real native execution', () => {
  it.each(['response', 'stream'] as const)(
    'projects actual SDK records and checked values for %s',
    async (modelInvocation) => {
      const context = { account: 'original' };
      let observed: RunContext<typeof context> | undefined;
      const value = { answer: 7, text: '{"still":"text"}' };
      const inputVerdict = guardOutput.allow('input checked');
      const outputVerdict = guardOutput.allow('output checked');
      const model = new ScriptedModel([
        modelResponder(() => ({
          responseId: 'sdk-tools',
          output: [functionCall('lookup', '{}', { callId: 'sdk-call' })],
          usage: new Usage({
            requests: 1,
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
          }),
        })),
        modelResponder((call) => {
          expect(call.request.input).toContainEqual(
            expect.objectContaining({
              type: 'function_call_result',
              callId: 'sdk-call',
              output: JSON.stringify(value),
            }),
          );
          return {
            responseId: 'sdk-final',
            output: [assistantMessage('Done.', { id: 'sdk-message' })],
            usage: new Usage({
              requests: 1,
              inputTokens: 2,
              outputTokens: 1,
              totalTokens: 3,
            }),
          };
        }),
      ]);
      const agent = new Agent<typeof context>({
        name: 'Actual consumer',
        instructions: 'Use lookup and return text.',
        model,
        tools: [
          tool<typeof parameters, typeof context, typeof value>({
            name: 'lookup',
            description: 'Read.',
            parameters,
            execute: async (_args, received) => {
              observed = received;
              return value;
            },
            inputGuardrails: [
              { name: 'tool input', run: async () => inputVerdict },
            ],
            outputGuardrails: [
              { name: 'tool output', run: async () => outputVerdict },
            ],
          }),
        ],
      });
      const close = vi.spyOn(NativeProvider.prototype, 'close');
      const result = await SDKRunner.run(agent, 'Original input.', {
        context,
        modelInvocation,
        inputGuardrails: [
          { name: 'input', runInParallel: false, execute: async () => allowed },
        ],
        outputGuardrails: [{ name: 'output', execute: async () => allowed }],
      });
      expect(result.finalOutput).toBe('Done.');
      expect(result.input).toBe('Original input.');
      expect(result.lastAgent).toBe(agent);
      expect(result.runContext).toBe(observed);
      expect(result.runContext.context).toBe(context);
      expect(result.runContext.usage.totalTokens).toBe(6);
      expect(result.lastResponseId).toBe('sdk-final');
      expect(result.rawResponses).toHaveLength(2);
      result.rawResponses.forEach((response, i) =>
        expect(response).toBe(result.modelResponses[i]),
      );
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
        'message_output_item',
      ]);
      expect(
        result.newItems.every(
          (item) => item.type !== 'handoff_output_item' && item.agent === agent,
        ),
      ).toBe(true);
      expect(result.newItems[1]).toMatchObject({
        output: value,
        rawItem: { callId: 'sdk-call', output: JSON.stringify(value) },
      });
      expect(
        result.newItems[1]!.type === 'tool_call_output_item' &&
          result.newItems[1]!.output,
      ).not.toBe(value);
      expect(result.inputGuardrailResults).toHaveLength(1);
      expect(result.outputGuardrailResults).toHaveLength(1);
      expect(result.toolInputGuardrailResults[0]?.output).toEqual(inputVerdict);
      expect(result.toolOutputGuardrailResults[0]?.output).toEqual(
        outputVerdict,
      );
      expect(result.interruptions).toEqual([]);
      expect(result.native.sessionId).toBeTruthy();
      expect(result.native.turnId).toBeTruthy();
      expect(result).not.toHaveProperty('state');
      expect(close).toHaveBeenCalledTimes(1);
      const exported = result.toInputList();
      expect(exported).toEqual(result.history);
      expect(exported).toHaveLength(4);
      exported.length = 0;
      expect(result.history).toHaveLength(4);
      expect(
        (await Array.fromAsync(result)).map((event) =>
          event.type === 'run_item_stream_event' ? event.name : event.type,
        ),
      ).toEqual(['tool_called', 'tool_output', 'message_output_created']);
      const reader = result.toStream().getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      await expect(result.completed).resolves.toBeUndefined();
      expect(() => result.toTextStream()).toThrow(
        'buffered semantic events only',
      );
      model.assertComplete();
    },
  );

  it('publishes the checked replacement as a string, never the rejected callback object', async () => {
    const replacement = '{"safe":true}';
    const model = new ScriptedModel([
      modelResponder(() => [
        functionCall('lookup', '{}', { callId: 'replacement-call' }),
      ]),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'replacement-call',
            output: replacement,
          }),
        );
        return [assistantMessage('Done.')];
      }),
    ]);
    const agent = new Agent({
      name: 'Checked replacement',
      instructions: 'Use lookup.',
      model,
      tools: [
        tool({
          name: 'lookup',
          description: 'Read.',
          parameters,
          execute: async () => ({ secret: 'rejected original' }),
          outputGuardrails: [
            {
              name: 'replace',
              run: async () => guardOutput.rejectContent(replacement),
            },
          ],
        }),
      ],
    });
    const result = await SDKRunner.run(agent, 'Input.', { context: undefined });
    expect(result.newItems[1]).toMatchObject({
      output: replacement,
      rawItem: { output: replacement },
    });
    expect(JSON.stringify(result.newItems)).not.toContain('rejected original');
    expect(result.toolOutputGuardrailResults).toHaveLength(1);
    model.assertComplete();
  });

  it('withholds the result and accepted events until the final guard and cleanup finish', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model = new ScriptedModel([
      modelResponder(() => [assistantMessage('Done.')]),
    ]);
    const agent = new Agent({
      name: 'Guarded consumer',
      instructions: 'Return text.',
      model,
    });
    const hooks = new RunHooks<unknown, 'text'>();
    const ended = vi.fn();
    hooks.on('agent_end', ended);
    let published = false;
    const running = SDKRunner.run(agent, 'Input.', {
      context: undefined,
      hooks,
      outputGuardrails: [
        {
          name: 'delayed',
          execute: async () => {
            entered.resolve();
            await release.promise;
            return allowed;
          },
        },
      ],
    }).then((result) => {
      published = true;
      return result;
    });
    await entered.promise;
    expect(published).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    release.resolve();
    const result = await running;
    expect(ended).toHaveBeenCalledTimes(1);
    expect(result.finalOutput).toBe('Done.');
    expect(await Array.fromAsync(result)).toHaveLength(1);
  });

  it('rejects guard-blocked final output instead of returning a facade', async () => {
    const model = new ScriptedModel([
      modelResponder(() => [assistantMessage('Blocked.')]),
    ]);
    const agent = new Agent({
      name: 'Rejected consumer',
      instructions: 'Return text.',
      model,
    });
    const hooks = new RunHooks<unknown, 'text'>();
    const ended = vi.fn();
    hooks.on('agent_end', ended);
    await expect(
      SDKRunner.run(agent, 'Input.', {
        context: undefined,
        hooks,
        outputGuardrails: [
          {
            name: 'reject',
            execute: async () => ({
              tripwireTriggered: true,
              outputInfo: 'rejected',
            }),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
    expect(ended).not.toHaveBeenCalled();
  });
});
