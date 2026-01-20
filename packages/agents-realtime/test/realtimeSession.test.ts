import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeSession } from '../src/realtimeSession';
import { RealtimeAgent } from '../src/realtimeAgent';
import type { RealtimeItem } from '../src/items';
import { FakeTransport, TEST_TOOL, fakeModelMessage } from './stubs';
import * as guardrailModule from '../src/guardrail';
import {
  Usage,
  ModelBehaviorError,
  RunToolApprovalItem,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '@openai/agents-core';
import * as utils from '../src/utils';
import type { TransportToolCallEvent } from '../src/transportLayerEvents';
import {
  DEFAULT_OPENAI_REALTIME_SESSION_CONFIG,
  OpenAIRealtimeBase,
} from '../src/openaiRealtimeBase';
import { OpenAIRealtimeWebRTC } from '../src/openaiRealtimeWebRtc';
import { OpenAIRealtimeWebSocket } from '../src/openaiRealtimeWebsocket';
import { toNewSessionConfig } from '../src/clientMessages';
import { tool } from '@openai/agents-core';
import { backgroundResult } from '../src/tool';
import { z } from 'zod';
import logger from '../src/logger';

function createMessage(id: string, text: string): RealtimeItem {
  return {
    itemId: id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }],
  } as RealtimeItem;
}

describe('RealtimeSession', () => {
  let transport: FakeTransport;
  let session: RealtimeSession;

  beforeEach(async () => {
    transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    session = new RealtimeSession(agent, { transport });
    await session.connect({ apiKey: 'test' });
  });

  it('calls transport.resetHistory with correct arguments', () => {
    const item = createMessage('1', 'hi');
    session.updateHistory([item]);

    expect(transport.resetHistoryCalls.length).toBe(1);
    const [oldHist, newHist] = transport.resetHistoryCalls[0];
    expect(oldHist).toEqual([]);
    expect(newHist).toEqual([item]);
  });

  it('sets the trace config correctly', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    transport.connectCalls = [];
    session.options.tracingDisabled = true;
    session.options.workflowName = 'test';
    session.options.groupId = 'test';
    session.options.traceMetadata = { test: 'test' };
    await session.connect({ apiKey: 'test' });
    expect(transport.connectCalls[0]?.initialSessionConfig?.tracing).toEqual(
      null,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'In order to set traceMetadata or a groupId you need to specify a workflowName.',
    );
    warnSpy.mockClear();

    transport.connectCalls = [];
    session.options.tracingDisabled = undefined;
    session.options.workflowName = undefined;
    session.options.groupId = undefined;
    session.options.traceMetadata = undefined;
    await session.connect({ apiKey: 'test' });
    expect(transport.connectCalls[0]?.initialSessionConfig?.tracing).toEqual(
      'auto',
    );
    expect(warnSpy).not.toHaveBeenCalled();
    transport.connectCalls = [];
    session.options.tracingDisabled = undefined;
    session.options.workflowName = 'test';
    session.options.groupId = 'test';
    session.options.traceMetadata = undefined;
    await session.connect({ apiKey: 'test' });
    expect(transport.connectCalls[0]?.initialSessionConfig?.tracing).toEqual({
      workflow_name: 'test',
      group_id: 'test',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('updates history and emits history_updated', () => {
    const historyEvents: RealtimeItem[][] = [];
    session.on('history_updated', (h) => {
      historyEvents.push([...h]);
    });
    const historyAdded: RealtimeItem[] = [];
    session.on('history_added', (item) => {
      historyAdded.push(item);
    });

    const item = createMessage('1', 'hi');
    transport.emit('item_update', item);
    expect(session.history).toEqual([item]);
    expect(session['context'].context.history).toEqual(session.history);
    expect(historyEvents[0]).toEqual([item]);
    expect(historyAdded[0]).toEqual(item);

    transport.emit('item_deleted', { itemId: '1' });
    expect(session.history).toEqual([]);
    expect(session['context'].context.history).toEqual(session.history);
    expect(historyEvents[1]).toEqual([]);
  });

  it('delegates simple actions to transport', () => {
    const buf = new TextEncoder().encode('a').buffer;
    session.sendMessage('hi');
    session.mute(true);
    session.sendAudio(buf, { commit: true });
    session.interrupt();
    session.close();

    expect(transport.sendMessageCalls[0]).toEqual(['hi', {}]);
    expect(transport.muteCalls[0]).toBe(true);
    expect(transport.sendAudioCalls.length).toBe(1);
    expect(transport.interruptCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
  });

  it('selects transport based on environment and options', () => {
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });

    const defaultSession = new RealtimeSession(agent, {});
    expect(defaultSession.transport).toBeInstanceOf(OpenAIRealtimeWebSocket);

    const customTransport = new FakeTransport();
    const customSession = new RealtimeSession(agent, {
      transport: customTransport,
    });
    expect(customSession.transport).toBe(customTransport);

    const originalPeerConnection = (global as any).RTCPeerConnection;
    (global as any).RTCPeerConnection = function () {};
    try {
      const webrtcSession = new RealtimeSession(agent, {
        transport: 'webrtc',
      });
      expect(webrtcSession.transport).toBeInstanceOf(OpenAIRealtimeWebRTC);
    } finally {
      (global as any).RTCPeerConnection = originalPeerConnection;
    }
  });

  it('exposes transport and session state via getters', () => {
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const customTransport = new FakeTransport();
    customTransport.muted = true;
    const customSession = new RealtimeSession(agent, {
      transport: customTransport,
    });

    expect(customSession.transport).toBe(customTransport);
    expect(customSession.currentAgent).toBe(agent);
    expect(customSession.muted).toBe(true);
    expect(customSession.history).toEqual([]);
    expect(customSession.availableMcpTools).toEqual([]);
    expect(customSession.context.context.history).toEqual([]);
  });

  it('forwards url in connect options to transport', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test', url: 'ws://example' });
    expect(t.connectCalls[0]?.url).toBe('ws://example');
  });

  it('forwards callId in connect options to transport', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test', callId: 'call_123' });
    expect(t.connectCalls[0]?.callId).toBe('call_123');
  });

  it('includes default transcription config when connecting', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const normalizedConfig = toNewSessionConfig(
      t.connectCalls[0]?.initialSessionConfig ?? {},
    );

    expect(normalizedConfig.audio?.input?.transcription).toEqual(
      DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input?.transcription,
    );
  });

  it('computes initial session config with tracing metadata and prompt', async () => {
    const agent = new RealtimeAgent({
      name: 'A',
      handoffs: [],
      prompt: () => ({
        promptId: 'prompt-1',
        version: '1',
        variables: { foo: 'bar' },
      }),
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, {
      transport: t,
      workflowName: 'wf',
      groupId: 'group-1',
      traceMetadata: { region: 'us' },
    });

    const config = await s.getInitialSessionConfig();
    expect(config.tracing).toEqual({
      workflow_name: 'wf',
      group_id: 'group-1',
      metadata: { region: 'us' },
    });
    expect(config.prompt).toEqual({
      promptId: 'prompt-1',
      version: '1',
      variables: { foo: 'bar' },
    });
  });

  it('updateHistory accepts callback', () => {
    const item = createMessage('1', 'hi');
    session.updateHistory([item]);
    session.updateHistory((hist) => hist.slice(1));
    const [oldHist, newHist] = transport.resetHistoryCalls[1];
    expect(oldHist).toEqual([]);
    expect(newHist).toEqual([]);
  });

  it('triggers guardrail and emits feedback', async () => {
    const runMock = vi.fn(async () => ({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo: { r: 'bad' } },
    }));
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    session = new RealtimeSession(agent, {
      transport,
      outputGuardrails: [
        {
          name: 'test',
          execute: async () => ({ tripwireTriggered: true }),
        } as any,
      ],
      outputGuardrailSettings: { debounceTextLength: -1 },
    });
    await session.connect({ apiKey: 'test' });

    const guardrailEvents: any[] = [];
    session.on('guardrail_tripped', (...a) => guardrailEvents.push(a));
    transport.emit('turn_done', {
      response: {
        output: [fakeModelMessage('bad output')],
        usage: new Usage(),
      },
    } as any);
    await vi.waitFor(() => expect(guardrailEvents.length).toBe(1));
    expect(transport.interruptCalls).toBe(1);
    expect(transport.sendMessageCalls.at(-1)?.[0]).toContain('blocked');
    expect(guardrailEvents[0][3]).toEqual({ itemId: '123' });
    vi.restoreAllMocks();
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

    transport.emit('function_call', {
      type: 'function_call',
      name: 'echo',
      callId: 'call-1',
      arguments: JSON.stringify({ message: 'hi' }),
    });

    await vi.waitFor(() =>
      expect(transport.sendFunctionCallOutputCalls.length).toBe(1),
    );

    const [toolCall, output, startResponse] =
      transport.sendFunctionCallOutputCalls[0];
    expect(toolCall.name).toBe('echo');
    expect(output).toBe('echo:hi');
    expect(startResponse).toBe(true);
    expect(toolStart).toHaveBeenCalledTimes(1);
    expect(toolEnd).toHaveBeenCalledTimes(1);
    expect(agentToolStart).toHaveBeenCalledTimes(1);
    expect(agentToolEnd).toHaveBeenCalledTimes(1);
  });

  it('merges completed audio transcripts into history', async () => {
    const transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'Listener' });
    const scenarioSession = new RealtimeSession(agent, { transport });
    const historyEvents: any[] = [];
    scenarioSession.on('history_updated', (h) => historyEvents.push([...h]));

    await scenarioSession.connect({ apiKey: 'test-key' });

    transport.emit('item_update', {
      itemId: 'audio-1',
      type: 'message',
      role: 'user',
      status: 'in_progress',
      content: [
        {
          type: 'input_audio',
          audio: 'AA==',
          transcript: null,
        },
      ],
    } as any);

    expect(scenarioSession.history[0]?.itemId).toBe('audio-1');
    transport.emit('*', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'audio-1',
      transcript: 'hello audio',
    });

    await vi.waitFor(() => {
      const latest = historyEvents.at(-1);
      expect(latest?.[0]?.content?.[0]?.transcript).toBe('hello audio');
      expect(latest?.[0]?.status).toBe('completed');
    });
  });

  it('resets guardrail debounce per transcript item', async () => {
    const runMock = vi.fn(async () => ({ output: {} }));
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, {
      transport: t,
      outputGuardrails: [{ name: 'test', execute: async () => ({}) } as any],
      outputGuardrailSettings: { debounceTextLength: 1 },
    });
    await s.connect({ apiKey: 'test' });
    t.emit('audio_transcript_delta', {
      delta: 'a',
      itemId: '1',
      responseId: 'z',
    } as any);
    t.emit('audio_transcript_delta', {
      delta: 'a',
      itemId: '2',
      responseId: 'z',
    } as any);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  it('emits errors for item update/delete failures', () => {
    const errors: any[] = [];
    session.on('error', (e) => errors.push(e));
    const spy = vi
      .spyOn(utils, 'updateRealtimeHistory')
      .mockImplementation(() => {
        throw new Error('update');
      });
    transport.emit('item_update', createMessage('1', 'hi'));
    expect(errors[0].error).toBeInstanceOf(Error);
    expect(errors[0].error.message).toBe('update');
    spy.mockRestore();

    const origFilter = Array.prototype.filter;
    Array.prototype.filter = () => {
      throw new Error('delete');
    };
    transport.emit('item_deleted', { itemId: '1' } as any);
    expect(errors[1].error.message).toBe('delete');
    Array.prototype.filter = origFilter;
  });

  it('propagates errors from handleFunctionCall', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errors: any[] = [];
    session.on('error', (e) => errors.push(e));
    transport.emit('function_call', {
      type: 'function_call',
      name: 'missing',
      callId: '1',
      arguments: '{}',
    });
    await vi.waitFor(() =>
      expect(errors[0].error).toBeInstanceOf(ModelBehaviorError),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Error handling function call',
      expect.any(Error),
    );
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

    const errors: any[] = [];
    localSession.on('error', (e) => errors.push(e));
    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded',
      callId: 'c1',
      status: 'completed',
      arguments: '{}',
    } as any);

    await vi.waitFor(() =>
      expect(localTransport.sendFunctionCallOutputCalls.length).toBe(1),
    );
    expect(localTransport.sendFunctionCallOutputCalls[0]?.[1]).toBe('blocked');
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(errors.length).toBe(0);
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

    const errors: any[] = [];
    localSession.on('error', (e) => errors.push(e));
    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded_throw',
      callId: 'c2',
      status: 'completed',
      arguments: '{}',
    } as any);

    await vi.waitFor(() => expect(errors.length).toBe(1));
    expect(errors[0].error).toBeInstanceOf(ToolInputGuardrailTripwireTriggered);
    expect(localTransport.sendFunctionCallOutputCalls.length).toBe(0);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Error handling function call',
      expect.any(Error),
    );
    errorSpy.mockRestore();
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

    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded_output',
      callId: 'c3',
      status: 'completed',
      arguments: '{}',
    } as any);

    await vi.waitFor(() =>
      expect(localTransport.sendFunctionCallOutputCalls.length).toBe(1),
    );
    expect(localTransport.sendFunctionCallOutputCalls[0]?.[1]).toBe('redacted');
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

    const errors: any[] = [];
    localSession.on('error', (e) => errors.push(e));
    const invokeSpy = vi.spyOn(guardedTool, 'invoke');

    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'guarded_output_throw',
      callId: 'c4',
      status: 'completed',
      arguments: '{}',
    } as any);

    await vi.waitFor(() => expect(errors.length).toBe(1));
    expect(errors[0].error).toBeInstanceOf(
      ToolOutputGuardrailTripwireTriggered,
    );
    expect(localTransport.sendFunctionCallOutputCalls.length).toBe(0);
    expect(invokeSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Error handling function call',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('approve and reject work with tool and error without', async () => {
    const agent = new RealtimeAgent({
      name: 'B',
      handoffs: [],
      tools: [TEST_TOOL],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'test',
      callId: '1',
      arguments: '{"test":"x"}',
    };
    const approval = new RunToolApprovalItem(toolCall as any, agent);
    await s.approve(approval);
    await s.reject(approval);
    expect(t.sendFunctionCallOutputCalls.length).toBe(2);
    expect(t.sendFunctionCallOutputCalls[0][1]).toBe('Hello World');
    expect(t.sendFunctionCallOutputCalls[1][1]).toBe('Hello World');

    const agent2 = new RealtimeAgent({ name: 'C', handoffs: [] });
    const t2 = new FakeTransport();
    const s2 = new RealtimeSession(agent2, { transport: t2 });
    await s2.connect({ apiKey: 'test' });
    const badApproval = new RunToolApprovalItem(toolCall as any, agent2);
    await expect(s2.approve(badApproval)).rejects.toBeInstanceOf(
      ModelBehaviorError,
    );
    await expect(s2.reject(badApproval)).rejects.toBeInstanceOf(
      ModelBehaviorError,
    );
  });

  it('requests tool approval when no decision exists', async () => {
    const needsApprovalTool = tool({
      name: 'needs_approval',
      description: 'Needs approval tool',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      needsApproval: true,
      execute: vi.fn(async () => 'ok'),
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalEvents: any[] = [];
    s.on('tool_approval_requested', (_ctx, _agent, payload) => {
      approvalEvents.push(payload);
    });
    const invokeSpy = vi.spyOn(needsApprovalTool, 'invoke');

    t.emit('function_call', {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-1',
      arguments: '{}',
      status: 'completed',
    } as any);

    await vi.waitFor(() => expect(approvalEvents.length).toBe(1));
    expect(approvalEvents[0].type).toBe('function_approval');
    expect(approvalEvents[0].tool.name).toBe('needs_approval');
    expect(t.sendFunctionCallOutputCalls.length).toBe(0);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('returns a rejection response when approval is denied', async () => {
    const needsApprovalTool = tool({
      name: 'needs_approval',
      description: 'Needs approval tool',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      needsApproval: true,
      execute: vi.fn(async () => 'ok'),
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-2',
      arguments: '{}',
    };
    const approvalItem = new RunToolApprovalItem(toolCall as any, agent);
    s.context.rejectTool(approvalItem);
    const invokeSpy = vi.spyOn(needsApprovalTool, 'invoke');

    t.emit('function_call', toolCall as any);

    await vi.waitFor(() =>
      expect(t.sendFunctionCallOutputCalls.length).toBe(1),
    );
    expect(t.sendFunctionCallOutputCalls[0][1]).toBe(
      'Tool execution was not approved.',
    );
    expect(t.sendFunctionCallOutputCalls[0][2]).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
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

    t.emit('function_call', {
      type: 'function_call',
      name: 'background_tool',
      callId: 'call-3',
      arguments: '{}',
      status: 'completed',
    } as any);

    await vi.waitFor(() =>
      expect(t.sendFunctionCallOutputCalls.length).toBe(1),
    );
    expect(t.sendFunctionCallOutputCalls[0][1]).toBe('{"ok":true}');
    expect(t.sendFunctionCallOutputCalls[0][2]).toBe(false);
  });

  it('approves hosted tool calls by sending MCP responses', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'hosted_mcp',
        arguments: JSON.stringify({ foo: 'bar' }),
        status: 'in_progress',
        providerData: {
          itemId: 'item-1',
          serverLabel: 'server-1',
        },
      } as any,
      agent,
    );

    await s.approve(approvalItem, { alwaysApprove: true });

    expect(t.sendMcpResponseCalls.length).toBe(1);
    expect(t.sendMcpResponseCalls[0][1]).toBe(true);
    expect(t.sendMcpResponseCalls[0][0]).toMatchObject({
      type: 'mcp_approval_request',
      itemId: 'item-1',
      serverLabel: 'server-1',
      name: 'hosted_mcp',
      arguments: { foo: 'bar' },
      approved: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Always approving MCP tools is not supported. Use the allowed tools configuration instead.',
    );
    warnSpy.mockRestore();
  });

  it('rejects hosted tool calls by sending MCP responses', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'hosted_mcp',
        arguments: JSON.stringify({ foo: 'bar' }),
        status: 'in_progress',
        providerData: {
          itemId: 'item-2',
          serverLabel: 'server-2',
        },
      } as any,
      agent,
    );

    await s.reject(approvalItem, { alwaysReject: true });

    expect(t.sendMcpResponseCalls.length).toBe(1);
    expect(t.sendMcpResponseCalls[0][1]).toBe(false);
    expect(t.sendMcpResponseCalls[0][0]).toMatchObject({
      type: 'mcp_approval_request',
      itemId: 'item-2',
      serverLabel: 'server-2',
      name: 'hosted_mcp',
      arguments: { foo: 'bar' },
      approved: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Always rejecting MCP tools is not supported. Use the allowed tools configuration instead.',
    );
    warnSpy.mockRestore();
  });

  it('emits tool approval requests for MCP approvals', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalEvents: any[] = [];
    s.on('tool_approval_requested', (_ctx, _agent, payload) => {
      approvalEvents.push(payload);
    });

    t.emit('mcp_approval_request', {
      itemId: 'item-3',
      type: 'mcp_approval_request',
      serverLabel: 'server-3',
      name: 'mcp_tool',
      arguments: { foo: 'bar' },
      approved: null,
    });

    await vi.waitFor(() => expect(approvalEvents.length).toBe(1));
    expect(approvalEvents[0].type).toBe('mcp_approval_request');
    expect(approvalEvents[0].approvalItem.rawItem.type).toBe(
      'hosted_tool_call',
    );
    expect(approvalEvents[0].approvalItem.rawItem.providerData).toMatchObject({
      itemId: 'item-3',
      serverLabel: 'server-3',
    });
  });

  it('handles usage and audio interrupted events', () => {
    const usage = new Usage({ totalTokens: 5 });
    transport.emit('usage_update', usage);
    expect(session.usage.totalTokens).toBe(5);

    let audioEvents = 0;
    session.on('audio_interrupted', () => audioEvents++);
    transport.emit('audio_interrupted');
    expect(audioEvents).toBe(1);
  });

  it('emits audio_start when audio begins', () => {
    let startEvents = 0;
    session.on('audio_start', () => startEvents++);
    transport.emit('turn_started', {} as any);
    transport.emit('audio', {
      type: 'audio',
      data: new ArrayBuffer(1),
      responseId: 'r',
    } as any);
    transport.emit('audio', {
      type: 'audio',
      data: new ArrayBuffer(1),
      responseId: 'r',
    } as any);
    expect(startEvents).toBe(1);
    transport.emit('audio_done');
    transport.emit('turn_started', {} as any);
    transport.emit('audio', {
      type: 'audio',
      data: new ArrayBuffer(1),
      responseId: 'r2',
    } as any);
    expect(startEvents).toBe(2);
  });

  it('preserves custom audio formats across updateAgent', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'Orig', handoffs: [] });
    const s = new RealtimeSession(agent, {
      transport: t,
      config: {
        audio: {
          input: { format: 'g711_ulaw' },
          output: { format: 'g711_ulaw' },
        },
      },
    });
    await s.connect({ apiKey: 'test' });
    const newAgent = new RealtimeAgent({ name: 'Next', handoffs: [] });
    await s.updateAgent(newAgent);
    // Find the last updateSessionConfig call
    const last = t.updateSessionConfigCalls.at(-1)!;
    expect((last as any).audio?.input?.format).toBe('g711_ulaw');
    expect((last as any).audio?.output?.format).toBe('g711_ulaw');
  });

  it('defaults item status to completed for done output items without status', async () => {
    class TestTransport extends OpenAIRealtimeBase {
      status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
        'connected';
      connect = vi.fn(async () => {});
      sendEvent = vi.fn();
      mute = vi.fn();
      close = vi.fn();
      interrupt = vi.fn();
      get muted() {
        return false;
      }
    }
    const transport = new TestTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const session = new RealtimeSession(agent, { transport });
    await session.connect({ apiKey: 'test' });
    const historyEvents: RealtimeItem[][] = [];
    session.on('history_updated', (h) => historyEvents.push([...h]));
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'e',
        item: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi' }],
        },
        output_index: 0,
        response_id: 'r1',
      }),
    });
    const latest = historyEvents.at(-1)!;
    const msg = latest.find(
      (i): i is Extract<RealtimeItem, { type: 'message'; role: 'assistant' }> =>
        i.type === 'message' &&
        i.role === 'assistant' &&
        (i as any).itemId === 'm1',
    );
    expect(msg).toBeDefined();
    expect(msg!.status).toBe('completed');
  });

  it('preserves explicit completed status on done', async () => {
    class TestTransport extends OpenAIRealtimeBase {
      status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
        'connected';
      connect = vi.fn(async () => {});
      sendEvent = vi.fn();
      mute = vi.fn();
      close = vi.fn();
      interrupt = vi.fn();
      get muted() {
        return false;
      }
    }
    const transport = new TestTransport();
    const session = new RealtimeSession(
      new RealtimeAgent({ name: 'A', handoffs: [] }),
      { transport },
    );
    await session.connect({ apiKey: 'test' });

    const historyEvents: RealtimeItem[][] = [];
    session.on('history_updated', (h) => historyEvents.push([...h]));

    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'e',
        item: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hi again' }],
        },
        output_index: 0,
        response_id: 'r2',
      }),
    });

    const latest = historyEvents.at(-1)!;
    const msg = latest.find(
      (i): i is Extract<RealtimeItem, { type: 'message'; role: 'assistant' }> =>
        i.type === 'message' &&
        i.role === 'assistant' &&
        (i as any).itemId === 'm2',
    );
    expect(msg).toBeDefined();
    expect(msg!.status).toBe('completed'); // ensure we didn't overwrite server status
  });
});
