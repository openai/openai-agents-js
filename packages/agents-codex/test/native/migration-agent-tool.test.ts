import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Runner,
  setTracingDisabled,
  tool,
  type CompletedAgentToolInvocationRunResult,
  type RunContext,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';
import { binding } from '../../src/runtime/binding';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

function forbidClassicRunner() {
  return vi.spyOn(Runner.prototype, 'run').mockImplementation(() => {
    throw new Error('Agent tools must use the native runner');
  });
}

describe('native Agent.asTool composition', () => {
  it('validates a structured parent output after extracting its original text child result', async () => {
    const classicRun = forbidClassicRunner();
    const native = await binding();
    const claims = vi.spyOn(native.Engine.prototype, '_sentinel_claim');
    const context = { account: 'structured-parent' };
    let parses = 0;
    const schema = z
      .object({ title: z.string(), count: z.number() })
      .superRefine(() => {
        parses++;
      });
    const value = { title: 'Extracted child: Seven.', count: 7 };
    let checkedOutput: z.infer<typeof schema> | undefined;
    const parentCheck = vi.fn(
      async ({ agentOutput }: { agentOutput: z.infer<typeof schema> }) => {
        expect(parses).toBe(1);
        expect(agentOutput).toEqual(value);
        checkedOutput = agentOutput;
        return {
          tripwireTriggered: false,
          outputInfo: 'checked parent object',
        };
      },
    );
    const childCheck = vi.fn(async () => ({
      tripwireTriggered: false,
      outputInfo: 'checked child text',
    }));
    const childModel = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.outputType).toBe('text');
        return [assistantMessage('Seven.')];
      }),
    ]);
    const child = new Agent<typeof context>({
      name: 'Original text child',
      instructions: 'Return the count as text.',
      model: childModel,
      outputGuardrails: [{ name: 'child text', execute: childCheck }],
    });
    const extract = vi.fn(
      (
        result: CompletedAgentToolInvocationRunResult<
          typeof context,
          typeof child
        >,
      ) => {
        expect(result.lastAgent).toBe(child);
        expect(result.runContext.context).toBe(context);
        expect(result.finalOutput).toBe('Seven.');
        expect(result.outputGuardrailResults[0]?.agentOutput).toBe('Seven.');
        expect(childCheck).toHaveBeenCalledOnce();
        expect(result.agentToolInvocation).toEqual({
          toolName: 'ask_count',
          toolCallId: 'structured-parent-child-call',
          toolArguments: '{"input":"Count?"}',
        });
        return `Extracted child: ${result.finalOutput}`;
      },
    );
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_count', '{"input":"Count?"}', {
          callId: 'structured-parent-child-call',
        }),
      ]),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'structured-parent-child-call',
            output: value.title,
          }),
        );
        expect(parentCheck).not.toHaveBeenCalled();
        return [assistantMessage(JSON.stringify(value))];
      }),
    ]);
    const parent = new Agent<typeof context, typeof schema>({
      name: 'Structured parent',
      instructions: 'Ask the child, then return the declared report.',
      model: parentModel,
      outputType: schema,
      tools: [
        child.asTool({ toolName: 'ask_count', customOutputExtractor: extract }),
      ],
      outputGuardrails: [{ name: 'parent object', execute: parentCheck }],
    });
    const result = await SDKRunner.run(parent, 'Report.', { context });
    expectTypeOf(result.finalOutput).toEqualTypeOf<z.infer<typeof schema>>();
    expect(result.finalOutput).toEqual(value);
    expect(result.finalOutput).toBe(checkedOutput);
    expect(result.outputGuardrailResults[0]?.agentOutput).toBe(
      result.finalOutput,
    );
    expect(result.lastAgent).toBe(parent);
    expect(
      result.newItems.every((item) => 'agent' in item && item.agent === parent),
    ).toBe(true);
    expect(parentModel.calls[0]!.request.outputType).toMatchObject({
      type: 'json_schema',
      name: 'output',
      strict: true,
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, count: { type: 'number' } },
        required: ['title', 'count'],
        additionalProperties: false,
      },
    });
    expect(parentModel.calls[1]!.request.outputType).toEqual(
      parentModel.calls[0]!.request.outputType,
    );
    expect(parses).toBe(1);
    expect(parentCheck).toHaveBeenCalledOnce();
    expect(childCheck).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledOnce();
    expect(claims).toHaveBeenCalledTimes(3);
    expect(classicRun).not.toHaveBeenCalled();
    parentModel.assertComplete();
    childModel.assertComplete();
  }, 30_000);

  it('admits both native scopes and preserves the source Agent, context, call and child declarations', async () => {
    const classicRun = forbidClassicRunner();
    const native = await binding();
    const claims = vi.spyOn(native.Engine.prototype, '_sentinel_claim');
    const context = { account: 'original' };
    const argumentsText = ' { "input" : "Child question." } ';
    let parentContext: RunContext<unknown> | undefined;
    let childResult: unknown;
    const outputCheck = vi.fn(async () => ({
      tripwireTriggered: false,
      outputInfo: 'checked child',
    }));
    const execute = vi.fn(
      (_args: Record<string, never>, received?: RunContext<typeof context>) => {
        expect(received).toBe(parentContext);
        expect(received?.context).toBe(context);
        return 'Child lookup.';
      },
    );
    const lookup = tool({
      name: 'child_lookup',
      description: 'Read the child value.',
      parameters: z.object({}),
      execute,
    });
    const childModel = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Original child instructions.'),
          }),
        );
        expect(call.request.tools).toEqual([
          {
            type: 'function',
            name: lookup.name,
            description: lookup.description,
            parameters: lookup.parameters,
            strict: true,
          },
        ]);
        expect(call.request.input).toContainEqual(
          expect.objectContaining({ role: 'user' }),
        );
        expect(JSON.stringify(call.request.input)).toContain('Child question.');
        return [
          functionCall('child_lookup', '{}', { callId: 'child-lookup-call' }),
        ];
      }),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'child-lookup-call',
            output: 'Child lookup.',
          }),
        );
        return [assistantMessage('Checked child answer.')];
      }),
    ]);
    const child = new Agent<typeof context>({
      name: 'Original child',
      instructions: 'Original child instructions.',
      model: childModel,
      tools: [lookup],
      inputGuardrails: [
        {
          name: 'child identity',
          runInParallel: false,
          execute: async ({ agent, context: received }) => {
            expect(agent).toBe(child);
            expect(received).toBe(parentContext);
            expect(received.context).toBe(context);
            return {
              tripwireTriggered: false,
              outputInfo: 'original child identity',
            };
          },
        },
      ],
      outputGuardrails: [{ name: 'child output', execute: outputCheck }],
    });
    const extract = vi.fn(
      (
        result: CompletedAgentToolInvocationRunResult<
          typeof context,
          typeof child
        >,
      ) => {
        childResult = result;
        expect(outputCheck).toHaveBeenCalledOnce();
        expect(result.lastAgent).toBe(child);
        expect(result.runContext).toBe(parentContext);
        expect(result.finalOutput).toBe('Checked child answer.');
        expect(result.outputGuardrailResults[0]).toMatchObject({
          agent: child,
          agentOutput: 'Checked child answer.',
          output: { tripwireTriggered: false, outputInfo: 'checked child' },
        });
        expect(result.agentToolInvocation).toEqual({
          toolName: 'ask_child',
          toolCallId: 'parent-child-call',
          toolArguments: argumentsText,
        });
        expect(result).not.toHaveProperty('state');
        return `Extracted: ${result.finalOutput}`;
      },
    );
    const childTool = child.asTool({
      toolName: 'ask_child',
      toolDescription: 'Ask the original child.',
      customOutputExtractor: extract,
    });
    const parentModel = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.tools).toEqual([
          expect.objectContaining({ name: 'ask_child' }),
        ]);
        return [
          functionCall('ask_child', argumentsText, {
            callId: 'parent-child-call',
          }),
        ];
      }),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'parent-child-call',
            output: 'Extracted: Checked child answer.',
          }),
        );
        return [assistantMessage('Parent continued.')];
      }),
    ]);
    const parent = new Agent<typeof context>({
      name: 'Parent',
      instructions: 'Ask the child and continue.',
      model: parentModel,
      tools: [childTool],
      inputGuardrails: [
        {
          name: 'parent identity',
          runInParallel: false,
          execute: async ({ agent, context: received }) => {
            expect(agent).toBe(parent);
            expect(received.context).toBe(context);
            parentContext = received;
            return {
              tripwireTriggered: false,
              outputInfo: 'original parent identity',
            };
          },
        },
      ],
    });
    const result = await SDKRunner.run(parent, 'Parent question.', { context });
    expect(result.finalOutput).toBe('Parent continued.');
    expect(result.lastAgent).toBe(parent);
    expect(result.runContext).toBe(parentContext);
    expect(
      result.newItems.every((item) => 'agent' in item && item.agent === parent),
    ).toBe(true);
    expect(childResult).toMatchObject({
      native: { sessionId: expect.any(String), turnId: expect.any(String) },
      newItems: [
        { type: 'tool_call_item', agent: child },
        { type: 'tool_call_output_item', agent: child },
        { type: 'message_output_item', agent: child },
      ],
    });
    expect(childResult).not.toMatchObject({
      native: { sessionId: result.native.sessionId },
    });
    expect(childResult).not.toMatchObject({
      native: { turnId: result.native.turnId },
    });
    expect(claims).toHaveBeenCalledTimes(4);
    expect(classicRun).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledOnce();
    parentModel.assertComplete();
    childModel.assertComplete();
  });

  it('returns default text extraction only after the actual child output check', async () => {
    const classicRun = forbidClassicRunner();
    const check = vi.fn(async () => ({
      tripwireTriggered: false,
      outputInfo: 'accepted',
    }));
    const childModel = new ScriptedModel([
      modelResponder(() => [assistantMessage('Default child answer.')]),
    ]);
    const child = new Agent({
      name: 'Default child',
      model: childModel,
      outputGuardrails: [{ name: 'child output', execute: check }],
    });
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'default-child-call',
        }),
      ]),
      modelResponder((call) => {
        expect(check).toHaveBeenCalledOnce();
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'default-child-call',
            output: 'Default child answer.',
          }),
        );
        return [assistantMessage('Default received.')];
      }),
    ]);
    const parent = new Agent({
      name: 'Parent',
      model: parentModel,
      tools: [child.asTool({ toolName: 'ask_child' })],
    });
    const result = await SDKRunner.run(parent, 'Ask.', { context: undefined });
    expect(result.finalOutput).toBe('Default received.');
    expect(classicRun).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledOnce();
    parentModel.assertComplete();
    childModel.assertComplete();
  });

  it('inherits runner settings without replacing the child settings with parent Agent settings', async () => {
    const classicRun = forbidClassicRunner();
    const childModel = new ScriptedModel([
      modelResponder(() => [assistantMessage('Child answer.')]),
    ]);
    const child = new Agent({
      name: 'Configured child',
      model: childModel,
      modelSettings: { temperature: 0.7 },
    });
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'settings-child-call',
        }),
      ]),
      modelResponder(() => [assistantMessage('Parent continued.')]),
    ]);
    const parent = new Agent({
      name: 'Configured parent',
      model: parentModel,
      modelSettings: { temperature: 0.1, topP: 0.2 },
      tools: [child.asTool({ toolName: 'ask_child' })],
    });
    const result = await SDKRunner.run(parent, 'Ask.', {
      context: undefined,
      modelSettings: { maxTokens: 1200 },
    });
    expect(result.finalOutput).toBe('Parent continued.');
    expect(parentModel.calls[0].request.modelSettings.temperature).toBe(0.1);
    expect(childModel.calls[0].request.modelSettings).toMatchObject({
      temperature: 0.7,
      maxTokens: 1200,
    });
    expect(childModel.calls[0].request.modelSettings).not.toHaveProperty(
      'topP',
    );
    expect(classicRun).not.toHaveBeenCalled();
    parentModel.assertComplete();
    childModel.assertComplete();
  });

  it('withholds rejected child output and the custom extractor through the ordinary tool failure policy', async () => {
    const classicRun = forbidClassicRunner();
    const extract = vi.fn(() => 'Must not extract rejected output.');
    const check = vi.fn(async () => ({
      tripwireTriggered: true,
      outputInfo: 'blocked',
    }));
    const childModel = new ScriptedModel([
      modelResponder(() => [assistantMessage('Unsafe child payload.')]),
    ]);
    const child = new Agent({
      name: 'Blocked child',
      model: childModel,
      outputGuardrails: [{ name: 'child output', execute: check }],
    });
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'blocked-child-call',
        }),
      ]),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'blocked-child-call',
            output: expect.stringContaining('error'),
          }),
        );
        expect(JSON.stringify(call.request.input)).not.toContain(
          'Unsafe child payload.',
        );
        return [assistantMessage('Parent handled the child failure.')];
      }),
    ]);
    const parent = new Agent({
      name: 'Parent',
      model: parentModel,
      tools: [
        child.asTool({ toolName: 'ask_child', customOutputExtractor: extract }),
      ],
    });
    const result = await SDKRunner.run(parent, 'Ask.', { context: undefined });
    expect(result.finalOutput).toBe('Parent handled the child failure.');
    expect(JSON.stringify(result.newItems)).not.toContain(
      'Unsafe child payload.',
    );
    expect(check).toHaveBeenCalledOnce();
    expect(extract).not.toHaveBeenCalled();
    expect(classicRun).not.toHaveBeenCalled();
    parentModel.assertComplete();
    childModel.assertComplete();
  });

  it('does not turn the parent Agent model into a runner default for an unconfigured child', async () => {
    const classicRun = forbidClassicRunner();
    const child = new Agent({ name: 'Unconfigured child' });
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'unconfigured-child-call',
        }),
      ]),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'unconfigured-child-call',
            output:
              'An error occurred while running the tool. Please try again.',
          }),
        );
        return [assistantMessage('Child requires explicit configuration.')];
      }),
    ]);
    const parent = new Agent({
      name: 'Configured parent',
      model: parentModel,
      tools: [child.asTool({ toolName: 'ask_child' })],
    });
    const result = await SDKRunner.run(parent, 'Ask.', { context: undefined });
    expect(result.finalOutput).toBe('Child requires explicit configuration.');
    expect(parentModel.calls).toHaveLength(2);
    expect(classicRun).not.toHaveBeenCalled();
    parentModel.assertComplete();
  });

  it('refuses unsupported child configuration before resolving or invoking the child Model', async () => {
    const classicRun = forbidClassicRunner();
    const childModel = new ScriptedModel([]);
    const getModel = vi.fn(async () => childModel);
    const child = new Agent({
      name: 'Unsupported child',
      model: 'child-model',
    });
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'unsupported-child-call',
        }),
      ]),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'unsupported-child-call',
            output:
              'An error occurred while running the tool. Please try again.',
          }),
        );
        return [assistantMessage('Unsupported child refused.')];
      }),
    ]);
    const parent = new Agent({
      name: 'Parent',
      model: parentModel,
      tools: [
        child.asTool({
          toolName: 'ask_child',
          runConfig: { modelProvider: { getModel }, tracingDisabled: true },
        }),
      ],
    });
    const result = await SDKRunner.run(parent, 'Ask.', { context: undefined });
    expect(result.finalOutput).toBe('Unsupported child refused.');
    expect(getModel).not.toHaveBeenCalled();
    expect(childModel.calls).toHaveLength(0);
    expect(classicRun).not.toHaveBeenCalled();
    parentModel.assertComplete();
  });
});
