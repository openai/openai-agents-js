import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  RunHooks,
  ToolCallError,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  setTracingDisabled,
  tool,
  type RunContext,
  type OutputGuardrailMetadata,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelResponse,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

type Context = { account: string };
const allowed = { tripwireTriggered: false, outputInfo: { checked: true } };
const freshContext = (): Context => ({ account: 'original' });
const parameters = z.object({});
const toolCall = () =>
  functionCall('lookup', '{}', { callId: 'original-call' });
const finished = () => modelResponse([assistantMessage('Done.')]);

function expectFinalItems(output: unknown, toolOutput: string) {
  expect(output).toEqual([
    expect.objectContaining({
      type: 'function_call',
      callId: 'original-call',
      name: 'lookup',
      arguments: '{}',
    }),
    expect.objectContaining({
      type: 'function_call_result',
      callId: 'original-call',
      name: 'lookup',
      status: 'completed',
      output: { type: 'text', text: toolOutput },
    }),
    expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Done.' }],
    }),
  ]);
}

function agentFor(model: ScriptedModel) {
  return new Agent<Context>({
    name: 'Guarded migration',
    instructions: 'Use lookup when requested and return text.',
    model,
    modelSettings: {},
  });
}

describe('migration guardrails on the native turn loop', () => {
  it.each(['response', 'stream'] as const)(
    'preserves original callback values, guard results and lifecycle order for %s invocation',
    async (modelInvocation) => {
      const context = freshContext();
      const events: string[] = [];
      const hooks = new RunHooks<Context, 'text'>();
      let observedContext: RunContext<Context> | undefined;
      const observe = (received: RunContext<Context>) => {
        expect(received.context).toBe(context);
        observedContext ??= received;
        expect(received).toBe(observedContext);
      };
      const inputVerdict = guardOutput.allow({ checked: 'tool input' });
      const outputVerdict = guardOutput.allow({ checked: 'tool output' });
      const originalOutput = { status: 'available' };
      const model = new ScriptedModel([
        modelResponder(() => {
          events.push('model tool');
          return [toolCall()];
        }),
        modelResponder((call) => {
          events.push('model final');
          expect(call.request.input).toContainEqual(
            expect.objectContaining({
              type: 'function_call_result',
              callId: 'original-call',
              output: JSON.stringify(originalOutput),
            }),
          );
          return [assistantMessage('Done.')];
        }),
      ]);
      const agent = agentFor(model);
      agent.inputGuardrails = [
        {
          name: 'agent input',
          runInParallel: false,
          async execute(args) {
            expect(args.agent).toBe(agent);
            expect(args.context.context).toBe(context);
            expect(args.input).toBe('Look up the order.');
            events.push('agent input');
            return allowed;
          },
        },
      ];
      agent.outputGuardrails = [
        {
          name: 'agent output',
          async execute(args) {
            expect(args.agent).toBe(agent);
            observe(args.context);
            expect(args.agentOutput).toBe('Done.');
            expectFinalItems(
              args.details?.output,
              JSON.stringify(originalOutput),
            );
            events.push('agent output');
            return allowed;
          },
        },
      ];
      const lookup = tool<typeof parameters, Context, typeof originalOutput>({
        name: 'lookup',
        description: 'Read a fictional order.',
        parameters,
        inputGuardrails: [
          {
            name: 'tool input',
            async run(args) {
              expect(args.agent).toBe(agent);
              observe(args.context);
              expect(args.toolCall).toMatchObject({
                name: 'lookup',
                callId: 'original-call',
                arguments: '{}',
              });
              events.push('tool input');
              return inputVerdict;
            },
          },
        ],
        outputGuardrails: [
          {
            name: 'tool output',
            async run(args) {
              expect(args.agent).toBe(agent);
              observe(args.context);
              expect(args.output).toBe(originalOutput);
              events.push('tool output');
              return outputVerdict;
            },
          },
        ],
        async execute(_args, received) {
          observe(received!);
          events.push('invoke');
          return originalOutput;
        },
      });
      agent.tools = [lookup];
      agent.on('agent_start', (received, original, input) => {
        observe(received);
        expect(original).toBe(agent);
        expect(input).toContainEqual(expect.objectContaining({ role: 'user' }));
        events.push('agent start');
      });
      hooks.on('agent_start', (received, original) => {
        observe(received);
        expect(original).toBe(agent);
        events.push('runner start');
      });
      hooks.on('agent_tool_start', (received, original, action, details) => {
        observe(received);
        expect(original).toBe(agent);
        expect(action).toBe(lookup);
        expect(details.toolCall.type).toBe('function_call');
        if (details.toolCall.type !== 'function_call')
          throw new Error('Expected the original function call.');
        expect(details.toolCall.callId).toBe('original-call');
        events.push('runner tool start');
      });
      agent.on('agent_tool_start', (received, action) => {
        observe(received);
        expect(action).toBe(lookup);
        events.push('agent tool start');
      });
      hooks.on('agent_tool_end', (received, original, action, output) => {
        observe(received);
        expect(original).toBe(agent);
        expect(action).toBe(lookup);
        expect(output).toBe(JSON.stringify(originalOutput));
        events.push('runner tool end');
      });
      agent.on('agent_tool_end', (received, action, output) => {
        observe(received);
        expect(action).toBe(lookup);
        expect(output).toBe(JSON.stringify(originalOutput));
        events.push('agent tool end');
      });
      hooks.on('agent_end', (received, original, output) => {
        observe(received);
        expect(original).toBe(agent);
        expect(output).toBe('Done.');
        events.push('runner end');
      });
      agent.on('agent_end', (received, output) => {
        observe(received);
        expect(output).toBe('Done.');
        events.push('agent end');
      });
      const result = await SDKRunner.run(agent, 'Look up the order.', {
        context,
        hooks,
        modelInvocation,
        inputGuardrails: [
          {
            name: 'runner input',
            runInParallel: false,
            async execute(args) {
              expect(args.agent).toBe(agent);
              expect(args.context.context).toBe(context);
              events.push('runner input');
              return allowed;
            },
          },
        ],
        outputGuardrails: [
          {
            name: 'runner output',
            async execute(args) {
              expect(args.agent).toBe(agent);
              observe(args.context);
              expect(args.agentOutput).toBe('Done.');
              expectFinalItems(
                args.details?.output,
                JSON.stringify(originalOutput),
              );
              events.push('runner output');
              return allowed;
            },
          },
        ],
      });
      expect(result.finalOutput).toBe('Done.');
      expect(result.native.sessionId).toEqual(expect.any(String));
      expect(result.native.turnId).toEqual(expect.any(String));
      expect(model.calls.map((call) => call.streamed)).toEqual([
        modelInvocation === 'stream',
        modelInvocation === 'stream',
      ]);
      expect(
        result.inputGuardrailResults.map((item) => item.guardrail.name),
      ).toEqual(['runner input', 'agent input']);
      expect(
        result.inputGuardrailResults.every((item) => item.output === allowed),
      ).toBe(true);
      expect(
        result.outputGuardrailResults.map((item) => item.guardrail.name),
      ).toEqual(['runner output', 'agent output']);
      for (const item of result.outputGuardrailResults) {
        expect(item.agent).toBe(agent);
        expect(item.agentOutput).toBe('Done.');
        expect(item.output).toBe(allowed);
      }
      expect(result.toolInputGuardrailResults).toEqual([
        {
          guardrail: { type: 'tool_input', name: 'tool input' },
          output: inputVerdict,
        },
      ]);
      expect(result.toolInputGuardrailResults[0]?.output).toEqual(inputVerdict);
      expect(result.toolInputGuardrailResults[0]?.output.outputInfo).toBe(
        inputVerdict.outputInfo,
      );
      expect(result.toolInputGuardrailResults[0]?.output.behavior).toBe(
        inputVerdict.behavior,
      );
      expect(result.toolOutputGuardrailResults).toEqual([
        {
          guardrail: { type: 'tool_output', name: 'tool output' },
          output: outputVerdict,
        },
      ]);
      expect(result.toolOutputGuardrailResults[0]?.output).toEqual(
        outputVerdict,
      );
      expect(result.toolOutputGuardrailResults[0]?.output.outputInfo).toBe(
        outputVerdict.outputInfo,
      );
      expect(result.toolOutputGuardrailResults[0]?.output.behavior).toBe(
        outputVerdict.behavior,
      );
      expect(events).toEqual([
        'runner input',
        'agent input',
        'agent start',
        'runner start',
        'model tool',
        'tool input',
        'runner tool start',
        'agent tool start',
        'invoke',
        'tool output',
        'runner tool end',
        'agent tool end',
        'model final',
        'runner output',
        'agent output',
        'runner end',
        'agent end',
      ]);
    },
  );

  it('holds blocking input checks before model resolution and start events', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const verdict = {
      tripwireTriggered: true,
      outputInfo: { reason: 'blocked' },
    };
    const model = new ScriptedModel([]);
    const getModel = vi.fn(async () => model);
    const agent = agentFor(model);
    const start = vi.fn();
    const end = vi.fn();
    agent.on('agent_start', start);
    agent.on('agent_end', end);
    agent.model = 'not resolved before approval';
    agent.inputGuardrails = [
      {
        name: 'blocking',
        runInParallel: false,
        async execute() {
          entered.resolve();
          await release.promise;
          return verdict;
        },
      },
    ];
    const outcome = SDKRunner.run(agent, 'Hello.', {
      context: freshContext(),
      modelProvider: { getModel },
    }).catch((error: unknown) => error);
    try {
      await entered.promise;
      expect(getModel).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(0);
      expect(start).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    const failure = await outcome;
    expect(failure).toBeInstanceOf(InputGuardrailTripwireTriggered);
    expect((failure as InputGuardrailTripwireTriggered).result.output).toBe(
      verdict,
    );
    expect(getModel).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it.each(['response', 'stream'] as const)(
    'overlaps a parallel input guard with the first %s model call and joins its revoked callback without admitting the tool',
    async (modelInvocation) => {
      const modelEntered = Promise.withResolvers<void>();
      const guardEntered = Promise.withResolvers<void>();
      const releaseModel = Promise.withResolvers<void>();
      const trip = Promise.withResolvers<void>();
      let modelSettled = false;
      let settled = false;
      let modelSignal: AbortSignal | undefined;
      const execute = vi.fn(async () => 'must not execute');
      const model = new ScriptedModel([
        modelResponder(async (call) => {
          modelSignal = call.request.signal;
          modelEntered.resolve();
          try {
            await releaseModel.promise;
            return [toolCall()];
          } finally {
            modelSettled = true;
          }
        }),
      ]);
      const agent = agentFor(model);
      agent.tools = [
        tool({ name: 'lookup', description: 'Read.', parameters, execute }),
      ];
      agent.inputGuardrails = [
        {
          name: 'parallel tripwire',
          async execute() {
            guardEntered.resolve();
            await trip.promise;
            return { tripwireTriggered: true, outputInfo: 'revoked' };
          },
        },
      ];
      const toolStart = vi.fn();
      const agentEnd = vi.fn();
      agent.on('agent_tool_start', toolStart);
      agent.on('agent_end', agentEnd);
      const outcome = SDKRunner.run(agent, 'Look up the order.', {
        context: freshContext(),
        modelInvocation,
      }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await Promise.all([modelEntered.promise, guardEntered.promise]);
        expect(settled).toBe(false);
        trip.resolve();
        await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true));
        expect(modelSettled).toBe(false);
        expect(settled).toBe(false);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        trip.resolve();
        releaseModel.resolve();
      }
      expect(await outcome).toBeInstanceOf(InputGuardrailTripwireTriggered);
      expect(modelSettled).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(toolStart).not.toHaveBeenCalled();
      expect(agentEnd).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each(['response', 'stream'] as const)(
    'withholds final %s output and success events when an output guard trips',
    async (modelInvocation) => {
      const verdict = {
        tripwireTriggered: true,
        outputInfo: { reason: 'private' },
      };
      const context = freshContext();
      const model = new ScriptedModel([finished()]);
      const agent = agentFor(model);
      const hooks = new RunHooks<Context, 'text'>();
      const runnerEnd = vi.fn();
      const agentEnd = vi.fn();
      hooks.on('agent_end', runnerEnd);
      agent.on('agent_end', agentEnd);
      agent.outputGuardrails = [
        {
          name: 'withhold',
          async execute(args) {
            expect(args.agent).toBe(agent);
            expect(args.context.context).toBe(context);
            expect(args.agentOutput).toBe('Done.');
            return verdict;
          },
        },
      ];
      const failure = await SDKRunner.run(agent, 'Hello.', {
        context,
        hooks,
        modelInvocation,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OutputGuardrailTripwireTriggered);
      const result = (
        failure as OutputGuardrailTripwireTriggered<OutputGuardrailMetadata>
      ).result;
      expect(result.agent).toBe(agent);
      expect(result.agentOutput).toBe('Done.');
      expect(result.output).toBe(verdict);
      expect(runnerEnd).not.toHaveBeenCalled();
      expect(agentEnd).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each([
    ['input', 'response'],
    ['input', 'stream'],
    ['output', 'response'],
    ['output', 'stream'],
  ] as const)(
    'continues with the %s tool rejection for %s invocation instead of the original tool result',
    async (boundary, modelInvocation) => {
      const context = freshContext();
      const originalOutput = { secret: 'original result' };
      const verdict = guardOutput.rejectContent(`${boundary} rejected`, {
        reason: 'policy',
      });
      const execute = vi.fn(async () => originalOutput);
      const outputGuard = vi.fn(async (args: { output: unknown }) => {
        expect(args.output).toBe(originalOutput);
        return boundary === 'output' ? verdict : guardOutput.allow();
      });
      const model = new ScriptedModel([
        modelResponse([toolCall()]),
        modelResponder((call) => {
          expect(call.request.input).toContainEqual(
            expect.objectContaining({
              type: 'function_call_result',
              callId: 'original-call',
              output: `${boundary} rejected`,
            }),
          );
          expect(JSON.stringify(call.request.input)).not.toContain(
            'original result',
          );
          return [assistantMessage('Done.')];
        }),
      ]);
      const agent = agentFor(model);
      const lookup = tool<typeof parameters, Context, typeof originalOutput>({
        name: 'lookup',
        description: 'Read.',
        parameters,
        execute,
        inputGuardrails:
          boundary === 'input'
            ? [
                {
                  name: 'reject input',
                  async run(args) {
                    expect(args.agent).toBe(agent);
                    expect(args.context.context).toBe(context);
                    return verdict;
                  },
                },
              ]
            : [],
        outputGuardrails: [{ name: 'check original output', run: outputGuard }],
      });
      agent.tools = [lookup];
      const toolEnd = vi.fn();
      agent.on('agent_tool_end', toolEnd);
      const inspectFinal = vi.fn(
        async (args: { details?: { output?: unknown } }) => {
          expectFinalItems(args.details?.output, `${boundary} rejected`);
          expect(JSON.stringify(args.details?.output)).not.toContain(
            'original result',
          );
          return allowed;
        },
      );
      const result = await SDKRunner.run(agent, 'Look up the order.', {
        context,
        modelInvocation,
        outputGuardrails: [
          { name: 'inspect replacement', execute: inspectFinal },
        ],
      });
      expect(inspectFinal).toHaveBeenCalledTimes(1);
      expect(result.finalOutput).toBe('Done.');
      expect(execute).toHaveBeenCalledTimes(boundary === 'input' ? 0 : 1);
      expect(outputGuard).toHaveBeenCalledTimes(boundary === 'input' ? 0 : 1);
      expect(toolEnd).toHaveBeenCalledTimes(1);
      expect(toolEnd.mock.calls[0]?.[2]).toBe(`${boundary} rejected`);
      const results =
        boundary === 'input'
          ? result.toolInputGuardrailResults
          : result.toolOutputGuardrailResults;
      expect(results[0]?.output).toEqual(verdict);
      expect(results[0]?.output.outputInfo).toBe(verdict.outputInfo);
      expect(results[0]?.output.behavior).toBe(verdict.behavior);
      expect(result.toolOutputGuardrailResults).toHaveLength(
        boundary === 'input' ? 0 : 1,
      );
    },
  );

  it.each(['input', 'output'] as const)(
    'preserves typed %s tool tripwires under ToolCallError.error and attempts error-end once',
    async (boundary) => {
      const verdict = guardOutput.throwException({ reason: 'tripwire' });
      const execute = vi.fn(async () => 'original result');
      const model = new ScriptedModel([modelResponse([toolCall()])]);
      const agent = agentFor(model);
      const hooks = new RunHooks<Context, 'text'>();
      const lookup = tool({
        name: 'lookup',
        description: 'Read.',
        parameters,
        execute,
        inputGuardrails:
          boundary === 'input'
            ? [{ name: 'input tripwire', run: async () => verdict }]
            : [],
        outputGuardrails:
          boundary === 'output'
            ? [{ name: 'output tripwire', run: async () => verdict }]
            : [],
      });
      agent.tools = [lookup];
      const events: string[] = [];
      hooks.on('agent_tool_start', () => events.push('runner start'));
      agent.on('agent_tool_start', () => events.push('agent start'));
      const end = vi.fn((_context, original, action, output) => {
        expect(original).toBe(agent);
        expect(action).toBe(lookup);
        expect(output).toContain('Guardrail');
        events.push('runner end');
      });
      hooks.on('agent_tool_end', end);
      agent.on('agent_tool_end', () => events.push('agent end'));
      const success = vi.fn();
      agent.on('agent_end', success);
      const failure = await SDKRunner.run(agent, 'Look up the order.', {
        context: freshContext(),
        hooks,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolCallError);
      const cause = (failure as ToolCallError).error;
      expect(cause).toBeInstanceOf(
        boundary === 'input'
          ? ToolInputGuardrailTripwireTriggered
          : ToolOutputGuardrailTripwireTriggered,
      );
      const guardResult = (cause as ToolInputGuardrailTripwireTriggered).result;
      expect(guardResult.output).toEqual(verdict);
      expect(guardResult.output.outputInfo).toBe(verdict.outputInfo);
      expect(guardResult.output.behavior).toBe(verdict.behavior);
      expect(execute).toHaveBeenCalledTimes(boundary === 'input' ? 0 : 1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(events).toEqual(
        boundary === 'input'
          ? ['runner end', 'agent end']
          : ['runner start', 'agent start', 'runner end', 'agent end'],
      );
      expect(success).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each(['response', 'stream'] as const)(
    'withholds %s success when a final policy finds a sensitive tool result',
    async (modelInvocation) => {
      const sensitive = 'private-order-token';
      const originalOutput = { token: sensitive };
      const model = new ScriptedModel([
        modelResponse([toolCall()]),
        finished(),
      ]);
      const agent = agentFor(model);
      agent.tools = [
        tool({
          name: 'lookup',
          description: 'Read a fictional order.',
          parameters,
          execute: async () => originalOutput,
        }),
      ];
      let checked = false;
      agent.outputGuardrails = [
        {
          name: 'sensitive tool result',
          async execute(args) {
            checked = true;
            // The final assistant text is harmless; only the tool result triggers this policy.
            expect(args.agentOutput).toBe('Done.');
            expect(args.agentOutput).not.toContain(sensitive);
            const sensitiveResult = args.details?.output?.find(
              (item) =>
                item.type === 'function_call_result' &&
                JSON.stringify(item.output).includes(sensitive),
            );
            return {
              tripwireTriggered: sensitiveResult !== undefined,
              outputInfo: { sensitiveResult },
            };
          },
        },
      ];
      const hooks = new RunHooks<Context, 'text'>();
      const runnerEnd = vi.fn();
      const agentEnd = vi.fn();
      hooks.on('agent_end', runnerEnd);
      agent.on('agent_end', agentEnd);
      const failure = await SDKRunner.run(agent, 'Look up the order.', {
        context: freshContext(),
        modelInvocation,
        hooks,
      }).catch((error: unknown) => error);
      expect(checked).toBe(true);
      expect(failure).toBeInstanceOf(OutputGuardrailTripwireTriggered);
      const result = (
        failure as OutputGuardrailTripwireTriggered<OutputGuardrailMetadata>
      ).result;
      expect(result.agentOutput).toBe('Done.');
      expect(result.output.tripwireTriggered).toBe(true);
      expect(result.output.outputInfo.sensitiveResult).toMatchObject({
        type: 'function_call_result',
        callId: 'original-call',
        name: 'lookup',
        status: 'completed',
        output: { type: 'text', text: JSON.stringify(originalOutput) },
      });
      expect(runnerEnd).not.toHaveBeenCalled();
      expect(agentEnd).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(2);
    },
  );

  it('does not redispatch a throwing tool-end listener or publish a successful continuation', async () => {
    const listenerFailure = new Error('tool end listener failed');
    const model = new ScriptedModel([modelResponse([toolCall()])]);
    const agent = agentFor(model);
    const execute = vi.fn(async () => 'original result');
    agent.tools = [
      tool({ name: 'lookup', description: 'Read.', parameters, execute }),
    ];
    const hooks = new RunHooks<Context, 'text'>();
    const throwing = vi.fn(() => {
      throw listenerFailure;
    });
    const skippedRunner = vi.fn();
    const skippedAgent = vi.fn();
    hooks.on('agent_tool_end', throwing);
    hooks.on('agent_tool_end', skippedRunner);
    agent.on('agent_tool_end', skippedAgent);
    const failure = await SDKRunner.run(agent, 'Look up the order.', {
      context: freshContext(),
      hooks,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolCallError);
    expect((failure as ToolCallError).error).toBe(listenerFailure);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(skippedRunner).not.toHaveBeenCalled();
    expect(skippedAgent).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('does not redispatch a throwing agent-end listener or resume skipped Agent listeners', async () => {
    const listenerFailure = new Error('agent end listener failed');
    const model = new ScriptedModel([finished()]);
    const agent = agentFor(model);
    const hooks = new RunHooks<Context, 'text'>();
    const throwing = vi.fn(() => {
      throw listenerFailure;
    });
    const skipped = vi.fn();
    hooks.on('agent_end', throwing);
    agent.on('agent_end', skipped);
    await expect(
      SDKRunner.run(agent, 'Hello.', {
        context: freshContext(),
        hooks,
      }),
    ).rejects.toBe(listenerFailure);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });
});
