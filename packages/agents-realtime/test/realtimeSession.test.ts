import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeSession } from '../src/realtimeSession';
import { RealtimeAgent } from '../src/realtimeAgent';
import type { RealtimeItem } from '../src/items';
import { FakeTransport, fakeModelMessage } from './stubs';
import * as guardrailModule from '../src/guardrail';
import {
  Usage,
  ModelBehaviorError,
  UserError,
  handoff,
  tool,
  type MCPServer,
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
import { z } from 'zod';
import logger from '../src/logger';
import { waitForEvent } from './realtimeSessionTestUtils';

function createMessage(id: string, text: string): RealtimeItem {
  return {
    itemId: id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }],
  } as RealtimeItem;
}

class FakeMCPServer implements MCPServer {
  cacheToolsList = false;
  name = 'test-mcp-server';

  connect = vi.fn(async () => {});
  close = vi.fn(async () => {});
  invalidateToolsCache = vi.fn(async () => {});
  callTool = vi.fn(async () => [{ type: 'text', text: 'ok' }] as any);
  listTools: MCPServer['listTools'] = vi.fn(async () => [
    {
      name: 'lookup_account',
      description: 'Look up an account',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
        additionalProperties: false,
      },
    },
  ]);
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

  it('rejects programmatic function tools before connecting', async () => {
    const execute = vi.fn(async () => 'should not run');
    const programmaticTool = tool({
      name: 'program_only',
      description: 'Only callable from a program.',
      parameters: z.object({}),
      allowedCallers: ['programmatic'],
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'Programmatic tool agent',
      tools: [programmaticTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });

    await expect(localSession.connect({ apiKey: 'test' })).rejects.toThrow(
      "Realtime does not support function tool 'program_only' with allowedCallers including 'programmatic'. Programmatic Tool Calling is only supported with the Responses API.",
    );
    expect(localTransport.connectCalls).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate function tool and handoff names before connecting', async () => {
    const targetAgent = new RealtimeAgent({ name: 'Billing' });
    const duplicateTool = tool({
      name: 'transfer_to_Billing',
      description: 'Conflicts with the billing handoff.',
      parameters: z.object({}),
      execute: async () => 'function tool',
    });
    const sourceAgent = new RealtimeAgent({
      name: 'Triage',
      tools: [duplicateTool],
      handoffs: [targetAgent],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });

    await expect(localSession.connect({ apiKey: 'test' })).rejects.toThrow(
      new UserError(
        "Duplicate Realtime tool name found: 'transfer_to_Billing' (function tool and handoff). Realtime function tool and handoff names must be unique. Rename one of them before starting the session.",
      ),
    );
    expect(localTransport.connectCalls).toHaveLength(0);
  });

  it('reports duplicate same-kind Realtime tool names deterministically', async () => {
    const duplicateOne = tool({
      name: 'lookup',
      description: 'First lookup tool.',
      parameters: z.object({}),
      execute: async () => 'first',
    });
    const duplicateTwo = tool({
      name: 'lookup',
      description: 'Second lookup tool.',
      parameters: z.object({}),
      execute: async () => 'second',
    });
    const firstTarget = new RealtimeAgent({ name: 'First' });
    const secondTarget = new RealtimeAgent({ name: 'Second' });
    const sourceAgent = new RealtimeAgent({
      name: 'Triage',
      tools: [duplicateOne, duplicateTwo],
      handoffs: [
        handoff(firstTarget, { toolNameOverride: 'delegate' }),
        handoff(secondTarget, { toolNameOverride: 'delegate' }),
      ],
    });
    const localSession = new RealtimeSession(sourceAgent, {
      transport: new FakeTransport(),
    });

    await expect(localSession.connect({ apiKey: 'test' })).rejects.toThrow(
      "Duplicate Realtime tool names found: 'delegate' (2 handoffs), 'lookup' (2 function tools)",
    );
  });

  it('ignores disabled tools when validating Realtime tool names', async () => {
    const targetAgent = new RealtimeAgent({ name: 'Billing' });
    const disabledTool = tool({
      name: 'transfer_to_Billing',
      description: 'Disabled conflicting tool.',
      parameters: z.object({}),
      isEnabled: false,
      execute: async () => 'disabled',
    });
    const sourceAgent = new RealtimeAgent({
      name: 'Triage',
      tools: [disabledTool],
      handoffs: [targetAgent],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });

    await localSession.connect({ apiKey: 'test' });

    expect(localTransport.connectCalls).toHaveLength(1);
    expect(
      localTransport.connectCalls[0]?.initialSessionConfig?.tools,
    ).toHaveLength(1);
  });

  it('dispatches delayed sibling calls against the source response snapshot', async () => {
    const sourceExecute = vi.fn(async () => 'source tool output');
    const targetExecute = vi.fn(async () => 'target tool output');
    const originalTool = tool({
      name: 'finish_original_work',
      description: 'Finish work owned by the original agent.',
      parameters: z.object({}),
      execute: sourceExecute,
    });
    const targetTool = tool({
      name: 'finish_original_work',
      description: 'A same-named tool owned by the target agent.',
      parameters: z.object({}),
      execute: targetExecute,
    });
    const targetAgent = new RealtimeAgent({
      name: 'Billing',
      tools: [targetTool],
    });
    const sourceAgent = new RealtimeAgent({
      name: 'Triage',
      tools: [originalTool],
      handoffs: [targetAgent],
    });
    const sourceToolStart = vi.fn();
    const targetToolStart = vi.fn();
    sourceAgent.on('agent_tool_start', sourceToolStart);
    targetAgent.on('agent_tool_start', targetToolStart);
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    localTransport.emit('turn_started', {
      type: 'response_started',
      providerData: { response: { id: 'source-response' } },
    });
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'transfer_to_Billing',
      callId: 'handoff-call',
      arguments: '{}',
      responseId: 'source-response',
    } as any);

    await vi.waitFor(() => {
      expect(localSession.currentAgent).toBe(targetAgent);
    });

    localTransport.emit('turn_started', {
      type: 'response_started',
      providerData: { response: { id: 'target-response' } },
    });
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'finish_original_work',
      callId: 'tool-call',
      arguments: '{}',
      responseId: 'source-response',
    } as any);

    await vi.waitFor(() => {
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(2);
    });

    expect(localSession.currentAgent).toBe(targetAgent);
    expect(sourceExecute).toHaveBeenCalledTimes(1);
    expect(targetExecute).not.toHaveBeenCalled();
    expect(sourceToolStart).toHaveBeenCalledTimes(1);
    expect(targetToolStart).not.toHaveBeenCalled();
    expect(
      localTransport.sendFunctionCallOutputCalls.map(
        ([toolCall]) => toolCall.callId,
      ),
    ).toEqual(expect.arrayContaining(['handoff-call', 'tool-call']));

    const errors: unknown[] = [];
    localSession.on('error', (event) => errors.push(event.error));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'finish_original_work',
      callId: 'missing-response-id-call',
      arguments: '{}',
    } as any);

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]).toEqual(
      new ModelBehaviorError(
        'Realtime function call is missing a responseId and cannot be dispatched safely.',
      ),
    );
    expect(sourceExecute).toHaveBeenCalledTimes(1);
    expect(targetExecute).not.toHaveBeenCalled();
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it('resumes an approved tool call with its original agent snapshot', async () => {
    const execute = vi.fn(async () => 'approved original output');
    const approvalTool = tool({
      name: 'approve_original_work',
      description: 'Run work after approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute,
    });
    const targetAgent = new RealtimeAgent({ name: 'Billing' });
    const sourceAgent = new RealtimeAgent({
      name: 'Triage',
      tools: [approvalTool],
      handoffs: [targetAgent],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'approve_original_work',
      callId: 'approval-call',
      arguments: '{}',
      responseId: 'approval-response',
    } as any);
    const [, approvalAgent, approvalPayload] = await approvalRequest;

    const handoffOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'transfer_to_Billing',
      callId: 'approval-handoff-call',
      arguments: '{}',
      responseId: 'approval-response',
    } as any);
    await handoffOutput;
    expect(localSession.currentAgent).toBe(targetAgent);

    const toolOutput = localTransport.waitForNextFunctionCallOutput();
    await localSession.approve(approvalPayload.approvalItem);
    const [toolCall, output] = await toolOutput;

    expect(approvalAgent).toBe(sourceAgent);
    expect(toolCall.callId).toBe('approval-call');
    expect(output).toBe('approved original output');
    expect(execute).toHaveBeenCalledTimes(1);
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

  it('connects with MCP tools when tracing is disabled', async () => {
    const mcpServer = new FakeMCPServer();
    const agent = new RealtimeAgent({
      name: 'MCP',
      handoffs: [],
      mcpServers: [mcpServer],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, {
      transport: t,
      tracingDisabled: true,
    });

    await expect(s.connect({ apiKey: 'test' })).resolves.toBeUndefined();

    expect(mcpServer.listTools).toHaveBeenCalledTimes(1);
    expect(t.connectCalls[0]?.initialSessionConfig?.tracing).toBeNull();
    expect(t.connectCalls[0]?.initialSessionConfig?.tools).toEqual([
      expect.objectContaining({
        name: 'lookup_account',
        type: 'function',
      }),
    ]);
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

  it('forwards raw transport payloads unchanged', async () => {
    const payload = {
      type: 'conversation.created',
      event_id: 'evt_known',
      conversation: {
        id: 'conv_1',
        provider_nested: { value: true },
      },
      provider_top_level: 123,
    };
    const forwardedEvent = waitForEvent<[typeof payload]>(
      session,
      'transport_event',
    );

    transport.emit('*', payload);

    await expect(forwardedEvent).resolves.toEqual([payload]);
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

  it('rejects invalid realtime pre-approval input guardrail config', () => {
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    expect(
      () =>
        new RealtimeSession(agent, {
          transport: new FakeTransport(),
          toolExecution: { preApprovalInputGuardrails: 'yes' as any },
        }),
    ).toThrow(
      'toolExecution.preApprovalInputGuardrails must be a boolean when provided.',
    );
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

  it('does not duplicate event handlers when reconnecting', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    const historyUpdatedListener = vi.fn();

    s.on('history_updated', historyUpdatedListener);

    await s.connect({ apiKey: 'test' });
    await s.connect({ apiKey: 'test' });

    historyUpdatedListener.mockClear();

    t.emit('item_update', createMessage('1', 'hi'));

    expect(historyUpdatedListener).toHaveBeenCalledTimes(1);
    expect(s.history).toEqual([createMessage('1', 'hi')]);
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

    const guardrailTripped = waitForEvent<any[]>(session, 'guardrail_tripped');
    transport.emit('turn_done', {
      response: {
        output: [fakeModelMessage('bad output')],
        usage: new Usage(),
      },
    } as any);
    const [, , , details] = await guardrailTripped;
    expect(transport.interruptCalls).toBe(1);
    expect(transport.sendMessageCalls.at(-1)?.[0]).toContain('blocked');
    expect(details).toEqual({ itemId: '123' });
    vi.restoreAllMocks();
  });

  it('derives text response ownership from deltas for generic start events', async () => {
    const runMock = vi.fn(async (_args: any) => ({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo: { r: 'bad' } },
    }));
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    const localTransport = new FakeTransport();
    const sourceAgent = new RealtimeAgent({ name: 'Source', handoffs: [] });
    const newerAgent = new RealtimeAgent({ name: 'Newer', handoffs: [] });
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
      outputGuardrails: [
        {
          name: 'test',
          execute: async () => ({ tripwireTriggered: true }),
        } as any,
      ],
      outputGuardrailSettings: { debounceTextLength: 3 },
    });
    await localSession.connect({ apiKey: 'test' });

    localTransport.emit('turn_started', {
      type: 'response_started',
    });
    await localSession.updateAgent(newerAgent);
    const guardrailTripped = waitForEvent<any[]>(
      localSession,
      'guardrail_tripped',
    );
    localTransport.emit('output_text_delta', {
      type: 'output_text_delta',
      delta: 'bad',
      itemId: 'item-1',
      responseId: 'response-1',
    });

    const [, eventAgent, , details] = await guardrailTripped;
    expect(eventAgent).toBe(sourceAgent);
    expect(details).toEqual({ itemId: 'item-1' });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0].agent).toBe(sourceAgent);
    expect(localTransport.sendEventCalls).toContainEqual({
      type: 'response.cancel',
      response_id: 'response-1',
    });
    expect(localTransport.interruptCalls).toBe(0);
    expect(localTransport.sendMessageCalls.at(-1)?.[0]).toContain('blocked');
    vi.restoreAllMocks();
  });

  it('does not let a stale text guardrail interrupt a newer response', async () => {
    const resolvers = new Map<
      string,
      (result: {
        guardrail: { name: string; version: string; policyHint: string };
        output: { tripwireTriggered: boolean; outputInfo: { text: string } };
      }) => void
    >();
    const runMock = vi.fn(
      async ({ agentOutput }: { agentOutput: unknown }) =>
        new Promise<any>((resolve) => {
          resolvers.set(String(agentOutput), resolve);
        }),
    );
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    const localTransport = new FakeTransport();
    const sourceAgent = new RealtimeAgent({ name: 'Source', handoffs: [] });
    const newerAgent = new RealtimeAgent({ name: 'Newer', handoffs: [] });
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
      outputGuardrails: [{ name: 'test', execute: async () => ({}) } as any],
      outputGuardrailSettings: { debounceTextLength: 1 },
    });
    const trippedAgents: unknown[] = [];
    localSession.on('guardrail_tripped', (_context, agent) => {
      trippedAgents.push(agent);
    });
    await localSession.connect({ apiKey: 'test' });

    localTransport.emit('turn_started', {
      type: 'response_started',
      providerData: { response: { id: 'response-a' } },
    });
    localTransport.emit('output_text_delta', {
      type: 'output_text_delta',
      delta: 'alpha',
      itemId: 'item-a',
      responseId: 'response-a',
    });
    await vi.waitFor(() => expect(resolvers.has('alpha')).toBe(true));

    await localSession.updateAgent(newerAgent);
    localTransport.emit('turn_started', {
      type: 'response_started',
      providerData: { response: { id: 'response-b' } },
    });
    localTransport.emit('output_text_delta', {
      type: 'output_text_delta',
      delta: 'bravo',
      itemId: 'item-b',
      responseId: 'response-b',
    });
    await vi.waitFor(() => expect(resolvers.has('bravo')).toBe(true));

    resolvers.get('bravo')!({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo: { text: 'bravo' } },
    });
    await vi.waitFor(() => expect(trippedAgents).toEqual([newerAgent]));
    expect(localTransport.sendEventCalls).toEqual([
      { type: 'response.cancel', response_id: 'response-b' },
    ]);
    expect(localTransport.sendMessageCalls).toHaveLength(1);

    resolvers.get('alpha')!({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo: { text: 'alpha' } },
    });
    await vi.waitFor(() =>
      expect(trippedAgents).toEqual([newerAgent, sourceAgent]),
    );
    expect(localTransport.sendEventCalls).toEqual([
      { type: 'response.cancel', response_id: 'response-b' },
    ]);
    expect(localTransport.sendMessageCalls).toHaveLength(1);
    expect(localTransport.interruptCalls).toBe(0);
    vi.restoreAllMocks();
  });

  it('ignores guardrail results from a closed connection', async () => {
    let resolveGuardrail!: (result: any) => void;
    const runMock = vi.fn(
      async () =>
        new Promise<any>((resolve) => {
          resolveGuardrail = resolve;
        }),
    );
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    const localTransport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
      outputGuardrails: [{ name: 'test', execute: async () => ({}) } as any],
      outputGuardrailSettings: { debounceTextLength: 1 },
    });
    const guardrailTripped = vi.fn();
    localSession.on('guardrail_tripped', guardrailTripped);
    await localSession.connect({ apiKey: 'test' });
    localTransport.emit('turn_started', {
      type: 'response_started',
      providerData: { response: { id: 'response-1' } },
    });
    localTransport.emit('output_text_delta', {
      type: 'output_text_delta',
      delta: 'bad',
      itemId: 'item-1',
      responseId: 'response-1',
    });
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));

    localSession.close();
    resolveGuardrail({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo: { text: 'bad' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guardrailTripped).not.toHaveBeenCalled();
    expect(localTransport.sendEventCalls).toHaveLength(0);
    expect(localTransport.sendMessageCalls).toHaveLength(0);
    expect(localTransport.interruptCalls).toBe(0);
    vi.restoreAllMocks();
  });

  it('emits assistant transcript on agent_end when a tool call follows', async () => {
    const transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'Listener' });
    const scenarioSession = new RealtimeSession(agent, { transport });
    const sessionAgentEnd = vi.fn();
    const agentAgentEnd = vi.fn();
    const transcript = 'Sure, let me get that for you. One moment.';

    scenarioSession.on('agent_end', sessionAgentEnd);
    agent.on('agent_end', agentAgentEnd);

    await scenarioSession.connect({ apiKey: 'test-key' });

    transport.emit('turn_done', {
      response: {
        id: 'resp-1',
        output: [
          {
            id: 'msg-1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_audio', transcript }],
          },
          {
            id: 'call-1',
            type: 'function_call',
            callId: 'call-1',
            name: 'getCallerPhone',
            arguments: '{}',
            status: 'completed',
          },
        ],
        usage: new Usage(),
      },
    } as any);

    expect(sessionAgentEnd).toHaveBeenCalledTimes(1);
    expect(sessionAgentEnd.mock.calls[0][2]).toBe(transcript);
    expect(agentAgentEnd).toHaveBeenCalledTimes(1);
    expect(agentAgentEnd.mock.calls[0][1]).toBe(transcript);
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
    const historyUpdated = waitForEvent<[RealtimeItem[]]>(
      scenarioSession,
      'history_updated',
    );
    transport.emit('*', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'audio-1',
      transcript: 'hello audio',
    });

    const [updatedHistory] = await historyUpdated;
    const updatedMessage = updatedHistory[0] as any;
    expect(historyEvents.at(-1)?.[0]?.content?.[0]?.transcript).toBe(
      'hello audio',
    );
    expect(updatedMessage.content[0]?.transcript).toBe('hello audio');
    expect(updatedMessage.status).toBe('completed');
  });

  it('resets guardrail debounce per transcript item', async () => {
    let guardrailRuns = 0;
    let resolveSecondRun!: () => void;
    const secondRunSeen = new Promise<void>((resolve) => {
      resolveSecondRun = resolve;
    });
    const runMock = vi.fn(async () => {
      guardrailRuns += 1;
      if (guardrailRuns === 2) {
        resolveSecondRun();
      }
      return { output: {} };
    });
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
    await secondRunSeen;
    expect(runMock).toHaveBeenCalledTimes(2);
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

    const filterSpy = vi
      .spyOn(Array.prototype, 'filter')
      .mockImplementationOnce(() => {
        throw new Error('delete');
      });
    transport.emit('item_deleted', { itemId: '1' } as any);
    expect(errors[1].error.message).toBe('delete');
    filterSpy.mockRestore();
  });

  it('does not apply a handoff that resolves after reconnecting', async () => {
    let markHandoffStarted: () => void = () => {};
    let releaseHandoff: () => void = () => {};
    const handoffStarted = new Promise<void>((resolve) => {
      markHandoffStarted = resolve;
    });
    const handoffReleased = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const targetAgent = new RealtimeAgent({ name: 'StaleHandoffTarget' });
    const delayedHandoff = handoff(targetAgent, {
      onHandoff: async () => {
        markHandoffStarted();
        await handoffReleased;
      },
    });
    const sourceAgent = new RealtimeAgent({
      name: 'StaleHandoffSource',
      handoffs: [delayedHandoff],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });
    const sessionHandoff = vi.fn();
    const sourceHandoff = vi.fn();
    localSession.on('agent_handoff', sessionHandoff);
    sourceAgent.on('agent_handoff', sourceHandoff);
    await localSession.connect({ apiKey: 'test' });

    localTransport.emit('function_call', {
      type: 'function_call',
      name: delayedHandoff.toolName,
      callId: 'stale-handoff-call',
      arguments: '{}',
      responseId: 'stale-handoff-response',
    } as any);
    await handoffStarted;

    localSession.close();
    await localSession.connect({ apiKey: 'test' });
    releaseHandoff();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(localSession.currentAgent).toBe(sourceAgent);
    expect(sessionHandoff).not.toHaveBeenCalled();
    expect(sourceHandoff).not.toHaveBeenCalled();
    expect(localTransport.updateSessionConfigCalls).toHaveLength(0);
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
  });

  it('does not apply a handoff after a handoff listener closes the session', async () => {
    const targetAgent = new RealtimeAgent({ name: 'CloseHandoffTarget' });
    const localHandoff = handoff(targetAgent);
    const sourceAgent = new RealtimeAgent({
      name: 'CloseHandoffSource',
      handoffs: [localHandoff],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });
    localSession.on('agent_handoff', () => localSession.close());
    await localSession.connect({ apiKey: 'test' });

    localTransport.emit('function_call', {
      type: 'function_call',
      name: localHandoff.toolName,
      callId: 'close-handoff-call',
      arguments: '{}',
      responseId: 'close-handoff-response',
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(localSession.currentAgent).toBe(sourceAgent);
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
  });

  it('replays a committed realtime handoff without invoking it twice', async () => {
    const targetAgent = new RealtimeAgent({ name: 'ReplayTarget' });
    const sourceAgent = new RealtimeAgent({
      name: 'ReplaySource',
      handoffs: [targetAgent],
    });
    const handoffSpy = vi.fn();
    sourceAgent.on('agent_handoff', handoffSpy);
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(sourceAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    localTransport.emit('turn_started', {
      type: 'response_started',
      providerData: { response: { id: 'handoff-replay-response' } },
    });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'transfer_to_ReplayTarget',
      callId: 'realtime-handoff-replay',
      arguments: '{}',
      responseId: 'handoff-replay-response',
    };

    const firstOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall);
    await firstOutput;
    const replayOutput = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall);
    await replayOutput;

    expect(localSession.currentAgent).toBe(targetAgent);
    expect(handoffSpy).toHaveBeenCalledTimes(1);
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(2);
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
