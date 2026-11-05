import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  RunContext,
  RunHooks,
  Runner,
  ToolCallError,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  tool,
  type FunctionCallItem,
  type ToolInputGuardrailDefinition,
  type ToolOutputGuardrailDefinition,
} from '@openai/agents-core';
import {
  checkFinalOutput,
  emitAgentEnd,
  emitAgentStart,
  invokeGuardedTool,
  runInputChecks,
} from '../../src/migration/boundaries';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const allowed = { tripwireTriggered: false, outputInfo: undefined };

describe('migration guardrail boundaries', () => {
  it('runs blocking guards before parallel guards with original callback values', async () => {
    const wait = gate();
    const events: string[] = [];
    const trusted = { account: 'original' };
    const context = new RunContext(trusted);
    const agent = new Agent<typeof trusted>({
      name: 'guarded',
      inputGuardrails: [
        {
          name: 'blocking',
          runInParallel: false,
          async execute(args) {
            expect(args.agent).toBe(agent);
            expect(args.context).toBe(context);
            expect(args.context.context).toBe(trusted);
            expect(args.input).toBe('hello');
            events.push('blocking');
            await wait.promise;
            return allowed;
          },
        },
        {
          name: 'parallel',
          async execute() {
            events.push('parallel');
            return allowed;
          },
        },
      ],
    });
    const checks = runInputChecks({
      agent,
      context,
      input: 'hello',
      onFailure: vi.fn(),
    });
    const parallel = checks.startParallel();
    expect(checks.startParallel()).toBe(parallel);
    expect(events).toEqual(['blocking']);
    wait.release();
    expect((await checks.blocking)[0]?.output).toBe(allowed);
    await parallel;
    expect(events).toEqual(['blocking', 'parallel']);
  });

  it('reports a tripwire promptly and joins its already-started sibling', async () => {
    const wait = gate();
    const observed = gate();
    const output = { tripwireTriggered: true, outputInfo: { reason: 'stop' } };
    let finished = false;
    const parallelGuard = vi.fn(async () => allowed);
    const agent = new Agent({
      name: 'guarded',
      inputGuardrails: [
        { name: 'reject', runInParallel: false, execute: async () => output },
        {
          name: 'sibling',
          runInParallel: false,
          async execute() {
            await wait.promise;
            finished = true;
            return allowed;
          },
        },
        { name: 'never starts', execute: parallelGuard },
      ],
    });
    const onFailure = vi.fn<(error: Error) => void>(() => observed.release());
    const checks = runInputChecks({
      agent,
      context: new RunContext(),
      input: 'hello',
      onFailure,
    });
    let settled = false;
    const outcome = checks.startParallel().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await observed.promise;
    expect(onFailure.mock.calls[0]?.[0]).toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
    expect(settled).toBe(false);
    expect(finished).toBe(false);
    wait.release();
    const error = await outcome;
    expect(error).toBeInstanceOf(InputGuardrailTripwireTriggered);
    expect((error as InputGuardrailTripwireTriggered).result.output).toBe(
      output,
    );
    expect(finished).toBe(true);
    expect(parallelGuard).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('preserves execution failures and joins guard siblings', async () => {
    const wait = gate();
    const observed = gate();
    const cause = new Error('guard failed');
    const agent = new Agent({ name: 'guarded' });
    const checks = runInputChecks({
      agent,
      context: new RunContext(),
      input: 'hello',
      runnerGuardrails: [
        {
          name: 'failure',
          async execute() {
            throw cause;
          },
        },
        {
          name: 'sibling',
          async execute() {
            await wait.promise;
            return allowed;
          },
        },
      ],
      onFailure: () => observed.release(),
    });
    const outcome = checks.startParallel().catch((error: unknown) => error);
    await observed.promise;
    wait.release();
    const error = await outcome;
    expect(error).toBeInstanceOf(GuardrailExecutionError);
    expect((error as GuardrailExecutionError).error).toBe(cause);
  });

  it('returns original output guard results in runner then agent order', async () => {
    const context = new RunContext({ account: 'original' });
    const agent = new Agent<{ account: string }>({
      name: 'guarded',
      outputGuardrails: [{ name: 'agent', execute: async () => allowed }],
    });
    const results = await checkFinalOutput({
      agent,
      context,
      output: 'done',
      runnerGuardrails: [
        {
          name: 'runner',
          async execute(args) {
            expect(args.agent).toBe(agent);
            expect(args.context).toBe(context);
            expect(args.agentOutput).toBe('done');
            return allowed;
          },
        },
      ],
      onFailure: vi.fn(),
    });
    expect(results.map((result) => result.guardrail.name)).toEqual([
      'runner',
      'agent',
    ]);
    expect(results[0]?.output).toBe(allowed);
    expect(results[0]?.agent).toBe(agent);
    expect(results[0]?.agentOutput).toBe('done');
  });

  it('rejects final output with the standard diagnostic result', async () => {
    const rejected = {
      tripwireTriggered: true,
      outputInfo: { reason: 'private' },
    };
    const agent = new Agent({
      name: 'guarded',
      outputGuardrails: [{ name: 'reject', execute: async () => rejected }],
    });
    const onFailure = vi.fn();
    const error = await checkFinalOutput({
      agent,
      context: new RunContext(),
      output: 'withheld',
      onFailure,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
    expect((error as OutputGuardrailTripwireTriggered<any>).result.output).toBe(
      rejected,
    );
    expect(
      (error as OutputGuardrailTripwireTriggered<any>).result.agentOutput,
    ).toBe('withheld');
    expect(onFailure).toHaveBeenCalledWith(error);
  });
});

type ToolContext = { account: string };

function guardedTool({
  inputGuardrails = [],
  outputGuardrails = [],
  execute = async () => ({ value: 'done' }),
}: {
  inputGuardrails?: ToolInputGuardrailDefinition<ToolContext>[];
  outputGuardrails?: ToolOutputGuardrailDefinition<ToolContext>[];
  execute?: () => Promise<unknown>;
} = {}) {
  const parameters = z.object({});
  const action = tool<typeof parameters, ToolContext, unknown>({
    name: 'lookup',
    description: 'Look up the current value.',
    parameters,
    execute,
    inputGuardrails,
    outputGuardrails,
  });
  const agent = new Agent<ToolContext>({ name: 'guarded', tools: [action] });
  const context = new RunContext({ account: 'original' });
  const hooks = new RunHooks<ToolContext>();
  const controller = new AbortController();
  const toolCall: FunctionCallItem = {
    type: 'function_call',
    callId: 'original-call',
    name: action.name,
    arguments: '{}',
  };
  const invoke = vi.fn(() =>
    action.invoke(context, toolCall.arguments, { toolCall }),
  );
  const onInputResult = vi.fn();
  const onOutputResult = vi.fn();
  const run = () =>
    invokeGuardedTool({
      agent,
      context,
      tool: action,
      toolCall,
      invoke,
      check: () => {},
      signal: controller.signal,
      hooks,
      onInputResult,
      onOutputResult,
    });
  return {
    agent,
    context,
    hooks,
    controller,
    toolCall,
    action,
    invoke,
    onInputResult,
    onOutputResult,
    run,
  };
}

describe('migration function-tool boundaries', () => {
  it('preserves callback values, guard results, and tool event order', async () => {
    const events: string[] = [];
    const value = { value: 'original result' };
    const inputVerdict = guardOutput.allow({ checked: 'input' });
    const outputVerdict = guardOutput.allow({ checked: 'output' });
    const fixture = guardedTool({
      inputGuardrails: [
        {
          type: 'tool_input',
          name: 'input',
          async run(data) {
            expect(data.agent).toBe(fixture.agent);
            expect(data.context).toBe(fixture.context);
            expect(data.toolCall).toBe(fixture.toolCall);
            events.push('input');
            return inputVerdict;
          },
        },
      ],
      outputGuardrails: [
        {
          type: 'tool_output',
          name: 'output',
          async run(data) {
            expect(data.agent).toBe(fixture.agent);
            expect(data.context).toBe(fixture.context);
            expect(data.toolCall).toBe(fixture.toolCall);
            expect(data.output).toBe(value);
            events.push('output');
            return outputVerdict;
          },
        },
      ],
      async execute() {
        events.push('invoke');
        return value;
      },
    });
    fixture.hooks.on('agent_tool_start', (context, agent, action, details) => {
      expect([context, agent, action, details.toolCall]).toEqual([
        fixture.context,
        fixture.agent,
        fixture.action,
        fixture.toolCall,
      ]);
      events.push('runner start');
    });
    fixture.agent.on('agent_tool_start', () => events.push('agent start'));
    fixture.hooks.on(
      'agent_tool_end',
      (context, agent, action, output, details) => {
        expect([context, agent, action, details.toolCall]).toEqual([
          fixture.context,
          fixture.agent,
          fixture.action,
          fixture.toolCall,
        ]);
        expect(output).toBe(JSON.stringify(value));
        events.push('runner end');
      },
    );
    fixture.agent.on('agent_tool_end', (context, action, output, details) => {
      expect(context).toBe(fixture.context);
      expect(action).toBe(fixture.action);
      expect(details.toolCall).toBe(fixture.toolCall);
      expect(output).toBe(JSON.stringify(value));
      events.push('agent end');
    });
    expect(await fixture.run()).toBe(value);
    expect(events).toEqual([
      'input',
      'runner start',
      'agent start',
      'invoke',
      'output',
      'runner end',
      'agent end',
    ]);
    expect(fixture.onInputResult).toHaveBeenCalledExactlyOnceWith({
      guardrail: { type: 'tool_input', name: 'input' },
      output: inputVerdict,
    });
    expect(fixture.onOutputResult).toHaveBeenCalledExactlyOnceWith({
      guardrail: { type: 'tool_output', name: 'output' },
      output: outputVerdict,
    });
  });

  it('returns input rejection directly and skips the tool and output guards', async () => {
    const outputGuard = vi.fn(async () => guardOutput.allow());
    const fixture = guardedTool({
      inputGuardrails: [
        {
          type: 'tool_input',
          name: 'reject',
          run: async () => guardOutput.rejectContent('input rejected'),
        },
      ],
      outputGuardrails: [
        { type: 'tool_output', name: 'never', run: outputGuard },
      ],
    });
    const start = vi.fn();
    const end = vi.fn();
    fixture.hooks.on('agent_tool_start', start);
    fixture.hooks.on('agent_tool_end', end);
    expect(await fixture.run()).toBe('input rejected');
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(outputGuard).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledExactlyOnceWith(
      fixture.context,
      fixture.agent,
      fixture.action,
      'input rejected',
      { toolCall: fixture.toolCall },
    );
  });

  it('replaces rejected output before publishing the successful end event', async () => {
    const fixture = guardedTool({
      outputGuardrails: [
        {
          type: 'tool_output',
          name: 'replace',
          run: async () => guardOutput.rejectContent('output rejected'),
        },
      ],
    });
    const end = vi.fn();
    fixture.agent.on('agent_tool_end', end);
    expect(await fixture.run()).toBe('output rejected');
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledExactlyOnceWith(
      fixture.context,
      fixture.action,
      'output rejected',
      { toolCall: fixture.toolCall },
    );
  });

  it.each(['input', 'output'] as const)(
    'preserves the typed %s tripwire and error-end event',
    async (boundary) => {
      const fixture = guardedTool({
        inputGuardrails:
          boundary === 'input'
            ? [
                {
                  type: 'tool_input',
                  name: 'stop input',
                  run: async () => guardOutput.throwException(),
                },
              ]
            : [],
        outputGuardrails:
          boundary === 'output'
            ? [
                {
                  type: 'tool_output',
                  name: 'stop output',
                  run: async () => guardOutput.throwException(),
                },
              ]
            : [],
      });
      const start = vi.fn();
      const end = vi.fn();
      fixture.hooks.on('agent_tool_start', start);
      fixture.hooks.on('agent_tool_end', end);
      const failure = await fixture.run().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolCallError);
      const original = (failure as ToolCallError).error;
      expect(original).toBeInstanceOf(
        boundary === 'input'
          ? ToolInputGuardrailTripwireTriggered
          : ToolOutputGuardrailTripwireTriggered,
      );
      expect(start).toHaveBeenCalledTimes(boundary === 'input' ? 0 : 1);
      expect(fixture.invoke).toHaveBeenCalledTimes(
        boundary === 'input' ? 0 : 1,
      );
      expect(end).toHaveBeenCalledExactlyOnceWith(
        fixture.context,
        fixture.agent,
        fixture.action,
        String(original),
        { toolCall: fixture.toolCall },
      );
    },
  );

  it.each(['start', 'end'] as const)(
    'does not retry a failing %s listener',
    async (phase) => {
      const fixture = guardedTool();
      const failure = new Error(`failed ${phase}`);
      const listener = vi.fn(() => {
        throw failure;
      });
      const agentStart = vi.fn();
      const agentEnd = vi.fn();
      const runnerEnd = vi.fn();
      fixture.hooks.on(`agent_tool_${phase}`, listener);
      fixture.hooks.on('agent_tool_end', runnerEnd);
      fixture.agent.on('agent_tool_start', agentStart);
      fixture.agent.on('agent_tool_end', agentEnd);
      await expect(fixture.run()).rejects.toMatchObject({ error: failure });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(fixture.invoke).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
      expect(agentStart).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
      expect(agentEnd).toHaveBeenCalledTimes(phase === 'start' ? 1 : 0);
      expect(runnerEnd).toHaveBeenCalledTimes(phase === 'start' ? 1 : 0);
    },
  );

  it('joins an invoked tool after cancellation and withholds output checks and success', async () => {
    const entered = gate();
    const release = gate();
    const outputGuard = vi.fn(async () => guardOutput.allow());
    const fixture = guardedTool({
      async execute() {
        entered.release();
        await release.promise;
        return 'late output';
      },
      outputGuardrails: [
        { type: 'tool_output', name: 'never', run: outputGuard },
      ],
    });
    const end = vi.fn();
    fixture.agent.on('agent_tool_end', end);
    let settled = false;
    const outcome = fixture.run().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await entered.promise;
    const reason = new Error('cancelled');
    fixture.controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(end).not.toHaveBeenCalled();
    release.release();
    expect(await outcome).toBe(reason);
    expect(outputGuard).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledExactlyOnceWith(
      fixture.context,
      fixture.action,
      'aborted',
      { toolCall: fixture.toolCall },
    );
  });

  it('joins a cancelled input guard without admitting another guard or tool', async () => {
    const entered = gate();
    const release = gate();
    const never = vi.fn(async () => guardOutput.allow());
    const fixture = guardedTool({
      inputGuardrails: [
        {
          type: 'tool_input',
          name: 'waiting',
          async run() {
            entered.release();
            await release.promise;
            return guardOutput.allow();
          },
        },
        { type: 'tool_input', name: 'never', run: never },
      ],
    });
    const end = vi.fn();
    fixture.agent.on('agent_tool_end', end);
    const outcome = fixture.run().catch((error: unknown) => error);
    await entered.promise;
    const reason = new Error('cancelled');
    fixture.controller.abort(reason);
    release.release();
    expect(await outcome).toBe(reason);
    expect(never).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});

describe('migration lifecycle boundaries', () => {
  it('uses original values and the existing start/end event order', () => {
    const context = new RunContext({ account: 'original' });
    const agent = new Agent<{ account: string }>({ name: 'guarded' });
    const hooks = new RunHooks<{ account: string }>();
    const input = [
      { type: 'message' as const, role: 'user' as const, content: 'hello' },
    ];
    const events: string[] = [];
    agent.on('agent_start', (receivedContext, receivedAgent, receivedInput) => {
      expect(receivedContext).toBe(context);
      expect(receivedAgent).toBe(agent);
      expect(receivedInput).toBe(input);
      events.push('agent start');
    });
    hooks.on('agent_start', (receivedContext, receivedAgent, receivedInput) => {
      expect(receivedContext).toBe(context);
      expect(receivedAgent).toBe(agent);
      expect(receivedInput).toBe(input);
      events.push('runner start');
    });
    hooks.on('agent_end', (receivedContext, receivedAgent, output) => {
      expect(receivedContext).toBe(context);
      expect(receivedAgent).toBe(agent);
      expect(output).toBe('done');
      events.push('runner end');
    });
    agent.on('agent_end', (receivedContext, output) => {
      expect(receivedContext).toBe(context);
      expect(output).toBe('done');
      events.push('agent end');
    });
    emitAgentStart({ agent, context, input, hooks });
    emitAgentEnd({ agent, context, output: 'done', hooks });
    expect(events).toEqual([
      'agent start',
      'runner start',
      'runner end',
      'agent end',
    ]);
  });

  it('accepts a Runner as the existing event emitter', () => {
    const runner = new Runner();
    const listener = vi.fn();
    const startListener = vi.fn();
    runner.on('agent_start', startListener);
    runner.on('agent_end', listener);
    const agent = new Agent({ name: 'guarded' });
    const context = new RunContext();
    const input = [
      { type: 'message' as const, role: 'user' as const, content: 'hello' },
    ];
    emitAgentStart({ agent, context, input, hooks: runner });
    emitAgentEnd({ agent, context, output: 'done', hooks: runner });
    expect(startListener).toHaveBeenCalledExactlyOnceWith(
      context,
      agent,
      input,
    );
    expect(listener).toHaveBeenCalledExactlyOnceWith(context, agent, 'done');
  });

  it('stops dispatch at a synchronous listener failure', () => {
    const agent = new Agent({ name: 'guarded' });
    const context = new RunContext();
    const hooks = new RunHooks();
    const failure = new Error('listener failed');
    const afterFailure = vi.fn();
    hooks.on('agent_end', () => {
      throw failure;
    });
    agent.on('agent_end', afterFailure);
    expect(() =>
      emitAgentEnd({ agent, context, output: 'done', hooks }),
    ).toThrow(failure);
    expect(afterFailure).not.toHaveBeenCalled();
  });
});
