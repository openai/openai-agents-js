import { Agent, RunContext, tool, type RunConfig } from '@openai/agents-core';
import { inspectFunctionToolForMigration } from '@openai/agents-core/utils/internal';
import { describe, expect, it } from 'vitest';
import { prepareAgentToolRun } from '../../src/migration/agent-tool';

const call = {
  type: 'function_call' as const,
  name: 'child_tool',
  callId: 'parent-call',
  arguments: '{"input":"question"}',
};

describe('native agent-tool declaration admission', () => {
  it('rejects a registered replacement on a genuine Agent tool', () => {
    const source = new Agent({ name: 'Child', instructions: 'Answer.' });
    const child = source.asTool({
      toolName: 'child',
      toolDescription: 'Ask child',
    });
    const replacement = tool({
      name: 'replacement',
      description: 'Not an Agent invocation',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: () => 'ordinary function',
    });
    Object.assign(child, replacement);
    expect(() =>
      inspectFunctionToolForMigration(child, { allowAgentTools: true }),
    ).toThrow('ordinary registered');
  });

  it('requires explicit admission and the factory-owned source identity', () => {
    const source = new Agent({ name: 'Child', instructions: 'Answer.' });
    const child = source.asTool({
      toolName: 'child',
      toolDescription: 'Ask child',
    });
    expect(() => inspectFunctionToolForMigration(child)).toThrow(
      'ordinary registered',
    );
    expect(
      inspectFunctionToolForMigration(child, { allowAgentTools: true })
        .sourceAgent,
    ).toBe(source);
    expect(() =>
      inspectFunctionToolForMigration({ ...child }, { allowAgentTools: true }),
    ).toThrow('ordinary registered');
    child.invoke = async () => 'unregistered replacement';
    expect(() =>
      inspectFunctionToolForMigration(child, { allowAgentTools: true }),
    ).toThrow('ordinary registered');
  });

  it('preserves static approval and enabled policies with named options', () => {
    const declared = tool({
      name: 'approved',
      description: 'Approved operation',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      needsApproval: true,
      isEnabled: false,
      execute: () => 'done',
    });
    expect(() =>
      inspectFunctionToolForMigration(declared, { allowAgentTools: true }),
    ).toThrow('approval-free');
    expect(
      inspectFunctionToolForMigration(declared, {
        allowApproval: true,
        allowAgentTools: true,
      }),
    ).toMatchObject({ enabled: false, approval: true });
  });
});

function fixture() {
  const source = new Agent({ name: 'Child', instructions: 'Answer.' });
  const context = { account: 'original' };
  const runContext = new RunContext(context);
  return { source, context, runContext };
}

describe('native agent-tool input mapping', () => {
  it('retains the exact Agent and resolved context with real call metadata', () => {
    const { source, context, runContext } = fixture();
    const prepared = prepareAgentToolRun(source, call, {}, source, 'question', {
      context: runContext,
    });
    expect(prepared.agent).toBe(source);
    expect(prepared.input).toBe('question');
    expect(prepared.options).toEqual({ context });
    expect(prepared.options.context).toBe(context);
    expect(prepared.execution.runContext).toBe(runContext);
    expect(prepared.execution.agentToolInvocation).toEqual({
      toolName: call.name,
      toolCallId: call.callId,
      toolArguments: call.arguments,
    });
    expect(Object.isFrozen(prepared.execution.agentToolInvocation)).toBe(true);
  });

  it('copies call metadata before caller mutation', () => {
    const { source, runContext } = fixture();
    const mutableCall = { ...call };
    const prepared = prepareAgentToolRun(source, mutableCall, {}, source, '', {
      context: runContext,
    });
    mutableCall.callId = 'different-call';
    expect(prepared.execution.agentToolInvocation.toolCallId).toBe(
      'parent-call',
    );
  });

  it('maps supported config and preserves guard arrays, provider and signal', () => {
    const { source, runContext } = fixture();
    const signal = new AbortController().signal;
    const inputGuardrails: NonNullable<RunConfig['inputGuardrails']> = [];
    const outputGuardrails: NonNullable<RunConfig['outputGuardrails']> = [];
    const modelSettings = { temperature: 0.3, toolChoice: 'auto' as const };
    const modelProvider = {
      getModel() {
        throw new Error('Mapping must not resolve a Model');
      },
    };
    const config = {
      model: 'child-model',
      modelProvider,
      modelSettings,
      inputGuardrails,
      outputGuardrails,
    };
    const input = [{ role: 'user' as const, content: 'question' }];
    const prepared = prepareAgentToolRun(source, call, config, source, input, {
      context: runContext,
      signal,
      stream: false,
    });
    expect(prepared.input).toBe(input);
    expect(prepared.options).toEqual({
      context: runContext.context,
      signal,
      ...config,
    });
    expect(prepared.options.signal).toBe(signal);
    expect(prepared.options.modelProvider).toBe(modelProvider);
    expect(prepared.options.inputGuardrails).toBe(inputGuardrails);
    expect(prepared.options.outputGuardrails).toBe(outputGuardrails);
    expect(prepared.options.modelSettings).toBe(modelSettings);
  });

  it('omits undefined supported fields and the non-stream flag', () => {
    const { source, runContext } = fixture();
    const prepared = prepareAgentToolRun(
      source,
      call,
      { model: undefined, modelSettings: undefined },
      source,
      '',
      { context: runContext, signal: undefined, stream: undefined },
    );
    expect(Object.keys(prepared.options)).toEqual(['context']);
  });

  it('rejects an Agent replacement even when its declaration matches', () => {
    const { source, runContext } = fixture();
    expect(() =>
      prepareAgentToolRun(source, call, {}, new Agent({ name: 'Child' }), '', {
        context: runContext,
      }),
    ).toThrow('registered source Agent');
  });

  it.each([undefined, null, {}, { context: {} }, { context: { context: {} } }])(
    'rejects unresolved context/options: %j',
    (options) => {
      const { source } = fixture();
      expect(() =>
        prepareAgentToolRun(source, call, {}, source, '', options),
      ).toThrow();
    },
  );

  it.each([
    { stream: true },
    { stream: null },
    { signal: {} },
    { maxTurns: null },
    { session: undefined },
    { previousResponseId: 'previous' },
    { errorHandlers: {} },
  ])('rejects unsupported run options: %j', (extra) => {
    const { source, runContext } = fixture();
    expect(() =>
      prepareAgentToolRun(source, call, {}, source, '', {
        context: runContext,
        ...extra,
      }),
    ).toThrow();
  });

  it.each([
    { tracingDisabled: true },
    { modelOverride: 'classic-only-model' },
    { toolExecution: undefined },
    { handoffInputFilter: undefined },
    { toolNotFoundBehavior: 'return_error_to_model' as const },
  ])('rejects unsupported configuration keys: %j', (config) => {
    const { source, runContext } = fixture();
    expect(() =>
      prepareAgentToolRun(source, call, config, source, '', {
        context: runContext,
      }),
    ).toThrow('run configuration');
  });

  it('preserves supported tool choice for native child capture', () => {
    const { source, runContext } = fixture();
    const prepared = prepareAgentToolRun(
      source,
      call,
      { modelSettings: { toolChoice: 'none' } },
      source,
      '',
      { context: runContext },
    );
    expect(prepared.options.modelSettings).toEqual({ toolChoice: 'none' });
    expect(prepared.execution.runContext).toBe(runContext);
  });

  it('rejects unsupported model settings before the native execution seam', () => {
    const { source, runContext } = fixture();
    expect(() =>
      prepareAgentToolRun(
        source,
        call,
        { modelSettings: { parallelToolCalls: false } },
        source,
        '',
        { context: runContext },
      ),
    ).toThrow('model setting parallelToolCalls');
  });

  it.each([undefined, {}, 1])('refuses non-input values: %j', (input) => {
    const { source, runContext } = fixture();
    expect(() =>
      prepareAgentToolRun(source, call, {}, source, input, {
        context: runContext,
      }),
    ).toThrow('fresh text or SDK user input');
  });
});
