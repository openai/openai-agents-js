import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeSession } from '../src/realtimeSession';
import { RealtimeAgent } from '../src/realtimeAgent';
import { FakeTransport } from './stubs';
import {
  ModelBehaviorError,
  tool,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents-core';
import type { TransportToolCallEvent } from '../src/transportLayerEvents';
import { backgroundResult } from '../src/tool';
import { z } from 'zod';
import logger from '../src/logger';
import { waitForEvent } from './realtimeSessionTestUtils';

describe('RealtimeSession', () => {
  let transport: FakeTransport;
  let session: RealtimeSession;

  beforeEach(async () => {
    transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    session = new RealtimeSession(agent, { transport });
    await session.connect({ apiKey: 'test' });
  });

  it('runs tool calls end-to-end and emits lifecycle events', async () => {
    const transport = new FakeTransport();
    const echoTool = tool({
      name: 'echo',
      description: 'echo tool',
      parameters: z.object({ message: z.string() }),
      execute: async ({ message }) => `echo:${message}`,
    });
    const agent = new RealtimeAgent({
      name: 'Tool Agent',
      tools: [echoTool],
    });
    const scenarioSession = new RealtimeSession(agent, { transport });
    const toolStart = vi.fn();
    const toolEnd = vi.fn();
    scenarioSession.on('agent_tool_start', toolStart);
    scenarioSession.on('agent_tool_end', toolEnd);
    const agentToolStart = vi.fn();
    const agentToolEnd = vi.fn();
    agent.on('agent_tool_start', agentToolStart);
    agent.on('agent_tool_end', agentToolEnd);

    await scenarioSession.connect({ apiKey: 'test-key' });

    const outputPromise = transport.waitForNextFunctionCallOutput();
    transport.emit('function_call', {
      type: 'function_call',
      name: 'echo',
      callId: 'call-1',
      arguments: JSON.stringify({ message: 'hi' }),
      responseId: 'tool-response',
    });

    const [toolCall, output, startResponse] = await outputPromise;
    expect(toolCall.name).toBe('echo');
    expect(output).toBe('echo:hi');
    expect(startResponse).toBe(true);
    expect(toolStart).toHaveBeenCalledTimes(1);
    expect(toolEnd).toHaveBeenCalledTimes(1);
    expect(agentToolStart).toHaveBeenCalledTimes(1);
    expect(agentToolEnd).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a tool after a start listener closes the session', async () => {
    const transport = new FakeTransport();
    const execute = vi.fn(async () => 'unexpected');
    const localTool = tool({
      name: 'close_on_start',
      description: 'Must not run after a synchronous close.',
      parameters: z.object({}),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'CloseOnToolStartAgent',
      tools: [localTool],
    });
    const localSession = new RealtimeSession(agent, { transport });
    localSession.on('agent_tool_start', () => localSession.close());
    await localSession.connect({ apiKey: 'test-key' });

    transport.emit('function_call', {
      type: 'function_call',
      name: localTool.name,
      callId: 'close-on-start-call',
      arguments: '{}',
      responseId: 'close-on-start-response',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execute).not.toHaveBeenCalled();
    expect(transport.sendFunctionCallOutputCalls).toHaveLength(0);
  });

  it('returns an error output without starting a response for unknown tools', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errorEvent = waitForEvent<any[]>(session, 'error');
    const outputEvent = transport.waitForNextFunctionCallOutput();
    transport.emit('function_call', {
      type: 'function_call',
      name: 'missing',
      callId: '1',
      arguments: '{}',
      responseId: 'unknown-tool-response',
    });
    const [toolCall, output, startResponse] = await outputEvent;
    const [error] = await errorEvent;
    expect(toolCall.name).toBe('missing');
    expect(output).toBe('Tool missing not found');
    expect(startResponse).toBe(false);
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(error.error.message).toBe('Tool missing not found');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('applies input tool guardrail rejectContent and skips tool execution', async () => {
    const localTransport = new FakeTransport();
    const guardrail = defineToolInputGuardrail({
      name: 'rejector',
      run: async () =>
        ToolGuardrailFunctionOutputFactory.rejectContent('blocked'),
    });
    const guardedTool = tool({
      name: 'guarded',
      description: 'guarded tool',
      parameters: z.object({}),
      execute: vi.fn(async () => 'should-not-run'),
      inputGuardrails: [guardrail],
    }) as any;
    const agent = new RealtimeAgent({
      name: 'A',
      handoffs: [],
      tools: [guardedTool],
    });
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    const outputPromise = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded',
      callId: 'c1',
      status: 'completed',
      arguments: '{}',
      responseId: 'input-guardrail-response',
    } as any);

    const [, output] = await outputPromise;
    expect(output).toBe('blocked');
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('emits error when input tool guardrail throws', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const localTransport = new FakeTransport();
    const guardrail = defineToolInputGuardrail({
      name: 'thrower',
      run: async () => ToolGuardrailFunctionOutputFactory.throwException(),
    });
    const guardedTool = tool({
      name: 'guarded_throw',
      description: 'guarded tool',
      parameters: z.object({}),
      execute: vi.fn(async () => 'never'),
      inputGuardrails: [guardrail],
    }) as any;
    const agent = new RealtimeAgent({
      name: 'A',
      handoffs: [],
      tools: [guardedTool],
    });
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded_throw',
      callId: 'c2',
      status: 'completed',
      arguments: '{}',
      responseId: 'input-guardrail-error-response',
    } as any);

    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ToolInputGuardrailTripwireTriggered);
    expect(localTransport.sendFunctionCallOutputCalls.length).toBe(0);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Error handling function call',
      'object',
    );
    errorSpy.mockRestore();
  });

  it.each([true, false])(
    'applies tool-data logging policy to function call failures (%s)',
    async (redactToolData) => {
      const secret = 'SECRET_REALTIME_FUNCTION_VALUE_123';
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(redactToolData);
      const localTransport = new FakeTransport();
      const guardrail = defineToolInputGuardrail({
        name: 'throw-secret',
        run: async () => {
          throw new Error(secret);
        },
      });
      const guardedTool = tool({
        name: 'guarded_secret',
        description: 'guarded tool',
        parameters: z.object({}),
        execute: vi.fn(async () => 'never'),
        inputGuardrails: [guardrail],
      }) as any;
      const localSession = new RealtimeSession(
        new RealtimeAgent({ name: 'A', tools: [guardedTool] }),
        { transport: localTransport },
      );

      try {
        await localSession.connect({ apiKey: 'test' });
        const errorEvent = waitForEvent<any[]>(localSession, 'error');

        localTransport.emit('function_call', {
          type: 'function_call',
          name: 'guarded_secret',
          callId: 'secret-call',
          status: 'completed',
          arguments: '{}',
          responseId: 'secret-response',
        } as any);
        await errorEvent;

        if (redactToolData) {
          expect(errorSpy).toHaveBeenCalledWith(
            'Error handling function call',
            'object',
          );
          expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
        } else {
          expect(errorSpy).toHaveBeenCalledWith(
            'Error handling function call',
            expect.any(Error),
          );
        }
      } finally {
        flagSpy.mockRestore();
        errorSpy.mockRestore();
      }
    },
  );

  it('emits function call errors when a redacted guardrail throws a hostile Proxy', async () => {
    const guardrailError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('SECRET_PROXY_TRAP_123');
        },
      },
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const localTransport = new FakeTransport();
    const guardrail = defineToolInputGuardrail({
      name: 'throw-hostile-proxy',
      run: async () => {
        throw guardrailError;
      },
    });
    const guardedTool = tool({
      name: 'guarded_hostile_proxy',
      description: 'guarded tool',
      parameters: z.object({}),
      execute: vi.fn(async () => 'never'),
      inputGuardrails: [guardrail],
    }) as any;
    const localSession = new RealtimeSession(
      new RealtimeAgent({ name: 'A', tools: [guardedTool] }),
      { transport: localTransport },
    );

    try {
      await localSession.connect({ apiKey: 'test' });
      const errorEvent = waitForEvent<any[]>(localSession, 'error');

      localTransport.emit('function_call', {
        type: 'function_call',
        name: 'guarded_hostile_proxy',
        callId: 'hostile-proxy-call',
        status: 'completed',
        arguments: '{}',
        responseId: 'hostile-proxy-response',
      } as any);

      const [error] = await errorEvent;
      expect(error.error).toBe(guardrailError);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error handling function call',
        'object',
      );
    } finally {
      flagSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('applies output tool guardrail rejectContent and replaces output', async () => {
    const localTransport = new FakeTransport();
    const guardrail = defineToolOutputGuardrail({
      name: 'replace',
      run: async () =>
        ToolGuardrailFunctionOutputFactory.rejectContent('redacted'),
    });
    const guardedTool = tool({
      name: 'guarded_output',
      description: 'guarded tool',
      parameters: z.object({}),
      execute: vi.fn(async () => ({ secret: true })),
      outputGuardrails: [guardrail],
    }) as any;
    const agent = new RealtimeAgent({
      name: 'A',
      handoffs: [],
      tools: [guardedTool],
    });
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    const outputPromise = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded_output',
      callId: 'c3',
      status: 'completed',
      arguments: '{}',
      responseId: 'output-guardrail-response',
    } as any);

    const [, output] = await outputPromise;
    expect(output).toBe('redacted');
    expect(invokeSpy).toHaveBeenCalled();
  });

  it('emits error when output tool guardrail throws', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const localTransport = new FakeTransport();
    const guardrail = defineToolOutputGuardrail({
      name: 'thrower_out',
      run: async () => ToolGuardrailFunctionOutputFactory.throwException(),
    });
    const guardedTool = tool({
      name: 'guarded_output_throw',
      description: 'guarded tool',
      parameters: z.object({}),
      execute: vi.fn(async () => 'ok'),
      outputGuardrails: [guardrail],
    }) as any;
    const agent = new RealtimeAgent({
      name: 'A',
      handoffs: [],
      tools: [guardedTool],
    });
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded_output_throw',
      callId: 'c4',
      status: 'completed',
      arguments: '{}',
      responseId: 'output-guardrail-error-response',
    } as any);

    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ToolOutputGuardrailTripwireTriggered);
    expect(localTransport.sendFunctionCallOutputCalls.length).toBe(0);
    expect(invokeSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Error handling function call',
      'object',
    );
    errorSpy.mockRestore();
  });

  it('ignores function calls after the session is closed', async () => {
    const execute = vi.fn(async () => 'unexpected output');
    const localTool = tool({
      name: 'closed_session_tool',
      description: 'Must not run after close.',
      parameters: z.object({}),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ClosedSessionAgent',
      tools: [localTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    localSession.close();

    localTransport.emit('function_call', {
      type: 'function_call',
      name: localTool.name,
      callId: 'closed-session-call',
      arguments: '{}',
      responseId: 'closed-session-response',
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execute).not.toHaveBeenCalled();
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
  });

  it('replays committed realtime output without invoking the tool twice', async () => {
    const execute = vi.fn(async () => 'committed output');
    const replayTool = tool({
      name: 'realtime_replay_tool',
      description: 'Runs only once for an exact replay.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'RealtimeReplayAgent',
      tools: [replayTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: replayTool.name,
      callId: 'realtime-completed-replay',
      arguments: '{"value":"safe"}',
      responseId: 'realtime-completed-response',
    };

    const firstOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall);
    expect((await firstOutput)[1]).toBe('committed output');
    const replayOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall);
    expect((await replayOutput)[1]).toBe('committed output');
    expect(execute).toHaveBeenCalledTimes(1);

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    localTransport.emit('function_call', {
      ...toolCall,
      arguments: '{"value":"changed"}',
    });
    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(execute).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('suppresses exact replay when output transport throws after accepting the send', async () => {
    const execute = vi.fn(async () => 'accepted output');
    const replayTool = tool({
      name: 'transport_failure_replay_tool',
      description: 'Runs only once when output delivery is uncertain.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'TransportFailureReplayAgent',
      tools: [replayTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: replayTool.name,
      callId: 'transport-failure-replay',
      arguments: '{"value":"safe"}',
      responseId: 'transport-failure-response',
    };
    const originalSend =
      localTransport.sendFunctionCallOutput.bind(localTransport);
    const sendSpy = vi
      .spyOn(localTransport, 'sendFunctionCallOutput')
      .mockImplementationOnce((...args) => {
        originalSend(...args);
        throw new Error('transport failed after accepting output');
      });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const firstOutput = localTransport.waitForNextFunctionCallOutput();
    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    localTransport.emit('function_call', toolCall);
    expect((await firstOutput)[1]).toBe('accepted output');
    expect((await errorEvent)[0].error).toMatchObject({
      message: 'transport failed after accepting output',
    });

    const replayOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall);
    expect((await replayOutput)[1]).toBe('accepted output');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('suppresses synchronous reentry while sending a committed function output', async () => {
    const execute = vi.fn(async () => 'reentrant output');
    const replayTool = tool({
      name: 'synchronous_output_reentry_tool',
      description:
        'Sends one output when the transport reenters synchronously.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'SynchronousOutputReentryAgent',
      tools: [replayTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: replayTool.name,
      callId: 'synchronous-output-reentry',
      arguments: '{"value":"safe"}',
      responseId: 'synchronous-output-response',
    };
    const originalSend =
      localTransport.sendFunctionCallOutput.bind(localTransport);
    let reentered = false;
    const sendSpy = vi
      .spyOn(localTransport, 'sendFunctionCallOutput')
      .mockImplementation((...args) => {
        originalSend(...args);
        if (!reentered) {
          reentered = true;
          localTransport.emit('function_call', toolCall);
        }
      });

    const output = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall);
    expect((await output)[1]).toBe('reentrant output');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(1);
    sendSpy.mockRestore();
  });

  it('serializes overlapping realtime replays before tool side effects', async () => {
    let markStarted: () => void = () => {};
    let releaseExecution: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const execute = vi.fn(async () => {
      markStarted();
      await executionReleased;
      return 'serialized output';
    });
    const replayTool = tool({
      name: 'overlapping_realtime_tool',
      description: 'Serializes overlapping replay attempts.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'OverlappingReplayAgent',
      tools: [replayTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: replayTool.name,
      callId: 'overlapping-replay-call',
      arguments: '{"value":"safe"}',
      responseId: 'overlapping-replay-response',
    };

    localTransport.emit('function_call', toolCall);
    await started;

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    localTransport.emit('function_call', {
      ...toolCall,
      arguments: '{"value":"changed"}',
    });
    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ModelBehaviorError);

    localTransport.emit('function_call', toolCall);
    releaseExecution();
    await vi.waitFor(() => {
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(2);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      localTransport.sendFunctionCallOutputCalls.map(([, output]) => output),
    ).toEqual(['serialized output', 'serialized output']);
    errorSpy.mockRestore();
  });

  it('does not let stale tool completion cross a realtime reconnect', async () => {
    let releaseFirstExecution: () => void = () => {};
    const firstExecutionReleased = new Promise<void>((resolve) => {
      releaseFirstExecution = resolve;
    });
    const execute = vi.fn(async ({ value }: { value: string }) => {
      if (value === 'first') {
        await firstExecutionReleased;
      }
      return `${value} output`;
    });
    const reconnectTool = tool({
      name: 'reconnect_generation_tool',
      description: 'Keeps tool completion scoped to one connection.',
      parameters: z.object({ value: z.string() }),
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ReconnectGenerationAgent',
      tools: [reconnectTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    const toolEnd = vi.fn();
    localSession.on('agent_tool_end', toolEnd);
    await localSession.connect({ apiKey: 'test' });
    const firstCall: TransportToolCallEvent = {
      type: 'function_call',
      name: reconnectTool.name,
      callId: 'reconnect-generation-call',
      arguments: '{"value":"first"}',
      responseId: 'first-generation-response',
    };

    localTransport.emit('function_call', firstCall);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    localTransport.emit('function_call', firstCall);
    localSession.close();
    await localSession.connect({ apiKey: 'test' });

    localTransport.emit('function_call', {
      ...firstCall,
      arguments: '{"value":"second"}',
      responseId: 'second-generation-response',
    });
    await vi.waitFor(() =>
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(1),
    );
    expect(localTransport.sendFunctionCallOutputCalls[0]?.[1]).toBe(
      'second output',
    );

    releaseFirstExecution();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toolEnd).toHaveBeenCalledTimes(1);
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reserves a realtime call ID before awaiting dynamic enablement', async () => {
    let markEnablementStarted: () => void = () => {};
    let releaseEnablement: () => void = () => {};
    const enablementStarted = new Promise<void>((resolve) => {
      markEnablementStarted = resolve;
    });
    const enablementReleased = new Promise<void>((resolve) => {
      releaseEnablement = resolve;
    });
    const isEnabled = vi.fn(async () => {
      if (isEnabled.mock.calls.length === 1) {
        return true;
      }
      markEnablementStarted();
      await enablementReleased;
      return true;
    });
    const execute = vi.fn(async () => 'safe output');
    const dynamicTool = tool({
      name: 'dynamic_enablement_tool',
      description: 'Waits before dynamic enablement resolves.',
      parameters: z.object({ value: z.string() }),
      isEnabled,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'DynamicEnablementReplayAgent',
      tools: [dynamicTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const safeCall: TransportToolCallEvent = {
      type: 'function_call',
      name: dynamicTool.name,
      callId: 'dynamic-enablement-call',
      arguments: '{"value":"safe"}',
      responseId: 'dynamic-enablement-response',
    };

    localTransport.emit('function_call', safeCall);
    await enablementStarted;
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errors: any[] = [];
    localSession.on('error', (error) => errors.push(error));
    localTransport.emit('function_call', {
      ...safeCall,
      arguments: '{"value":"changed"}',
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    const error = errors[0];
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(isEnabled).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();

    const output = localTransport.waitForNextFunctionCallOutput();
    releaseEnablement();
    expect((await output)[1]).toBe('safe output');
    expect(execute).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does not execute a tool whose enablement resolves after reconnecting', async () => {
    let deferEnablement = false;
    let markEnablementStarted: () => void = () => {};
    let releaseEnablement: () => void = () => {};
    const enablementStarted = new Promise<void>((resolve) => {
      markEnablementStarted = resolve;
    });
    const enablementReleased = new Promise<void>((resolve) => {
      releaseEnablement = resolve;
    });
    const execute = vi.fn(async () => 'stale output');
    const dynamicTool = tool({
      name: 'reconnect_enablement_tool',
      description: 'Waits while its connection can be replaced.',
      parameters: z.object({}),
      isEnabled: async () => {
        if (!deferEnablement) {
          return true;
        }
        markEnablementStarted();
        await enablementReleased;
        return true;
      },
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ReconnectEnablementAgent',
      tools: [dynamicTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    deferEnablement = true;
    localTransport.emit('function_call', {
      type: 'function_call',
      name: dynamicTool.name,
      callId: 'stale-enablement-call',
      arguments: '{}',
      responseId: 'stale-enablement-response',
    } as any);
    await enablementStarted;

    localSession.close();
    deferEnablement = false;
    await localSession.connect({ apiKey: 'test' });
    releaseEnablement();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execute).not.toHaveBeenCalled();
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
  });

  it('commits missing realtime tool responses to the replay authority', async () => {
    const agent = new RealtimeAgent({ name: 'MissingToolReplayAgent' });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const missingCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'missing_realtime_tool',
      callId: 'missing-realtime-call',
      arguments: '{"value":"safe"}',
      responseId: 'missing-realtime-response',
    };
    const errors: any[] = [];
    localSession.on('error', (error) => errors.push(error));
    const firstOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', missingCall);
    expect((await firstOutput)[1]).toBe('Tool missing_realtime_tool not found');
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    const replayOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', missingCall);
    expect((await replayOutput)[1]).toBe(
      'Tool missing_realtime_tool not found',
    );

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    localTransport.emit('function_call', {
      ...missingCall,
      arguments: '{"value":"changed"}',
    });
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    const error = errors[1];
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it('uses background results without starting a new response', async () => {
    const backgroundTool = tool({
      name: 'background_tool',
      description: 'Background tool',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: vi.fn(async () => backgroundResult({ ok: true })),
    });
    const agent = new RealtimeAgent({
      name: 'BackgroundAgent',
      handoffs: [],
      tools: [backgroundTool],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', {
      type: 'function_call',
      name: 'background_tool',
      callId: 'call-3',
      arguments: '{}',
      status: 'completed',
      responseId: 'background-response',
    } as any);

    const [, output, startResponse] = await outputPromise;
    expect(output).toBe('{"ok":true}');
    expect(startResponse).toBe(false);
  });
});
