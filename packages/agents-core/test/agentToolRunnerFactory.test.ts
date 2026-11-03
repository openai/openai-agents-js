import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { Runner, type RunConfig } from '../src/run';
import {
  ScriptedModel,
  modelResponse,
  assistantMessage,
  modelResponder,
  modelStreamResponder,
} from '../src/testing';
import { AGENT_TOOL_RUNNER_FACTORY } from '../src/utils/internal';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('agent-tool invocation runner ownership', () => {
  it('uses the selected runner for one invocation and the ordinary runner for the next', async () => {
    const model = new ScriptedModel([
      modelResponse([assistantMessage('selected invocation')]),
      modelResponse([assistantMessage('ordinary invocation')]),
    ]);
    const agent = new Agent({ name: 'child', model });
    const agentTool = agent.asTool({
      toolName: 'child',
      toolDescription: 'Child.',
    });
    const factories: unknown[] = [];
    const input = JSON.stringify({ input: 'hello' });
    const selected = await agentTool.invoke(new RunContext(), input, {
      [AGENT_TOOL_RUNNER_FACTORY]: (config, options) => {
        factories.push(options);
        return new Runner(config);
      },
    });
    const ordinary = await agentTool.invoke(new RunContext(), input);
    expect(selected).toBe('selected invocation');
    expect(ordinary).toBe('ordinary invocation');
    expect(factories).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
    expect(agentTool[AGENT_TOOL_RUNNER_FACTORY]).toBe(true);
  });

  it('uses normal tool failure handling without executing the default runner', async () => {
    const model = new ScriptedModel([
      modelResponse([assistantMessage('must not run')]),
    ]);
    const agent = new Agent({ name: 'child', model });
    const agentTool = agent.asTool({
      toolName: 'child',
      toolDescription: 'Child.',
    });
    const failure = new Error('selected runner unavailable');
    await expect(
      agentTool.invoke(new RunContext(), JSON.stringify({ input: 'hello' }), {
        [AGENT_TOOL_RUNNER_FACTORY]: () => {
          throw failure;
        },
      }),
    ).resolves.toBe(
      'An error occurred while running the tool. Please try again.',
    );
    expect(model.calls).toHaveLength(0);
  });

  it('keeps overlapping and later default invocations independent and forwards the merged config', async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const model = new ScriptedModel([
      modelResponder(async () => {
        entered.resolve();
        await release.promise;
        return [assistantMessage('selected')];
      }),
      modelResponse([assistantMessage('overlapping default')]),
      modelResponse([assistantMessage('later default')]),
    ]);
    const provider = { getModel: () => model };
    const agent = new Agent({ name: 'child' });
    const runContext = new RunContext({ locale: 'en-US' });
    const nested = agent.asTool({
      toolDescription: 'Child.',
      runConfig: { model: 'child-model', modelSettings: { temperature: 0.2 } },
      runOptions: { maxTurns: 3 },
      onStreamMaxPendingEvents: 8,
    });
    let captured: Partial<RunConfig> | undefined;
    let selected = 0;
    const parentRunConfig = {
      model: 'parent-model',
      modelProvider: provider,
      tracingDisabled: true,
      modelSettings: {
        temperature: 0.9,
        topP: 0.7,
        toolChoice: 'required' as const,
      },
    };
    const active = nested.invoke(
      runContext,
      JSON.stringify({ input: 'selected input' }),
      {
        parentRunConfig,
        [AGENT_TOOL_RUNNER_FACTORY]: (config, options) => {
          captured = config;
          selected += 1;
          expect(options).toEqual({ maxPendingEvents: 8 });
          return new Runner(config);
        },
      },
    );
    await entered.promise;
    try {
      expect(
        await nested.invoke(
          new RunContext(),
          JSON.stringify({ input: 'overlap' }),
          { parentRunConfig },
        ),
      ).toBe('overlapping default');
      expect(captured).toMatchObject({
        model: 'child-model',
        modelSettings: { temperature: 0.2, topP: 0.7 },
        tracingDisabled: true,
      });
      expect(captured?.modelProvider).toBe(provider);
      expect(captured?.modelSettings?.toolChoice).toBeUndefined();
      expect(JSON.stringify(model.calls[0].request.input)).toContain(
        'selected input',
      );
    } finally {
      release.resolve();
    }
    expect(await active).toBe('selected');
    expect(
      await nested.invoke(
        new RunContext(),
        JSON.stringify({ input: 'later' }),
        { parentRunConfig },
      ),
    ).toBe('later default');
    expect(selected).toBe(1);
    expect(model.calls).toHaveLength(3);
  });

  it('delivers a held non-streaming invocation abort to its selected runner without replay', async () => {
    const entered = createDeferred();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const model = new ScriptedModel([
      modelResponder(async (call) => {
        received = call.request.signal;
        entered.resolve();
        await new Promise<void>((resolve) =>
          received!.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw received!.reason;
      }),
    ]);
    const nested = new Agent({ name: 'child', model }).asTool({
      toolDescription: 'Child.',
    });
    const reason = new Error('stop selected invocation');
    const invocation = nested.invoke(
      new RunContext(),
      JSON.stringify({ input: 'held' }),
      {
        signal: controller.signal,
        [AGENT_TOOL_RUNNER_FACTORY]: (config) => new Runner(config),
      },
    );
    const outcome = invocation.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(received).toBe(controller.signal);
    expect(model.calls).toHaveLength(1);
  });

  it('preserves streamed event order and invocation metadata through the selected runner', async () => {
    const model = new ScriptedModel([
      modelResponse([assistantMessage('streamed')]),
    ]);
    const agent = new Agent({ name: 'child', model });
    const context = new RunContext({ locale: 'en-US' });
    const toolCall = {
      type: 'function_call' as const,
      name: 'child',
      callId: 'selected-call',
      status: 'completed' as const,
      arguments: JSON.stringify({ input: 'hello' }),
    };
    const events: string[] = [];
    let factories = 0;
    const nested = agent.asTool({
      toolName: 'child',
      toolDescription: 'Child.',
      onStreamMaxPendingEvents: 4,
      onStream: ({ event, agent: eventAgent, toolCall: eventCall }) => {
        expect(eventAgent).toBe(agent);
        expect(eventCall).toBe(toolCall);
        if (event.type === 'raw_model_stream_event')
          events.push(event.data.type);
      },
      customOutputExtractor: (result) => {
        expect(result.runContext).toBe(context);
        expect(result.lastAgent).toBe(agent);
        return result.finalOutput!;
      },
    });
    expect(
      await nested.invoke(context, toolCall.arguments, {
        toolCall,
        [AGENT_TOOL_RUNNER_FACTORY]: (config, options) => {
          expect(options).toEqual({ maxPendingEvents: 4 });
          factories += 1;
          return new Runner(config);
        },
      }),
    ).toBe('streamed');
    expect(events).toEqual([
      'response_started',
      'output_text_delta',
      'response_done',
    ]);
    expect(factories).toBe(1);
    expect(model.calls[0].streamed).toBe(true);
  });

  it('waits for selected stream cleanup on abort and leaves later default streaming usable', async () => {
    const entered = createDeferred();
    const cleanupStarted = createDeferred();
    const cleanupRelease = createDeferred();
    const controller = new AbortController();
    const configuredController = new AbortController();
    let cleaned = false;
    let received: AbortSignal | undefined;
    const model = new ScriptedModel([
      modelStreamResponder((call) =>
        (async function* () {
          received = call.request.signal;
          try {
            yield { type: 'output_text_delta' as const, delta: 'partial' };
            entered.resolve();
            await new Promise<void>((resolve) =>
              received!.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          } finally {
            cleanupStarted.resolve();
            await cleanupRelease.promise;
            cleaned = true;
          }
        })(),
      ),
      modelResponse([assistantMessage('later stream')]),
    ]);
    const nested = new Agent({ name: 'child', model }).asTool({
      toolDescription: 'Child.',
      runOptions: { signal: configuredController.signal },
      onStream: () => {},
    });
    let selected = 0;
    let settled = false;
    const reason = new Error('stop selected stream');
    const invocation = nested.invoke(
      new RunContext(),
      JSON.stringify({ input: 'stream' }),
      {
        signal: controller.signal,
        [AGENT_TOOL_RUNNER_FACTORY]: (config) => {
          selected += 1;
          return new Runner(config);
        },
      },
    );
    const outcome = invocation.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    controller.abort(reason);
    await cleanupStarted.promise;
    try {
      expect(received).not.toBe(controller.signal);
      expect(received).not.toBe(configuredController.signal);
      expect(received?.reason).toBe(reason);
      expect(settled).toBe(false);
    } finally {
      cleanupRelease.resolve();
    }
    expect(await outcome).toBe(reason);
    expect(cleaned).toBe(true);
    expect(
      await nested.invoke(new RunContext(), JSON.stringify({ input: 'later' })),
    ).toBe('later stream');
    expect(selected).toBe(1);
    expect(model.calls).toHaveLength(2);
  });
});
