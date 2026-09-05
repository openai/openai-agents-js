import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeSession } from '../src/realtimeSession';
import { RealtimeAgent } from '../src/realtimeAgent';
import { FakeTransport, TEST_TOOL } from './stubs';
import {
  ModelBehaviorError,
  RunToolApprovalItem,
  tool,
  ToolGuardrailFunctionOutputFactory,
} from '@openai/agents-core';
import type { TransportToolCallEvent } from '../src/transportLayerEvents';
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
      responseId: 'direct-approval-response',
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

  it.each(['approve', 'reject'] as const)(
    'rejects a stale SDK-issued approval on %s after reconnecting',
    async (action) => {
      const execute = vi.fn(async () => 'executed');
      const approvalTool = tool({
        name: 'reconnect_approval',
        description: 'Requires approval before execution.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      });
      const agent = new RealtimeAgent({
        name: 'ReconnectApprovalAgent',
        tools: [approvalTool],
      });
      const localTransport = new FakeTransport();
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });

      const approvalRequest = waitForEvent<any[]>(
        localSession,
        'tool_approval_requested',
      );
      localTransport.emit('function_call', {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'reconnected-call',
        arguments: '{}',
        responseId: 'first-connection-response',
      } as any);
      const [, , payload] = await approvalRequest;

      localSession.close();
      await localSession.connect({ apiKey: 'test' });

      const staleDecision =
        action === 'approve'
          ? localSession.approve(payload.approvalItem)
          : localSession.reject(payload.approvalItem);
      await expect(staleDecision).rejects.toBeInstanceOf(ModelBehaviorError);
      expect(execute).not.toHaveBeenCalled();
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);

      const approvalSpy = vi.fn();
      localSession.on('tool_approval_requested', approvalSpy);
      localTransport.emit('function_call', {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'reconnected-call',
        arguments: '{}',
        responseId: 'second-connection-response',
      } as any);
      await vi.waitFor(() => expect(approvalSpy).toHaveBeenCalledTimes(1));
      expect(execute).not.toHaveBeenCalled();
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
    },
  );

  it('rejects mutated ownership on an SDK-issued function approval', async () => {
    const execute = vi.fn(async () => 'unexpected');
    const approvalTool = tool({
      name: 'mutable_owner_approval',
      description: 'Requires approval from its issuing agent.',
      parameters: z.object({}),
      needsApproval: true,
      execute,
    });
    const issuingAgent = new RealtimeAgent({
      name: 'IssuingApprovalAgent',
      tools: [approvalTool],
    });
    const replacementAgent = new RealtimeAgent({
      name: 'ReplacementApprovalAgent',
      tools: [approvalTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(issuingAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'mutable-owner-call',
      arguments: '{}',
      responseId: 'mutable-owner-response',
    } as any);
    const [, , payload] = await approvalRequest;
    (payload.approvalItem as any).agent = replacementAgent;

    await expect(
      localSession.approve(payload.approvalItem),
    ).rejects.toBeInstanceOf(ModelBehaviorError);
    expect(execute).not.toHaveBeenCalled();
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
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

    const invokeSpy = vi.spyOn(needsApprovalTool, 'invoke');

    const approvalRequest = waitForEvent<any[]>(s, 'tool_approval_requested');
    t.emit('function_call', {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-1',
      arguments: '{}',
      status: 'completed',
      responseId: 'approval-request-response',
    } as any);

    const [, , payload] = await approvalRequest;
    expect(payload.type).toBe('function_approval');
    expect(payload.tool.name).toBe('needs_approval');
    expect(t.sendFunctionCallOutputCalls.length).toBe(0);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"unsafe"'],
    ['a boolean', 'true'],
  ])(
    'requires realtime approval without invoking a dynamic policy for %s',
    async (_label, args) => {
      const needsApproval = vi.fn(async () => false);
      const execute = vi.fn(async () => 'ok');
      const guardedTool = tool({
        name: 'dynamic_approval',
        description: 'Dynamic approval tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        needsApproval,
        execute,
      });
      const agent = new RealtimeAgent({
        name: 'ApprovalAgent',
        handoffs: [],
        tools: [guardedTool],
      });
      const localTransport = new FakeTransport();
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });

      const approvalRequest = waitForEvent<any[]>(
        localSession,
        'tool_approval_requested',
      );
      localTransport.emit('function_call', {
        type: 'function_call',
        name: 'dynamic_approval',
        callId: 'invalid-approval-call',
        arguments: args,
        status: 'completed',
        responseId: 'invalid-approval-response',
      } as any);

      const [, , payload] = await approvalRequest;
      expect(payload.type).toBe('function_approval');
      expect(needsApproval).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
    },
  );

  it('fails closed for directly constructed realtime approval policies', async () => {
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async () => 'ok');
    const guardedTool = {
      ...tool({
        name: 'direct_approval',
        description: 'Direct approval tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        needsApproval: false,
        execute,
      }),
      needsApproval,
    };
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'direct_approval',
      callId: 'direct-approval-call',
      arguments: '[]',
      status: 'completed',
      responseId: 'direct-approval-response',
    } as any);

    const [, , payload] = await approvalRequest;
    expect(payload.type).toBe('function_approval');
    expect(needsApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('continues evaluating realtime approval policies for valid objects', async () => {
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async () => 'ok');
    const guardedTool = tool({
      name: 'dynamic_approval',
      description: 'Dynamic approval tool',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      needsApproval,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const output = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'dynamic_approval',
      callId: 'valid-approval-call',
      arguments: '{"safe":true}',
      status: 'completed',
      responseId: 'valid-approval-response',
    } as any);

    await output;
    expect(needsApproval).toHaveBeenCalledWith(
      localSession.context,
      { safe: true },
      'valid-approval-call',
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects malformed realtime arguments without invoking the approval policy', async () => {
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async () => 'ok');
    const guardedTool = tool({
      name: 'dynamic_approval',
      description: 'Dynamic approval tool',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      needsApproval,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'dynamic_approval',
      callId: 'malformed-rejection-call',
      arguments: '{',
      status: 'completed',
      responseId: 'malformed-rejection-response',
    } as any);
    const [, , payload] = await approvalRequest;

    await localSession.reject(payload.approvalItem);

    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(1);
    expect(needsApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('completes malformed realtime calls with a parse error after approval', async () => {
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async () => 'should not run');
    const guardedTool = tool({
      name: 'dynamic_approval',
      description: 'Dynamic approval tool',
      parameters: z.object({}),
      needsApproval,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'dynamic_approval',
      callId: 'malformed-approval-call',
      arguments: '{',
      status: 'completed',
      responseId: 'malformed-approval-response',
    } as any);
    const [, , payload] = await approvalRequest;

    await expect(localSession.approve(payload.approvalItem)).resolves.toBe(
      undefined,
    );

    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(1);
    expect(localTransport.sendFunctionCallOutputCalls[0]).toEqual([
      expect.objectContaining({ callId: 'malformed-approval-call' }),
      expect.stringContaining('Please try again with valid JSON.'),
      true,
    ]);
    expect(needsApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('completes malformed realtime calls with an existing approval decision', async () => {
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async () => 'should not run');
    const guardedTool = tool({
      name: 'dynamic_approval',
      description: 'Dynamic approval tool',
      parameters: z.object({}),
      needsApproval,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const toolCall = {
      type: 'function_call',
      name: 'dynamic_approval',
      callId: 'preapproved-malformed-call',
      arguments: '{',
      status: 'completed',
      responseId: 'preapproved-malformed-response',
    } as const;
    localSession.context.approveTool(
      new RunToolApprovalItem(toolCall as any, agent),
    );

    const output = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', toolCall as any);
    const [, result, startResponse] = await output;

    expect(result).toContain('Please try again with valid JSON.');
    expect(startResponse).toBe(true);
    expect(needsApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('honors a rejection without reevaluating a changing dynamic approval policy', async () => {
    const needsApproval = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const execute = vi.fn(async () => 'must not run');
    const guardedTool = tool({
      name: 'dynamic_approval',
      description: 'Dynamic approval tool',
      parameters: z.object({}),
      needsApproval,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'dynamic_approval',
      callId: 'changing-policy-rejection',
      arguments: '{}',
      status: 'completed',
      responseId: 'changing-policy-response',
    } as any);
    const [, , payload] = await approvalRequest;

    await localSession.reject(payload.approvalItem);

    expect(localTransport.sendFunctionCallOutputCalls).toEqual([
      [
        expect.objectContaining({ callId: 'changing-policy-rejection' }),
        'Tool execution was not approved.',
        true,
      ],
    ]);
    expect(needsApproval).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('honors approval without reevaluating a failing dynamic approval policy', async () => {
    const needsApproval = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('policy must not run after approval'));
    const execute = vi.fn(async () => 'approved output');
    const guardedTool = tool({
      name: 'dynamic_approval',
      description: 'Dynamic approval tool',
      parameters: z.object({}),
      needsApproval,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'dynamic_approval',
      callId: 'changing-policy-approval',
      arguments: '{}',
      status: 'completed',
      responseId: 'changing-policy-approval-response',
    } as any);
    const [, , payload] = await approvalRequest;

    await expect(localSession.approve(payload.approvalItem)).resolves.toBe(
      undefined,
    );

    expect(localTransport.sendFunctionCallOutputCalls).toEqual([
      [
        expect.objectContaining({ callId: 'changing-policy-approval' }),
        'approved output',
        true,
      ],
    ]);
    expect(needsApproval).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('preserves fixed realtime approval behavior for non-object arguments', async () => {
    const execute = vi.fn(async () => 'ok');
    const guardedTool = tool({
      name: 'fixed_approval',
      description: 'Fixed approval tool',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      needsApproval: false,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [guardedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });

    const output = localTransport.waitForNextFunctionCallOutput();
    localTransport.emit('function_call', {
      type: 'function_call',
      name: 'fixed_approval',
      callId: 'fixed-approval-call',
      arguments: '[]',
      status: 'completed',
      responseId: 'fixed-approval-response',
    } as any);

    await output;
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps pending approvals distinct when call IDs are missing', async () => {
    const execute = vi.fn(async ({ request }: { request: string }) => request);
    const needsApprovalTool = tool({
      name: 'needs_approval',
      description: 'Needs approval tool',
      parameters: z.object({ request: z.string() }),
      needsApproval: true,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalRequests: any[] = [];
    s.on('tool_approval_requested', (_context, _agent, request) => {
      approvalRequests.push(request);
    });
    t.emit('function_call', {
      id: 'item-1',
      type: 'function_call',
      name: 'needs_approval',
      callId: '',
      arguments: '{"request":"first"}',
      responseId: 'missing-call-id-response',
    });
    t.emit('function_call', {
      id: 'item-2',
      type: 'function_call',
      name: 'needs_approval',
      callId: '',
      arguments: '{"request":"second"}',
      responseId: 'missing-call-id-response',
    });

    await vi.waitFor(() => {
      expect(approvalRequests).toHaveLength(2);
    });
    await s.approve(approvalRequests[0].approvalItem);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ request: 'first' });
    expect(t.sendFunctionCallOutputCalls).toHaveLength(1);
    expect(t.sendFunctionCallOutputCalls[0][0]).toMatchObject({
      id: 'item-1',
      callId: 'item-1',
    });

    await s.reject(approvalRequests[1].approvalItem, {
      message: 'Second request denied',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(t.sendFunctionCallOutputCalls).toHaveLength(2);
    expect(t.sendFunctionCallOutputCalls[1][0]).toMatchObject({
      id: 'item-2',
      callId: 'item-2',
    });
    expect(t.sendFunctionCallOutputCalls[1][1]).toBe('Second request denied');
  });

  it('does not run realtime input guardrails before pending approval by default', async () => {
    const guardrailRun = vi.fn(async () =>
      ToolGuardrailFunctionOutputFactory.allow(),
    );
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
      inputGuardrails: [
        {
          name: 'approval_guardrail',
          run: guardrailRun,
        },
      ],
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

    const approvalRequest = waitForEvent<any[]>(s, 'tool_approval_requested');
    t.emit('function_call', {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-default-guardrail',
      arguments: '{}',
      status: 'completed',
      responseId: 'default-guardrail-response',
    } as any);

    await approvalRequest;
    expect(guardrailRun).not.toHaveBeenCalled();
    expect(t.sendFunctionCallOutputCalls.length).toBe(0);
  });

  it('returns realtime guardrail rejection instead of pending approval when opted in', async () => {
    const guardrailRun = vi.fn(async () =>
      ToolGuardrailFunctionOutputFactory.rejectContent(
        'blocked before approval',
      ),
    );
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
      inputGuardrails: [
        {
          name: 'approval_blocker',
          run: guardrailRun,
        },
      ],
      execute: vi.fn(async () => 'ok'),
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, {
      transport: t,
      toolExecution: { preApprovalInputGuardrails: true },
    });
    await s.connect({ apiKey: 'test' });

    const approvalSpy = vi.fn();
    s.on('tool_approval_requested', approvalSpy);
    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-pre-approval-blocked',
      arguments: '{}',
      status: 'completed',
      responseId: 'pre-approval-blocked-response',
    } as any);

    const [, output, startResponse] = await outputPromise;
    expect(output).toBe('blocked before approval');
    expect(startResponse).toBe(true);
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(guardrailRun).toHaveBeenCalledTimes(1);
  });

  it('reruns realtime input guardrails after approval when pre-approval guardrails are enabled', async () => {
    const guardrailRun = vi.fn(async () =>
      ToolGuardrailFunctionOutputFactory.allow(),
    );
    const execute = vi.fn(async () => 'ok');
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
      inputGuardrails: [
        {
          name: 'approval_double_check',
          run: guardrailRun,
        },
      ],
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, {
      transport: t,
      toolExecution: { preApprovalInputGuardrails: true },
    });
    await s.connect({ apiKey: 'test' });

    const approvalRequest = waitForEvent<any[]>(s, 'tool_approval_requested');
    t.emit('function_call', {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-pre-approval-allow',
      arguments: '{}',
      status: 'completed',
      responseId: 'pre-approval-allow-response',
    } as any);

    const [, , payload] = await approvalRequest;
    expect(guardrailRun).toHaveBeenCalledTimes(1);
    expect(t.sendFunctionCallOutputCalls.length).toBe(0);

    const outputPromise = t.waitForNextFunctionCallOutput();
    await s.approve(payload.approvalItem);
    const [, output] = await outputPromise;

    expect(output).toBe('ok');
    expect(guardrailRun).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
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
      responseId: 'approval-denied-response',
    };
    const approvalItem = new RunToolApprovalItem(toolCall as any, agent);
    s.context.rejectTool(approvalItem);
    const invokeSpy = vi.spyOn(needsApprovalTool, 'invoke');

    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', toolCall as any);

    const [, output, startResponse] = await outputPromise;
    expect(output).toBe('Tool execution was not approved.');
    expect(startResponse).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('uses toolErrorFormatter message when approval is denied', async () => {
    const customMessage = 'Tool execution was dismissed. You may retry later.';
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
    const s = new RealtimeSession(agent, {
      transport: t,
      toolErrorFormatter: () => customMessage,
    });
    await s.connect({ apiKey: 'test' });

    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-2b',
      arguments: '{}',
      responseId: 'approval-custom-message-response',
    };
    const approvalItem = new RunToolApprovalItem(toolCall as any, agent);
    s.context.rejectTool(approvalItem);
    const invokeSpy = vi.spyOn(needsApprovalTool, 'invoke');

    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', toolCall as any);

    const [, output, startResponse] = await outputPromise;
    expect(output).toBe(customMessage);
    expect(startResponse).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('does not format a rejection after a start listener closes the session', async () => {
    const formatter = vi.fn(() => 'unexpected');
    const needsApprovalTool = tool({
      name: 'close_before_rejection_formatter',
      description: 'Must not format after a synchronous close.',
      parameters: z.object({}),
      needsApproval: true,
      execute: vi.fn(async () => 'unexpected'),
    });
    const agent = new RealtimeAgent({
      name: 'CloseBeforeRejectionFormatterAgent',
      tools: [needsApprovalTool],
    });
    const transport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport,
      toolErrorFormatter: formatter,
    });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: needsApprovalTool.name,
      callId: 'close-before-rejection-formatter-call',
      arguments: '{}',
      responseId: 'close-before-rejection-formatter-response',
    };
    localSession.context.rejectTool(
      new RunToolApprovalItem(toolCall as any, agent),
    );
    localSession.on('agent_tool_start', () => localSession.close());
    await localSession.connect({ apiKey: 'test' });

    transport.emit('function_call', toolCall);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(formatter).not.toHaveBeenCalled();
    expect(transport.sendFunctionCallOutputCalls).toHaveLength(0);
  });

  it('falls back to default rejection response when toolErrorFormatter throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
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
    const s = new RealtimeSession(agent, {
      transport: t,
      toolErrorFormatter: () => {
        throw new Error('formatter failed');
      },
    });
    await s.connect({ apiKey: 'test' });

    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-2c',
      arguments: '{}',
      responseId: 'approval-formatter-error-response',
    };
    const approvalItem = new RunToolApprovalItem(toolCall as any, agent);
    s.context.rejectTool(approvalItem);
    const invokeSpy = vi.spyOn(needsApprovalTool, 'invoke');

    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', toolCall as any);

    const [, output, startResponse] = await outputPromise;
    expect(output).toBe('Tool execution was not approved.');
    expect(startResponse).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'toolErrorFormatter threw while formatting approval rejection: object',
    );
    warnSpy.mockRestore();
  });

  it('rejects changed arguments for an approved realtime call ID', async () => {
    const execute = vi.fn(async () => 'unexpected');
    const approvedTool = tool({
      name: 'realtime_approved_tool',
      description: 'Requires approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'RealtimeChangedArgumentsAgent',
      handoffs: [],
      tools: [approvedTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const approvedCall: TransportToolCallEvent = {
      type: 'function_call',
      name: approvedTool.name,
      callId: 'realtime-reused-arguments',
      arguments: '{"value":"safe"}',
      responseId: 'realtime-reused-arguments-response',
    };
    localSession.context.approveTool(
      new RunToolApprovalItem(approvedCall as any, agent),
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errorEvent = waitForEvent<any[]>(localSession, 'error');

    localTransport.emit('function_call', {
      ...approvedCall,
      arguments: '{"value":"changed"}',
    });

    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(execute).not.toHaveBeenCalled();
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('rejects changed tool identity for an approved realtime call ID', async () => {
    const firstExecute = vi.fn(async () => 'first');
    const secondExecute = vi.fn(async () => 'unexpected');
    const firstTool = tool({
      name: 'realtime_first_tool',
      description: 'Receives the approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: firstExecute,
    });
    const secondTool = tool({
      name: 'realtime_second_tool',
      description: 'Must not reuse the approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: secondExecute,
    });
    const agent = new RealtimeAgent({
      name: 'RealtimeChangedToolAgent',
      handoffs: [],
      tools: [firstTool, secondTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const approvedCall: TransportToolCallEvent = {
      type: 'function_call',
      name: firstTool.name,
      callId: 'realtime-reused-tool',
      arguments: '{}',
      responseId: 'realtime-reused-tool-response',
    };
    localSession.context.approveTool(
      new RunToolApprovalItem(approvedCall as any, agent),
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errorEvent = waitForEvent<any[]>(localSession, 'error');

    localTransport.emit('function_call', {
      ...approvedCall,
      name: secondTool.name,
    });

    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('does not reuse a realtime approval across agent ownership', async () => {
    const firstExecute = vi.fn(async () => 'first');
    const secondExecute = vi.fn(async () => 'second');
    const firstTool = tool({
      name: 'shared_realtime_tool',
      description: 'Owned by the first agent.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: firstExecute,
    });
    const secondTool = tool({
      name: 'shared_realtime_tool',
      description: 'Owned by the second agent.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: secondExecute,
    });
    const firstAgent = new RealtimeAgent({
      name: 'FirstApprovalOwner',
      handoffs: [],
      tools: [firstTool],
    });
    const secondAgent = new RealtimeAgent({
      name: 'SecondApprovalOwner',
      handoffs: [],
      tools: [secondTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(firstAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const callId = 'cross-agent-call';
    localSession.context.approveTool(
      new RunToolApprovalItem(
        {
          type: 'function_call',
          name: firstTool.name,
          callId,
          arguments: '{"value":"first"}',
        },
        firstAgent,
      ),
    );
    await localSession.updateAgent(secondAgent);
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );

    localTransport.emit('function_call', {
      type: 'function_call',
      name: secondTool.name,
      callId,
      arguments: '{"value":"changed"}',
      responseId: 'cross-agent-response',
    });

    const [, owner, payload] = await approvalRequest;
    expect(owner).toBe(secondAgent);
    expect(payload.approvalItem.agent).toBe(secondAgent);
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it('does not replace a pending realtime approval with changed arguments', async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => value);
    const approvalTool = tool({
      name: 'pending_realtime_tool',
      description: 'Requires approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'PendingApprovalAgent',
      tools: [approvalTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const safeCall: TransportToolCallEvent = {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'pending-reused-call',
      arguments: '{"value":"safe"}',
      responseId: 'pending-reused-response',
    };
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', safeCall);
    const [, , payload] = await approvalRequest;

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    localTransport.emit('function_call', {
      ...safeCall,
      arguments: '{"value":"changed"}',
    });
    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ModelBehaviorError);

    const output = localTransport.waitForNextFunctionCallOutput();
    await localSession.approve(payload.approvalItem);
    expect((await output)[1]).toBe('safe');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ value: 'safe' });
    errorSpy.mockRestore();
  });

  it('keeps same-ID pending approvals distinct across realtime agents', async () => {
    const firstExecute = vi.fn(async () => 'first output');
    const secondExecute = vi.fn(async () => 'second output');
    const firstTool = tool({
      name: 'shared_pending_tool',
      description: 'Owned by the first agent.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: firstExecute,
    });
    const secondTool = tool({
      name: 'shared_pending_tool',
      description: 'Owned by the second agent.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: secondExecute,
    });
    const firstAgent = new RealtimeAgent({
      name: 'FirstPendingOwner',
      tools: [firstTool],
    });
    const secondAgent = new RealtimeAgent({
      name: 'SecondPendingOwner',
      tools: [secondTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(firstAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const callId = 'cross-agent-pending-call';

    const firstApproval = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: firstTool.name,
      callId,
      arguments: '{"value":"first"}',
      responseId: 'first-pending-response',
    } as any);
    const [, firstOwner, firstPayload] = await firstApproval;

    await localSession.updateAgent(secondAgent);
    const secondApproval = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('function_call', {
      type: 'function_call',
      name: secondTool.name,
      callId,
      arguments: '{"value":"second"}',
      responseId: 'second-pending-response',
    } as any);
    const [, secondOwner, secondPayload] = await secondApproval;

    const firstOutput = localTransport.waitForNextFunctionCallOutput();
    await localSession.approve(firstPayload.approvalItem);
    expect((await firstOutput)[1]).toBe('first output');
    const secondOutput = localTransport.waitForNextFunctionCallOutput();
    await localSession.approve(secondPayload.approvalItem);
    expect((await secondOutput)[1]).toBe('second output');

    expect(firstOwner).toBe(firstAgent);
    expect(secondOwner).toBe(secondAgent);
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).toHaveBeenCalledTimes(1);
  });

  it('supports approving a realtime tool synchronously from the approval event', async () => {
    const execute = vi.fn(async () => 'approved output');
    const approvalTool = tool({
      name: 'synchronous_approval_tool',
      description: 'Can be approved directly from the approval event.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute,
    });
    const agent = new RealtimeAgent({
      name: 'SynchronousApprovalAgent',
      tools: [approvalTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    let approvalPromise: Promise<void> | undefined;
    localSession.on('tool_approval_requested', (_context, _agent, request) => {
      approvalPromise = localSession.approve(request.approvalItem);
    });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'synchronous-approval-call',
      arguments: '{"value":"safe"}',
      responseId: 'synchronous-approval-response',
    };

    localTransport.emit('function_call', toolCall);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await approvalPromise;
    expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(1);
    expect(localTransport.sendFunctionCallOutputCalls[0]?.[1]).toBe(
      'approved output',
    );

    localTransport.emit('function_call', toolCall);
    await vi.waitFor(() =>
      expect(localTransport.sendFunctionCallOutputCalls).toHaveLength(2),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('redacts toolErrorFormatter failures when tool-data logging is disabled', async () => {
    const secret = 'SECRET_REALTIME_FORMATTER_VALUE_123';
    const constructorGetter = vi.fn(() => {
      throw new Error('The Error constructor must not be inspected.');
    });
    const formatterError = new Error(secret);
    Object.defineProperty(formatterError, 'constructor', {
      get: constructorGetter,
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const needsApprovalTool = tool({
      name: 'needs_approval',
      description: 'Needs approval tool',
      parameters: z.object({}),
      needsApproval: true,
      execute: vi.fn(async () => 'ok'),
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
      toolErrorFormatter: () => {
        throw formatterError;
      },
    });

    try {
      await localSession.connect({ apiKey: 'test' });
      const toolCall: TransportToolCallEvent = {
        type: 'function_call',
        name: 'needs_approval',
        callId: 'call-redacted-formatter',
        arguments: '{}',
        responseId: 'approval-redacted-formatter-response',
      };
      localSession.context.rejectTool(
        new RunToolApprovalItem(toolCall as any, agent),
      );
      const outputPromise = localTransport.waitForNextFunctionCallOutput();

      localTransport.emit('function_call', toolCall as any);
      const [, output] = await outputPromise;

      expect(output).toBe('Tool execution was not approved.');
      expect(warnSpy).toHaveBeenCalledWith(
        'toolErrorFormatter threw while formatting approval rejection: object',
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
      expect(constructorGetter).not.toHaveBeenCalled();
    } finally {
      flagSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('falls back when a redacted toolErrorFormatter throws a hostile Proxy', async () => {
    const formatterError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('SECRET_PROXY_TRAP_123');
        },
      },
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const flagSpy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    const needsApprovalTool = tool({
      name: 'needs_approval',
      description: 'Needs approval tool',
      parameters: z.object({}),
      needsApproval: true,
      execute: vi.fn(async () => 'ok'),
    });
    const agent = new RealtimeAgent({
      name: 'ApprovalAgent',
      handoffs: [],
      tools: [needsApprovalTool],
    });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
      toolErrorFormatter: () => {
        throw formatterError;
      },
    });

    try {
      await localSession.connect({ apiKey: 'test' });
      const toolCall: TransportToolCallEvent = {
        type: 'function_call',
        name: 'needs_approval',
        callId: 'call-hostile-formatter',
        arguments: '{}',
        responseId: 'approval-hostile-formatter-response',
      };
      localSession.context.rejectTool(
        new RunToolApprovalItem(toolCall as any, agent),
      );
      const outputPromise = localTransport.waitForNextFunctionCallOutput();

      localTransport.emit('function_call', toolCall as any);
      const [, output] = await outputPromise;

      expect(output).toBe('Tool execution was not approved.');
      expect(warnSpy).toHaveBeenCalledWith(
        'toolErrorFormatter threw while formatting approval rejection: object',
      );
    } finally {
      flagSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('uses reject message from session.reject when provided', async () => {
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
      callId: 'call-msg-1',
      arguments: '{}',
      responseId: 'approval-reject-message-response',
    };

    const approvalRequest = waitForEvent<any[]>(s, 'tool_approval_requested');
    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', toolCall as any);

    const [, , payload] = await approvalRequest;
    await s.reject(payload.approvalItem, { message: 'Blocked by admin' });

    const [, output] = await outputPromise;
    expect(output).toBe('Blocked by admin');
  });

  it('reuses alwaysReject messages for later realtime tool calls', async () => {
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

    const approvalSpy = vi.fn();
    s.on('tool_approval_requested', approvalSpy);

    const firstToolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-sticky-1',
      arguments: '{}',
      responseId: 'approval-sticky-response',
    };
    const firstApprovalRequest = waitForEvent<any[]>(
      s,
      'tool_approval_requested',
    );
    const firstOutputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', firstToolCall as any);

    const [, , firstPayload] = await firstApprovalRequest;
    await s.reject(firstPayload.approvalItem, {
      alwaysReject: true,
      message: 'Blocked by policy',
    });

    const [, firstOutput] = await firstOutputPromise;
    expect(firstOutput).toBe('Blocked by policy');

    const secondOutputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', {
      ...firstToolCall,
      callId: 'call-sticky-2',
    } as any);

    const [, secondOutput] = await secondOutputPromise;
    expect(secondOutput).toBe('Blocked by policy');
    expect(approvalSpy).toHaveBeenCalledTimes(1);
  });

  it('reject message takes precedence over toolErrorFormatter', async () => {
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
    const s = new RealtimeSession(agent, {
      transport: t,
      toolErrorFormatter: () => 'formatter message',
    });
    await s.connect({ apiKey: 'test' });

    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-msg-2',
      arguments: '{}',
      responseId: 'approval-message-precedence-response',
    };
    const approvalItem = new RunToolApprovalItem(toolCall as any, agent);
    s.context.rejectTool(approvalItem, { message: 'per-call message' });

    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', toolCall as any);

    const [, output] = await outputPromise;
    expect(output).toBe('per-call message');
  });

  it('uses an empty reject message when provided', async () => {
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
    const s = new RealtimeSession(agent, {
      transport: t,
      toolErrorFormatter: () => 'formatter message',
    });
    await s.connect({ apiKey: 'test' });

    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'call-msg-3',
      arguments: '{}',
      responseId: 'approval-empty-message-response',
    };
    const approvalItem = new RunToolApprovalItem(toolCall as any, agent);
    s.context.rejectTool(approvalItem, { message: '' });

    const outputPromise = t.waitForNextFunctionCallOutput();
    t.emit('function_call', toolCall as any);

    const [, output] = await outputPromise;
    expect(output).toBe('');
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

  it('rejects hosted tool calls without an MCP reason when no message is provided', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'hosted_mcp',
        arguments: JSON.stringify({ foo: 'bar' }),
        status: 'in_progress',
        providerData: {
          itemId: 'item-default-1',
          serverLabel: 'server-default-1',
        },
      } as any,
      agent,
    );

    await s.reject(approvalItem);

    expect(t.sendMcpResponseCalls.length).toBe(1);
    expect(t.sendMcpResponseCalls[0][1]).toBe(false);
    expect(t.sendMcpResponseCalls[0][2]).toBeUndefined();
  });

  it('does not pass toolErrorFormatter output into hosted MCP reasons', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const formatter = vi.fn(() => 'Formatter denial');
    const s = new RealtimeSession(agent, {
      transport: t,
      toolErrorFormatter: formatter,
    });
    await s.connect({ apiKey: 'test' });

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'hosted_mcp',
        arguments: JSON.stringify({ foo: 'bar' }),
        status: 'in_progress',
        providerData: {
          itemId: 'item-formatter-1',
          serverLabel: 'server-formatter-1',
        },
      } as any,
      agent,
    );

    await s.reject(approvalItem);

    expect(t.sendMcpResponseCalls.length).toBe(1);
    expect(t.sendMcpResponseCalls[0][1]).toBe(false);
    expect(t.sendMcpResponseCalls[0][2]).toBeUndefined();
    expect(formatter).not.toHaveBeenCalled();
  });

  it('passes explicit reject messages through for hosted tool calls', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'hosted_mcp',
        arguments: JSON.stringify({ foo: 'bar' }),
        status: 'in_progress',
        providerData: {
          itemId: 'item-msg-1',
          serverLabel: 'server-msg-1',
        },
      } as any,
      agent,
    );

    await s.reject(approvalItem, { message: 'Denied by policy' });

    expect(t.sendMcpResponseCalls.length).toBe(1);
    expect(t.sendMcpResponseCalls[0][1]).toBe(false);
    expect(t.sendMcpResponseCalls[0][2]).toBe('Denied by policy');
    expect(t.sendMcpResponseCalls[0][0]).toMatchObject({
      type: 'mcp_approval_request',
      itemId: 'item-msg-1',
      serverLabel: 'server-msg-1',
      name: 'hosted_mcp',
      arguments: { foo: 'bar' },
      approved: null,
    });
    expect(
      s.context.getRejectionMessage('hosted_mcp', 'item-msg-1'),
    ).toBeUndefined();
  });

  it('reuses stored reject messages for hosted tool calls', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'hosted_mcp',
        arguments: JSON.stringify({ foo: 'bar' }),
        status: 'in_progress',
        providerData: {
          itemId: 'item-stored-1',
          serverLabel: 'server-stored-1',
        },
      } as any,
      agent,
    );

    s.context.rejectTool(approvalItem, { message: 'Denied by wrapper' });
    await s.reject(approvalItem);

    expect(t.sendMcpResponseCalls.length).toBe(1);
    expect(t.sendMcpResponseCalls[0][1]).toBe(false);
    expect(t.sendMcpResponseCalls[0][2]).toBe('Denied by wrapper');
  });

  it('emits tool approval requests for MCP approvals', async () => {
    const agent = new RealtimeAgent({ name: 'MCP', handoffs: [] });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const approvalRequest = waitForEvent<any[]>(s, 'tool_approval_requested');
    t.emit('mcp_approval_request', {
      itemId: 'item-3',
      type: 'mcp_approval_request',
      serverLabel: 'server-3',
      name: 'mcp_tool',
      arguments: { foo: 'bar' },
      approved: null,
    });

    const [, , payload] = await approvalRequest;
    expect(payload.type).toBe('mcp_approval_request');
    expect(payload.approvalItem.rawItem.type).toBe('hosted_tool_call');
    expect(payload.approvalItem.rawItem.providerData).toMatchObject({
      itemId: 'item-3',
      serverLabel: 'server-3',
    });
  });

  it('binds SDK-issued MCP approvals to immutable invocation data', async () => {
    const agent = new RealtimeAgent({ name: 'Bound MCP' });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('mcp_approval_request', {
      itemId: 'bound-mcp-approval',
      type: 'mcp_approval_request',
      serverLabel: 'server',
      name: 'lookup',
      arguments: { account: '123' },
      approved: null,
    });
    const [, , payload] = await approvalRequest;
    (payload.approvalItem.rawItem as any).arguments = '{"account":"changed"}';

    await expect(
      localSession.approve(payload.approvalItem),
    ).rejects.toBeInstanceOf(ModelBehaviorError);
    expect(localTransport.sendMcpResponseCalls).toHaveLength(0);
  });

  it.each(['approve', 'reject'] as const)(
    'binds reconstructed SDK-issued MCP approvals on %s',
    async (action) => {
      const agent = new RealtimeAgent({ name: 'Reconstructed MCP approval' });
      const localTransport = new FakeTransport();
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });
      const approvalRequest = waitForEvent<any[]>(
        localSession,
        'tool_approval_requested',
      );
      localTransport.emit('mcp_approval_request', {
        itemId: `reconstructed-mcp-${action}`,
        type: 'mcp_approval_request',
        serverLabel: 'server',
        name: 'lookup',
        arguments: { account: '123' },
        approved: null,
      });
      const [, , payload] = await approvalRequest;
      const original = payload.approvalItem as RunToolApprovalItem;
      const exactApproval = new RunToolApprovalItem(
        {
          ...original.rawItem,
          providerData: { ...original.rawItem.providerData },
        } as any,
        agent,
        original.toolName,
      );
      const changedApproval = new RunToolApprovalItem(
        {
          ...original.rawItem,
          arguments: '{"account":"changed"}',
          providerData: { ...original.rawItem.providerData },
        } as any,
        agent,
        original.toolName,
      );

      const changedDecision =
        action === 'approve'
          ? localSession.approve(changedApproval)
          : localSession.reject(changedApproval);
      await expect(changedDecision).rejects.toBeInstanceOf(ModelBehaviorError);
      expect(localTransport.sendMcpResponseCalls).toHaveLength(0);

      const exactDecision =
        action === 'approve'
          ? localSession.approve(exactApproval)
          : localSession.reject(exactApproval);
      await expect(exactDecision).resolves.toBeUndefined();
      const repeatedDecision =
        action === 'approve'
          ? localSession.approve(exactApproval)
          : localSession.reject(exactApproval);
      await expect(repeatedDecision).resolves.toBeUndefined();
      expect(localTransport.sendMcpResponseCalls).toHaveLength(1);
      expect(localTransport.sendMcpResponseCalls[0]?.[1]).toBe(
        action === 'approve',
      );
    },
  );

  it('fails changed MCP ID reuse and suppresses exact repeats', async () => {
    const agent = new RealtimeAgent({ name: 'MCP replay binding' });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    const approvalSpy = vi.fn();
    localSession.on('tool_approval_requested', approvalSpy);
    await localSession.connect({ apiKey: 'test' });
    const request = {
      itemId: 'reused-mcp-approval',
      type: 'mcp_approval_request' as const,
      serverLabel: 'server',
      name: 'lookup',
      arguments: { account: '123' },
      approved: null,
    };
    const approvalRequest = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('mcp_approval_request', request);
    const [, , payload] = await approvalRequest;

    localTransport.emit('mcp_approval_request', request);
    expect(approvalSpy).toHaveBeenCalledTimes(1);

    const errorEvent = waitForEvent<any[]>(localSession, 'error');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    localTransport.emit('mcp_approval_request', {
      ...request,
      arguments: { account: 'changed' },
    });
    const [error] = await errorEvent;
    expect(error.error).toBeInstanceOf(ModelBehaviorError);
    expect(approvalSpy).toHaveBeenCalledTimes(1);

    await localSession.approve(payload.approvalItem);
    await localSession.approve(payload.approvalItem);
    expect(localTransport.sendMcpResponseCalls).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('keeps same-ID MCP approvals distinct across realtime agents', async () => {
    const firstAgent = new RealtimeAgent({ name: 'First MCP owner' });
    const secondAgent = new RealtimeAgent({ name: 'Second MCP owner' });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(firstAgent, {
      transport: localTransport,
    });
    await localSession.connect({ apiKey: 'test' });
    const callId = 'cross-agent-mcp-approval';

    const firstApproval = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('mcp_approval_request', {
      itemId: callId,
      type: 'mcp_approval_request',
      serverLabel: 'first-server',
      name: 'first_lookup',
      arguments: { account: 'first' },
      approved: null,
    });
    const [, firstOwner, firstPayload] = await firstApproval;

    await localSession.updateAgent(secondAgent);
    const secondApproval = waitForEvent<any[]>(
      localSession,
      'tool_approval_requested',
    );
    localTransport.emit('mcp_approval_request', {
      itemId: callId,
      type: 'mcp_approval_request',
      serverLabel: 'second-server',
      name: 'second_lookup',
      arguments: { account: 'second' },
      approved: null,
    });
    const [, secondOwner, secondPayload] = await secondApproval;

    expect(firstOwner).toBe(firstAgent);
    expect(secondOwner).toBe(secondAgent);
    expect(firstPayload.approvalItem.agent).toBe(firstAgent);
    expect(secondPayload.approvalItem.agent).toBe(secondAgent);

    await localSession.approve(firstPayload.approvalItem);
    await localSession.approve(secondPayload.approvalItem);
    expect(localTransport.sendMcpResponseCalls).toHaveLength(2);
  });

  it.each(['approve', 'reject'] as const)(
    'keeps an SDK-issued MCP approval retryable when %s response sending fails',
    async (action) => {
      const agent = new RealtimeAgent({ name: 'MCP response retry' });
      const localTransport = new FakeTransport();
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });
      const approvalRequest = waitForEvent<any[]>(
        localSession,
        'tool_approval_requested',
      );
      localTransport.emit('mcp_approval_request', {
        itemId: `retry-mcp-${action}`,
        type: 'mcp_approval_request',
        serverLabel: 'server',
        name: 'lookup',
        arguments: { account: '123' },
        approved: null,
      });
      const [, , payload] = await approvalRequest;
      vi.spyOn(localTransport, 'sendMcpResponse').mockImplementationOnce(() => {
        throw new Error('transport disconnected');
      });

      const firstDecision =
        action === 'approve'
          ? localSession.approve(payload.approvalItem)
          : localSession.reject(payload.approvalItem);
      await expect(firstDecision).rejects.toThrow('transport disconnected');
      expect(localTransport.sendMcpResponseCalls).toHaveLength(0);

      const retryDecision =
        action === 'approve'
          ? localSession.approve(payload.approvalItem)
          : localSession.reject(payload.approvalItem);
      await expect(retryDecision).resolves.toBeUndefined();
      expect(localTransport.sendMcpResponseCalls).toHaveLength(1);
      expect(localTransport.sendMcpResponseCalls[0]?.[1]).toBe(
        action === 'approve',
      );
    },
  );

  it.each(['approve', 'reject'] as const)(
    'suppresses synchronous reentry while sending an MCP %s response',
    async (action) => {
      const agent = new RealtimeAgent({ name: 'MCP response reentry' });
      const localTransport = new FakeTransport();
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });
      const approvalRequest = waitForEvent<any[]>(
        localSession,
        'tool_approval_requested',
      );
      localTransport.emit('mcp_approval_request', {
        itemId: `reentrant-mcp-${action}`,
        type: 'mcp_approval_request',
        serverLabel: 'server',
        name: 'lookup',
        arguments: { account: '123' },
        approved: null,
      });
      const [, , payload] = await approvalRequest;
      let nestedDecision: Promise<void> | undefined;
      const sendSpy = vi
        .spyOn(localTransport, 'sendMcpResponse')
        .mockImplementation((request, approved, reason) => {
          localTransport.sendMcpResponseCalls.push([request, approved, reason]);
          nestedDecision =
            action === 'approve'
              ? localSession.approve(payload.approvalItem)
              : localSession.reject(payload.approvalItem);
        });

      const decision =
        action === 'approve'
          ? localSession.approve(payload.approvalItem)
          : localSession.reject(payload.approvalItem);
      await expect(decision).resolves.toBeUndefined();
      await expect(nestedDecision).resolves.toBeUndefined();
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(localTransport.sendMcpResponseCalls).toHaveLength(1);
    },
  );

  it.each(['approve', 'reject'] as const)(
    'rejects a stale SDK-issued MCP approval on %s after reconnecting',
    async (action) => {
      const agent = new RealtimeAgent({ name: 'MCP reconnect' });
      const localTransport = new FakeTransport();
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });
      const approvalRequest = waitForEvent<any[]>(
        localSession,
        'tool_approval_requested',
      );
      localTransport.emit('mcp_approval_request', {
        itemId: 'stale-mcp-approval',
        type: 'mcp_approval_request',
        serverLabel: 'server',
        name: 'lookup',
        arguments: { account: '123' },
        approved: null,
      });
      const [, , payload] = await approvalRequest;

      localSession.close();
      await localSession.connect({ apiKey: 'test' });

      const staleDecision =
        action === 'approve'
          ? localSession.approve(payload.approvalItem)
          : localSession.reject(payload.approvalItem);
      await expect(staleDecision).rejects.toBeInstanceOf(ModelBehaviorError);
      expect(localTransport.sendMcpResponseCalls).toHaveLength(0);
    },
  );

  it('ignores MCP approval requests after the session is closed', async () => {
    const agent = new RealtimeAgent({ name: 'Closed MCP' });
    const localTransport = new FakeTransport();
    const localSession = new RealtimeSession(agent, {
      transport: localTransport,
    });
    const approvalSpy = vi.fn();
    localSession.on('tool_approval_requested', approvalSpy);
    await localSession.connect({ apiKey: 'test' });
    localSession.close();

    localTransport.emit('mcp_approval_request', {
      itemId: 'closed-mcp-approval',
      type: 'mcp_approval_request',
      serverLabel: 'server',
      name: 'lookup',
      arguments: {},
      approved: null,
    });

    expect(approvalSpy).not.toHaveBeenCalled();
  });
});
