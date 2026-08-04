import { describe, it, expect, vi } from 'vitest';
import {
  RunState,
  buildAgentMap,
  deserializeModelResponse,
  deserializeItem,
  rehydrateProcessedResponseTools,
  CURRENT_SCHEMA_VERSION,
} from '../src/runState';
import { processedResponseRequiresExecutionToolRehydration } from '../src/sandbox/runtime/toolRehydration';
import { RunContext } from '../src/runContext';
import { Agent } from '../src/agent';
import { handoff } from '../src/handoff';
import { Usage } from '../src/usage';
import type { ModelResponse } from '../src/model';
import { processModelResponseAsync } from '../src/runner/modelOutputs';
import {
  RunToolApprovalItem as ToolApprovalItem,
  RunCompactionItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunHandoffOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../src/items';
import {
  attachClientToolSearchExecutor,
  applyPatchTool,
  computerTool,
  hostedMcpTool,
  shellTool,
  tool,
  toolNamespace,
  type Tool,
} from '../src/tool';
import * as protocol from '../src/types/protocol';
import {
  TEST_MODEL_MESSAGE,
  FakeComputer,
  FakeShell,
  FakeEditor,
} from './stubs';
import { RunResult } from '../src/result';
import { UserError } from '../src/errors';
import logger from '../src/logger';
import { createAgentSpan } from '../src/tracing';
import { getGlobalTraceProvider } from '../src/tracing/provider';
import type { MCPServer, MCPTool } from '../src/mcp';
import { SANDBOX_SESSION_STATE_VERSION, SandboxAgent } from '../src/sandbox';
import { prepareModelInputItems } from '../src/runner/items';
import { processModelResponse } from '../src/runner/modelOutputs';
import { MemorySession } from '../src/memory/memorySession';
import {
  prepareInputItemsWithSession,
  saveToSession,
} from '../src/runner/sessionPersistence';
import {
  getFunctionToolStateKey,
  getFunctionToolStateKeyForCall,
} from '../src/toolIdentity';
import { z, ZodError } from 'zod';
import { allowConsole } from '../../../helpers/tests/console-guard';
type AliasTestKeys = {
  crmAlias: string;
  crmCanonical: string;
  salesAlias: string;
  salesCanonical: string;
};

function sandboxSessionStateEnvelope(
  providerState: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): any {
  return {
    version: SANDBOX_SESSION_STATE_VERSION,
    backendId: 'unix-local',
    manifest: {
      version: 1,
      root: '/workspace',
      entries: {},
      environment: {},
    },
    workspaceReady: true,
    providerState,
    ...overrides,
  };
}

describe('RunState', () => {
  it('initializes with default values', () => {
    const context = new RunContext({ foo: 'bar' });
    const agent = new Agent({ name: 'TestAgent' });
    const state = new RunState(context, 'input', agent, 3);

    expect(state._currentTurn).toBe(0);
    expect(state._currentAgent).toBe(agent);
    expect(state._originalInput).toBe('input');
    expect(state._maxTurns).toBe(3);
    expect(state._noActiveAgentRun).toBe(true);
    expect(state._modelResponses).toEqual([]);
    expect(state._generatedItems).toEqual([]);
    expect(state._currentStep).toBeUndefined();
    expect(state._trace).toBeNull();
    expect(state._context.context).toEqual({ foo: 'bar' });
    expect(state._toolInputGuardrailResults).toEqual([]);
    expect(state._toolOutputGuardrailResults).toEqual([]);
  });

  it('clears restored trace state', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'TraceClearingAgent' });
    const state = new RunState(context, 'input', agent, 1);
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);

    try {
      const trace = provider.createTrace({
        traceId: 'trace_original',
        name: 'Original workflow',
      });
      const span = provider.createSpan(
        { data: { type: 'agent', name: 'OriginalSpan' } },
        trace,
      );
      state._trace = trace;
      state._currentAgentSpan = span;

      state.clearTrace();

      expect(state._trace).toBeNull();
      expect(state._currentAgentSpan).toBeUndefined();
      const json = state.toJSON();
      expect(json.trace).toBeNull();
      expect(json.currentAgentSpan).toBeUndefined();
    } finally {
      provider.setDisabled(true);
    }
  });

  it('exposes the current agent', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'CurrentAgent' });
    const state = new RunState(context, 'input', agent, 1);

    expect(state.currentAgent).toBe(agent);
  });

  it('returns history including original input and generated items', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'HistAgent' });
    const state = new RunState(context, 'input', agent, 1);
    state._generatedItems.push(
      new RunMessageOutputItem(TEST_MODEL_MESSAGE, agent),
    );

    expect(state.history).toEqual([
      { type: 'message', role: 'user', content: 'input' },
      TEST_MODEL_MESSAGE,
    ]);
  });

  it('drops orphan hosted shell calls from history', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'HistAgentShell' });
    const state = new RunState(context, 'input', agent, 1);
    state._generatedItems.push(
      new RunToolCallItem(
        {
          type: 'shell_call',
          callId: 'shell_orphan',
          status: 'completed',
          action: { commands: ['echo hi'] },
        },
        agent,
      ),
    );

    expect(state.history).toEqual([
      { type: 'message', role: 'user', content: 'input' },
    ]);
  });

  it('preserves history after serialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'HistAgent2' });
    const state = new RunState(context, 'input', agent, 1);
    state._generatedItems.push(
      new RunMessageOutputItem(TEST_MODEL_MESSAGE, agent),
    );

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored.history).toEqual(state.history);
  });

  it.each(['commentary', 'final_answer'] as const)(
    'preserves assistant phase "%s" across history and serialized model responses',
    async (phase) => {
      const context = new RunContext();
      const agent = new Agent({ name: 'AssistantPhaseAgent' });
      const state = new RunState(context, 'input', agent, 1);
      const message: protocol.AssistantMessageItem = {
        ...TEST_MODEL_MESSAGE,
        phase,
      };
      state._generatedItems.push(new RunMessageOutputItem(message, agent));
      state._modelResponses = [
        {
          usage: new Usage(),
          output: [message],
          responseId: 'response-phase',
        },
      ];

      const restored = await RunState.fromString(agent, state.toString());

      expect(restored.history[1]).toMatchObject({ phase });
      expect(restored._generatedItems[0]?.rawItem).toMatchObject({ phase });
      expect(restored._modelResponses[0]?.output[0]).toMatchObject({ phase });
      expect(restored.toJSON().$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    },
  );

  it('rejects invalid assistant message phases when restoring run state', async () => {
    const agent = new Agent({ name: 'InvalidAssistantPhaseAgent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._generatedItems.push(
      new RunMessageOutputItem(
        { ...TEST_MODEL_MESSAGE, phase: 'commentary' },
        agent,
      ),
    );
    const serialized = state.toJSON();
    (serialized.generatedItems[0]?.rawItem as any).phase = 'invalid';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow();
  });

  it('preserves reasoningItemIdPolicy after serialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'ReasoningPolicyState' });
    const state = new RunState(context, 'input', agent, 1);
    state.setReasoningItemIdPolicy('omit');
    state._generatedItems.push(
      new RunReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_state',
          content: [{ type: 'input_text', text: 'thinking' }],
        },
        agent,
      ),
    );

    const json = state.toJSON();
    expect(json.reasoningItemIdPolicy).toBe('omit');

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._reasoningItemIdPolicy).toBe('omit');
    expect(restored.history[1]).toEqual({
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    });
  });

  it('restores aggregated run usage after serialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'UsageState' });
    const state = new RunState(context, 'input', agent, 1);
    state._context.usage.add(
      new Usage({
        requests: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }),
    );

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored.usage.requests).toBe(1);
    expect(restored.usage.inputTokens).toBe(100);
    expect(restored.usage.outputTokens).toBe(50);
    expect(restored.usage.totalTokens).toBe(150);
    expect(restored.usage.requestUsageEntries).toHaveLength(1);
  });

  it('does not double-count usage when resuming with an override context', async () => {
    const agent = new Agent({ name: 'UsageOverrideState' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._context.usage.add(
      new Usage({
        requests: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }),
    );

    // The override context is authoritative (e.g. a nested agent-tool resume
    // passes the live outer context that already shares this usage), so its
    // usage must be left untouched rather than added to.
    const overrideContext = new RunContext();
    overrideContext.usage.add(
      new Usage({
        requests: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }),
    );

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      overrideContext,
    );

    expect(restored.usage.requests).toBe(1);
    expect(restored.usage.inputTokens).toBe(100);
    expect(restored.usage.outputTokens).toBe(50);
    expect(restored.usage.totalTokens).toBe(150);
  });

  it('leaves a fresh override context usage untouched', async () => {
    const agent = new Agent({ name: 'UsageFreshOverrideState' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._context.usage.add(
      new Usage({
        requests: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }),
    );

    // A caller-supplied RunContext is authoritative: even a fresh one with zero
    // usage is left untouched. Its counters do not reveal whether its Usage is
    // newly owned or shared with another run, so it does not inherit the
    // serialized usage.
    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      new RunContext(),
    );

    expect(restored.usage.requests).toBe(0);
    expect(restored.usage.inputTokens).toBe(0);
    expect(restored.usage.outputTokens).toBe(0);
    expect(restored.usage.totalTokens).toBe(0);
  });

  it('keeps a shared usage reference when resuming a forked context', async () => {
    const agent = new Agent({ name: 'UsageSharedRefState' });
    // A nested run that made no model call before interruption serializes zero
    // usage.
    const state = new RunState(new RunContext(), 'input', agent, 1);

    // A nested agent-tool resume passes a forked context that shares its usage
    // object with the outer run.
    const outer = new RunContext();
    const forked = new RunContext();
    forked.usage = outer.usage;

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      forked,
    );

    // The forked context's Usage must remain the very object shared with the
    // outer run (a replace would have severed the reference).
    expect(restored.usage).toBe(outer.usage);

    // Usage recorded after resume must still reach the outer run through the
    // shared reference (a replace would have severed it).
    forked.usage.add(
      new Usage({
        requests: 1,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      }),
    );
    expect(outer.usage.requests).toBe(1);
    expect(outer.usage.totalTokens).toBe(30);
  });

  it('preserves requestId on serialized model responses', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'RequestIdState' });
    const state = new RunState(context, 'input', agent, 1);
    state._modelResponses = [
      {
        usage: new Usage(),
        output: [TEST_MODEL_MESSAGE],
        responseId: 'resp_123',
        requestId: 'req_123',
      },
    ];
    state._lastTurnResponse = state._modelResponses[0];

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored._modelResponses).toHaveLength(1);
    expect(restored._modelResponses[0].responseId).toBe('resp_123');
    expect(restored._modelResponses[0].requestId).toBe('req_123');
    expect(restored._lastTurnResponse?.requestId).toBe('req_123');
  });

  it('preserves toolInput after serialization', async () => {
    const context = new RunContext({ foo: 'bar' });
    context.toolInput = { text: 'hola', source: 'es', target: 'en' };
    const agent = new Agent({ name: 'ToolInputAgent' });
    const state = new RunState(context, 'input', agent, 1);

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._context.toolInput).toEqual(context.toolInput);
  });

  it('serializes sandbox state with the current schema version', async () => {
    const context = new RunContext({ foo: 'bar' });
    const agent = new Agent({ name: 'SandboxStateAgent' });
    const state = new RunState(context, 'input', agent, 1);
    state._sandbox = {
      backendId: 'unix-local',
      currentAgentKey: 'sandbox-state-agent',
      currentAgentName: 'SandboxStateAgent',
      sessionState: sandboxSessionStateEnvelope(
        { workspaceId: 'ws_123' },
        {
          snapshotFingerprint: 'fp_123',
          snapshotFingerprintVersion: 'v1',
        },
      ),
      sessionsByAgent: {
        SandboxStateAgent: {
          backendId: 'unix-local',
          currentAgentKey: 'sandbox-state-agent',
          currentAgentName: 'SandboxStateAgent',
          sessionState: sandboxSessionStateEnvelope(
            { workspaceId: 'ws_123' },
            {
              snapshotFingerprint: 'fp_123',
              snapshotFingerprintVersion: 'v1',
            },
          ),
          preservedOwnedSession: true,
          reuseLiveSession: false,
        },
      },
    };

    const serialized = state.toJSON();
    expect(serialized.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(serialized.sandbox).toEqual(state._sandbox);

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    expect(restored._sandbox).toEqual(state._sandbox);

    const restoredFromSchema115 = await RunState.fromString(
      agent,
      JSON.stringify({ ...serialized, $schemaVersion: '1.15' }),
    );
    expect(restoredFromSchema115._sandbox).toEqual(state._sandbox);
  });

  it('keeps reading schema 1.8 payloads without sandbox state', async () => {
    const context = new RunContext({ foo: 'bar' });
    const agent = new Agent({ name: 'LegacySandboxStateAgent' });
    const state = new RunState(context, 'input', agent, 1);
    const serialized = state.toJSON();
    const legacyPayload = {
      ...serialized,
      $schemaVersion: '1.8' as const,
    };
    delete (legacyPayload as { sandbox?: unknown }).sandbox;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(legacyPayload),
    );

    expect(restored._sandbox).toBeUndefined();
    expect(restored._currentAgent.name).toBe('LegacySandboxStateAgent');
  });

  it('keeps reading schema 1.14 payloads with sandbox session state version 1', async () => {
    const agent = new Agent({ name: 'LegacySandboxEnvelopeAgent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._sandbox = {
      backendId: 'unix-local',
      currentAgentKey: 'LegacySandboxEnvelopeAgent',
      currentAgentName: 'LegacySandboxEnvelopeAgent',
      sessionState: sandboxSessionStateEnvelope(
        { workspaceId: 'ws_legacy' },
        { version: 1 },
      ),
      sessionsByAgent: {},
    };
    const serialized = state.toJSON();
    serialized.$schemaVersion = '1.14';

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );

    expect(restored._sandbox?.sessionState.version).toBe(1);
  });

  it('rejects sandbox session state version 2 under schema 1.14', async () => {
    const agent = new Agent({ name: 'InvalidLegacySandboxEnvelopeAgent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._sandbox = {
      backendId: 'unix-local',
      currentAgentKey: 'InvalidLegacySandboxEnvelopeAgent',
      currentAgentName: 'InvalidLegacySandboxEnvelopeAgent',
      sessionState: sandboxSessionStateEnvelope({
        workspaceId: 'ws_current',
      }),
      sessionsByAgent: {},
    };
    const serialized = state.toJSON();
    serialized.$schemaVersion = '1.14';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(
      `Run state schema version 1.14 does not support sandbox session state version ${SANDBOX_SESSION_STATE_VERSION}.`,
    );
  });

  it('does not serialize runtime-only agent-tool metadata', async () => {
    const context = new RunContext({ foo: 'bar' });
    const agentToolMetadata = {
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    };
    const agent = new Agent({ name: 'AgentToolContextAgent' });
    const state = new RunState(context, 'input', agent, 1);
    state._agentToolInvocation = agentToolMetadata;

    const serialized = state.toJSON();
    expect(serialized).not.toHaveProperty('agentToolInvocation');

    const restored = await RunState.fromString(agent, state.toString());
    expect(new RunResult(restored as any).agentToolInvocation).toBeUndefined();
  });

  it('does not infer agent-tool metadata from reused public contexts', () => {
    const agent = new Agent({ name: 'ReusedContextAgent' });
    const nestedState = new RunState(
      new RunContext({ foo: 'bar' }),
      '',
      agent,
      1,
    );
    nestedState._agentToolInvocation = {
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    };

    const nestedResult = new RunResult(nestedState as any);
    const reusedState = new RunState(
      nestedResult.runContext as RunContext<unknown>,
      'input',
      agent,
      1,
    );

    expect(reusedState._context).toBe(nestedState._context);
    expect(reusedState._agentToolInvocation).toBeUndefined();
    expect(
      new RunResult(reusedState as any).agentToolInvocation,
    ).toBeUndefined();
    expect(reusedState.toJSON()).not.toHaveProperty('agentToolInvocation');
  });

  it('keeps override context instance state when merging agent-tool runs', async () => {
    class ExtendedRunContext extends RunContext<{ foo: string }> {
      marker: string;

      constructor(context: { foo: string }, marker: string) {
        super(context);
        this.marker = marker;
      }
    }

    const agent = new Agent({ name: 'MergedAgentToolContextAgent' });
    const serializedContext = new RunContext({ foo: 'serialized' });
    serializedContext.toolInput = { input: 'stale' };
    serializedContext.approveTool(
      new ToolApprovalItem(
        {
          type: 'function_call',
          name: 'secure_tool',
          callId: 'call-1',
          status: 'completed',
          arguments: '{}',
        } as any,
        agent,
      ),
    );
    const state = new RunState(serializedContext, 'input', agent, 1);
    const overrideContext = new ExtendedRunContext(
      { foo: 'fresh' },
      'fresh-marker',
    );
    overrideContext.toolInput = { input: 'fresh' };

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      overrideContext,
      { contextStrategy: 'merge' },
    );

    expect(restored._context).toBe(overrideContext);
    expect(restored._context).toBeInstanceOf(ExtendedRunContext);
    expect((restored._context as ExtendedRunContext).marker).toBe(
      'fresh-marker',
    );
    expect(restored._context.toolInput).toEqual({ input: 'fresh' });
    expect(overrideContext.toJSON().toolInput).toEqual({ input: 'fresh' });
    expect(
      new RunResult(
        new RunState(overrideContext, 'fresh input', agent, 1) as any,
      ).agentToolInvocation,
    ).toBeUndefined();
    expect(new RunResult(restored as any).agentToolInvocation).toBeUndefined();
    expect(
      restored._context.isToolApproved({
        toolName: 'secure_tool',
        callId: 'call-1',
      }),
    ).toBe(true);
  });

  it('prefers override-context rejection messages when merge conflicts occur', async () => {
    const agent = new Agent({ name: 'MergeRejectMessageAgent' });
    const approvalItem = new ToolApprovalItem(
      {
        type: 'function_call',
        name: 'secure_tool',
        callId: 'call-1',
        status: 'completed',
        arguments: '{}',
      } as any,
      agent,
    );

    const serializedContext = new RunContext({ foo: 'serialized' });
    serializedContext.rejectTool(approvalItem, {
      alwaysReject: true,
      message: 'serialized rejection',
    });
    const state = new RunState(serializedContext, 'input', agent, 1);

    const overrideContext = new RunContext({ foo: 'fresh' });
    overrideContext.rejectTool(approvalItem, {
      alwaysReject: true,
      message: 'override rejection',
    });

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      overrideContext,
      { contextStrategy: 'merge' },
    );

    expect(restored._context).toBe(overrideContext);
    expect(restored._context.getRejectionMessage('secure_tool', 'call-1')).toBe(
      'override rejection',
    );
    expect(
      restored._context.getRejectionMessage('secure_tool', 'future-call'),
    ).toBe('override rejection');
  });

  it('lets merge override contexts clear serialized rejection messages', async () => {
    const agent = new Agent({ name: 'MergeRejectMessageClearAgent' });
    const approvalItem = new ToolApprovalItem(
      {
        type: 'function_call',
        name: 'secure_tool',
        callId: 'call-1',
        status: 'completed',
        arguments: '{}',
      } as any,
      agent,
    );

    const serializedContext = new RunContext({ foo: 'serialized' });
    serializedContext.rejectTool(approvalItem, {
      alwaysReject: true,
      message: 'serialized rejection',
    });
    const state = new RunState(serializedContext, 'input', agent, 1);

    const overrideContext = new RunContext({ foo: 'fresh' });
    overrideContext.rejectTool(approvalItem, {
      alwaysReject: true,
    });

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      overrideContext,
      { contextStrategy: 'merge' },
    );

    expect(restored._context).toBe(overrideContext);
    expect(restored._context.getRejectionMessage('secure_tool', 'call-1')).toBe(
      undefined,
    );
    expect(
      restored._context.getRejectionMessage('secure_tool', 'future-call'),
    ).toBeUndefined();
    expect(
      restored._context.isToolApproved({
        toolName: 'secure_tool',
        callId: 'future-call',
      }),
    ).toBe(false);
  });

  it('keeps override context instance state when replacing agent-tool runs', async () => {
    class ExtendedRunContext extends RunContext<{ foo: string }> {
      marker: string;

      constructor(context: { foo: string }, marker: string) {
        super(context);
        this.marker = marker;
      }
    }

    const agent = new Agent({ name: 'ReplacedAgentToolContextAgent' });
    const serializedContext = new RunContext({ foo: 'serialized' });
    serializedContext.toolInput = { input: 'stale' };
    serializedContext.approveTool(
      new ToolApprovalItem(
        {
          type: 'function_call',
          name: 'secure_tool',
          callId: 'call-1',
          status: 'completed',
          arguments: '{}',
        } as any,
        agent,
      ),
    );
    const state = new RunState(serializedContext, 'input', agent, 1);
    const overrideContext = new ExtendedRunContext(
      { foo: 'fresh' },
      'fresh-marker',
    );
    overrideContext.toolInput = { input: 'fresh' };

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      overrideContext,
      { contextStrategy: 'replace' },
    );

    expect(restored._context).toBe(overrideContext);
    expect(restored._context).toBeInstanceOf(ExtendedRunContext);
    expect((restored._context as ExtendedRunContext).marker).toBe(
      'fresh-marker',
    );
    expect(restored._context.toolInput).toEqual({ input: 'fresh' });
    expect(overrideContext.toJSON().toolInput).toEqual({ input: 'fresh' });
    expect(
      new RunResult(
        new RunState(overrideContext, 'fresh input', agent, 1) as any,
      ).agentToolInvocation,
    ).toBeUndefined();
    expect(new RunResult(restored as any).agentToolInvocation).toBeUndefined();
    expect(
      restored._context.isToolApproved({
        toolName: 'secure_tool',
        callId: 'call-1',
      }),
    ).toBeUndefined();
  });

  it('tracks pending agent tool runs using tool name and call id', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'PendingAgent' });
    const state = new RunState(context, 'input', agent, 1);

    state.setPendingAgentToolRun('toolA', 'call-1', 'state-A');
    state.setPendingAgentToolRun('toolB', 'call-1', 'state-B');

    expect(state.getPendingAgentToolRun('toolA', 'call-1')).toBe('state-A');
    expect(state.getPendingAgentToolRun('toolB', 'call-1')).toBe('state-B');

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored.getPendingAgentToolRun('toolA', 'call-1')).toBe('state-A');
    expect(restored.getPendingAgentToolRun('toolB', 'call-1')).toBe('state-B');
  });

  it('keeps pending agent tool aliases on one canonical state entry', async () => {
    const context = new RunContext();
    const namespacedLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up a CRM record.',
          parameters: z.object({}).strict(),
          execute: async () => 'lookup',
        }),
      ],
    })[0]!;
    const agent = new Agent({
      name: 'PendingAliasAgent',
      tools: [namespacedLookup],
    });
    const state = new RunState(context, 'input', agent, 1);
    const canonicalKey = getFunctionToolStateKey(namespacedLookup)!;
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc-pending-alias',
      callId: 'call-1',
      name: 'lookup',
      namespace: 'crm',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall, tool: namespacedLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['crm.lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };

    state.setPendingAgentToolRun(canonicalKey, 'call-1', 'initial-state', [
      'crm.lookup',
    ]);

    expect(state._pendingAgentToolRuns.size).toBe(1);
    expect(state.getPendingAgentToolRun('crm.lookup', 'call-1')).toBe(
      'initial-state',
    );

    state.setPendingAgentToolRun('crm.lookup', 'call-1', 'updated-state');

    expect(state._pendingAgentToolRuns.size).toBe(1);
    expect(state.getPendingAgentToolRun(canonicalKey, 'call-1')).toBe(
      'updated-state',
    );

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._pendingAgentToolRuns.size).toBe(1);
    expect(restored.getPendingAgentToolRun('crm.lookup', 'call-1')).toBe(
      'updated-state',
    );

    restored.clearPendingAgentToolRun('crm.lookup', 'call-1');

    expect(restored.hasPendingAgentToolRun(canonicalKey, 'call-1')).toBe(false);
    expect(restored.hasPendingAgentToolRun('crm.lookup', 'call-1')).toBe(false);
    expect(restored._pendingAgentToolRuns.size).toBe(0);
    expect(restored._pendingAgentToolRunAliases.size).toBe(0);
  });

  it.each([
    {
      name: 'dangling target',
      mutate: (aliases: Record<string, string>, keys: AliasTestKeys) => {
        aliases[keys.crmAlias] = `${keys.crmCanonical}:missing-call`;
      },
    },
    {
      name: 'cross-call target',
      mutate: (aliases: Record<string, string>, keys: AliasTestKeys) => {
        aliases[keys.crmAlias] = `${keys.crmCanonical}:call-2`;
      },
    },
    {
      name: 'cross-tool target',
      mutate: (aliases: Record<string, string>, keys: AliasTestKeys) => {
        aliases[keys.crmAlias] = `${keys.salesCanonical}:call-3`;
      },
    },
    {
      name: 'alias chain',
      mutate: (aliases: Record<string, string>, keys: AliasTestKeys) => {
        aliases[keys.crmAlias] = keys.salesAlias;
      },
    },
    {
      name: 'alias cycle',
      mutate: (aliases: Record<string, string>, keys: AliasTestKeys) => {
        aliases[keys.crmAlias] = keys.salesAlias;
        aliases[keys.salesAlias] = keys.crmAlias;
      },
    },
  ])('rejects a pending agent tool alias with a $name', async ({ mutate }) => {
    const [crmLookup, salesLookup] = ['crm', 'sales'].map(
      (namespace) =>
        toolNamespace({
          name: namespace,
          description: `${namespace} tools.`,
          tools: [
            tool({
              name: 'lookup',
              description: `Look up a ${namespace} record.`,
              parameters: z.object({}).strict(),
              execute: async () => namespace,
            }),
          ],
        })[0]!,
    );
    const agent = new Agent({
      name: 'Invalid pending alias agent',
      tools: [crmLookup, salesLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const crmCanonical = getFunctionToolStateKey(crmLookup)!;
    const salesCanonical = getFunctionToolStateKey(salesLookup)!;
    const createToolCall = (
      namespace: string,
      callId: string,
    ): protocol.FunctionCallItem => ({
      type: 'function_call',
      id: `fc-${namespace}-${callId}`,
      callId,
      name: 'lookup',
      namespace,
      status: 'completed',
      arguments: '{}',
    });
    state._lastProcessedResponse = {
      newItems: [],
      functions: [
        { toolCall: createToolCall('crm', 'call-1'), tool: crmLookup as any },
        { toolCall: createToolCall('crm', 'call-2'), tool: crmLookup as any },
        {
          toolCall: createToolCall('sales', 'call-3'),
          tool: salesLookup as any,
        },
      ],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['crm.lookup', 'sales.lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state.setPendingAgentToolRun(crmCanonical, 'call-1', 'crm-state', [
      'crm.lookup',
    ]);
    state.setPendingAgentToolRun(crmCanonical, 'call-2', 'crm-state-2', [
      'crm.lookup',
    ]);
    state.setPendingAgentToolRun(salesCanonical, 'call-3', 'sales-state', [
      'sales.lookup',
    ]);

    const serialized = state.toJSON();
    const aliases = serialized.pendingAgentToolRunAliases!;
    mutate(aliases, {
      crmAlias: 'crm.lookup:call-1',
      crmCanonical,
      salesAlias: 'sales.lookup:call-3',
      salesCanonical,
    });

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(
      'Run state pending agent tool aliases do not match the reconstructed pending function calls.',
    );
  });

  it('toJSON and toString produce valid JSON', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent1' });
    const state = new RunState(context, 'input1', agent, 2);
    const json = state.toJSON();
    expect(json.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(json.currentTurn).toBe(0);
    expect(json.currentAgent).toEqual({ name: 'Agent1' });
    expect(json.originalInput).toEqual('input1');
    expect(json.maxTurns).toBe(2);
    expect(json.generatedItems).toEqual([]);
    expect(json.modelResponses).toEqual([]);
    expect(json.trace).toBeNull();

    const str = state.toString();
    expect(typeof str).toBe('string');
    expect(JSON.parse(str)).toEqual(json);
  });

  it('serializes null maxTurns', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'NoMaxTurns' });
    const state = new RunState(context, 'input1', agent, null);

    const json = state.toJSON();
    expect(json.maxTurns).toBeNull();

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._maxTurns).toBeNull();
  });

  it('serializes duplicate-name agents with stable identities', async () => {
    const childA = new Agent({
      name: 'SharedSkill',
      instructions: 'alpha child',
    });
    const childB = new Agent({
      name: 'SharedSkill',
      instructions: 'bravo child',
    });
    const agentA = new Agent({ name: 'AgentA', handoffs: [childA] });
    const agentB = new Agent({ name: 'AgentB', handoffs: [childB] });
    const root = new Agent({ name: 'Root', handoffs: [agentA, agentB] });
    const state = new RunState(new RunContext(), 'input', root, 2);
    state._currentAgent = childB;

    const json = state.toJSON();

    expect(json.currentAgent).toEqual({
      name: 'SharedSkill',
      identity: 'SharedSkill#2',
    });

    const restored = await RunState.fromString(root, JSON.stringify(json));
    expect(restored._currentAgent).toBe(childB);

    const restoredFromSchema110 = await RunState.fromString(
      root,
      JSON.stringify({ ...json, $schemaVersion: '1.10' as const }),
    );
    expect(restoredFromSchema110._currentAgent).toBe(childB);

    const restoredFromSchema111 = await RunState.fromString(
      root,
      JSON.stringify({ ...json, $schemaVersion: '1.11' as const }),
    );
    expect(restoredFromSchema111._currentAgent).toBe(childB);
  });

  it('keeps literal identity suffixes from colliding with generated identities', () => {
    const duplicateA = new Agent({
      name: 'SharedSkill',
      instructions: 'alpha child',
    });
    const literalSuffix = new Agent({ name: 'SharedSkill#2' });
    const duplicateB = new Agent({
      name: 'SharedSkill',
      instructions: 'bravo child',
    });
    const root = new Agent({
      name: 'Root',
      handoffs: [duplicateA, literalSuffix, duplicateB],
    });
    const state = new RunState(new RunContext(), 'input', root, 2);
    state._currentAgent = duplicateB;

    const json = state.toJSON();

    expect(json.currentAgent).toEqual({
      name: 'SharedSkill',
      identity: 'SharedSkill#3',
    });
  });

  it('restores duplicate-name run item ownership by identity', async () => {
    const childA = new Agent({
      name: 'SharedSkill',
      instructions: 'alpha child',
    });
    const childB = new Agent({
      name: 'SharedSkill',
      instructions: 'bravo child',
    });
    const root = new Agent({ name: 'Root', handoffs: [childA, childB] });
    const approvalCall = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'approval-call',
      status: 'completed',
      arguments: '{}',
    } satisfies protocol.FunctionCallItem;
    const state = new RunState(new RunContext(), 'input', root, 2);
    state._currentAgent = childB;
    state._generatedItems = [
      new ToolApprovalItem(approvalCall, childB),
      new RunHandoffOutputItem(
        {
          type: 'function_call_result',
          name: 'transfer_to_sharedskill',
          callId: 'handoff-call',
          status: 'completed',
          output: '{"assistant":"SharedSkill"}',
        },
        childA,
        childB,
      ),
    ];
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [state._generatedItems[0]] },
    };
    state._lastProcessedResponse = {
      newItems: [state._generatedItems[0]],
      toolsUsed: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const json = state.toJSON();
    expect(json.generatedItems[0]).toMatchObject({
      type: 'tool_approval_item',
      agent: { name: 'SharedSkill', identity: 'SharedSkill#2' },
    });
    expect(json.generatedItems[1]).toMatchObject({
      type: 'handoff_output_item',
      sourceAgent: { name: 'SharedSkill' },
      targetAgent: { name: 'SharedSkill', identity: 'SharedSkill#2' },
    });

    const restored = await RunState.fromString(root, JSON.stringify(json));
    expect((restored._generatedItems[0] as ToolApprovalItem).agent).toBe(
      childB,
    );
    expect(
      (restored._generatedItems[1] as RunHandoffOutputItem).sourceAgent,
    ).toBe(childA);
    expect(
      (restored._generatedItems[1] as RunHandoffOutputItem).targetAgent,
    ).toBe(childB);
    expect(restored.getInterruptions()[0]?.agent).toBe(childB);
    expect(
      (restored._lastProcessedResponse?.newItems[0] as ToolApprovalItem).agent,
    ).toBe(childB);
  });

  it('preserves live duplicate-name processed response ownership during tool rehydration', async () => {
    const childA = new Agent({
      name: 'SharedSkill',
      instructions: 'alpha child',
    });
    const childB = new Agent({
      name: 'SharedSkill',
      instructions: 'bravo child',
    });
    const root = new Agent({ name: 'Root', handoffs: [childA, childB] });
    const approvalCall = {
      type: 'function_call',
      name: 'needs_approval',
      callId: 'approval-call',
      status: 'completed',
      arguments: '{}',
    } satisfies protocol.FunctionCallItem;
    const state = new RunState(new RunContext(), 'input', root, 2);
    state._currentAgent = childB;
    state._lastProcessedResponse = {
      newItems: [new ToolApprovalItem(approvalCall, childB)],
      toolsUsed: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    await rehydrateProcessedResponseTools(root, state, []);

    expect(
      (state._lastProcessedResponse?.newItems[0] as ToolApprovalItem).agent,
    ).toBe(childB);
  });

  it('rejects duplicate-name states when a saved identity is missing', async () => {
    const childA = new Agent({
      name: 'SharedSkill',
      instructions: 'alpha child',
    });
    const childB = new Agent({
      name: 'SharedSkill',
      instructions: 'bravo child',
    });
    const root = new Agent({ name: 'Root', handoffs: [childA, childB] });
    const state = new RunState(new RunContext(), 'input', root, 2);
    state._currentAgent = childB;
    const json = state.toJSON();
    json.currentAgent = { name: 'SharedSkill', identity: 'SharedSkill#99' };

    await expect(() =>
      RunState.fromString(root, JSON.stringify(json)),
    ).rejects.toThrow('Agent identity SharedSkill#99 not found');
  });

  it('keeps legacy duplicate-name payloads rejected', async () => {
    const childA = new Agent({ name: 'SharedSkill' });
    const childB = new Agent({ name: 'SharedSkill' });
    const agentA = new Agent({ name: 'AgentA', handoffs: [childA] });
    const agentB = new Agent({ name: 'AgentB', handoffs: [childB] });
    const root = new Agent({ name: 'Root', handoffs: [agentA, agentB] });
    const state = new RunState(new RunContext(), 'input', childB, 2);
    const json = state.toJSON();
    json.$schemaVersion = '1.9';
    json.currentAgent = { name: 'SharedSkill' };

    await expect(() =>
      RunState.fromString(root, JSON.stringify(json)),
    ).rejects.toThrow(
      'Duplicate agent name "SharedSkill" detected. Use unique agent names when serializing RunState.',
    );
  });

  it('only serializes tracing api key when explicitly requested', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Tracey' });
    const state = new RunState(context, 'input', agent, 1);
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);
    const trace = provider.createTrace({
      traceId: 'trace_test',
      name: 'workflow',
      tracingApiKey: 'trace-key',
    });
    const agentSpan = provider.createSpan(
      { data: { type: 'agent', name: 'TestAgentSpan' } },
      trace,
    );
    state._currentAgentSpan = agentSpan;
    state._trace = trace;

    const defaultJson = state.toJSON();
    expect(defaultJson.trace?.tracing_api_key).toBeUndefined();

    const optInJson = state.toJSON({ includeTracingApiKey: true });
    expect(optInJson.trace?.tracing_api_key).toBe('trace-key');

    const restoredWithKey = await RunState.fromString(
      agent,
      state.toString({ includeTracingApiKey: true }),
    );
    expect(restoredWithKey._trace?.tracingApiKey).toBe('trace-key');

    const restoredWithoutKey = await RunState.fromString(
      agent,
      state.toString(),
    );
    expect(restoredWithoutKey._trace?.tracingApiKey).toBeUndefined();

    provider.setDisabled(true);
  });

  it('serializes tool_call_output_item for non-function tools', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'OutputAgent' });
    const rawShellOutput: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId: 'call-shell',
      output: [
        { stdout: 'ok', stderr: '', outcome: { type: 'exit', exitCode: 0 } },
      ],
    };
    const state = new RunState(context, 'input', agent, 1);
    state._generatedItems.push(
      new RunToolCallOutputItem(rawShellOutput, agent, rawShellOutput.output),
    );

    const restored = await RunState.fromString(agent, state.toString());
    const restoredItem = restored._generatedItems[0];
    expect(restoredItem).toBeInstanceOf(RunToolCallOutputItem);
    expect((restoredItem as RunToolCallOutputItem).rawItem).toEqual(
      rawShellOutput,
    );
  });

  it('round-trips Programmatic Tool Calling items in schema 1.14', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'ProgramAgent' });
    const program: protocol.ProgramCallItem = {
      type: 'program',
      id: 'prog_1',
      callId: 'call_prog_1',
      code: 'text("ok")',
      fingerprint: 'fp_1',
    };
    const programOutput: protocol.ProgramCallResultItem = {
      type: 'program_output',
      id: 'prog_out_1',
      callId: 'call_prog_1',
      output: 'ok',
      status: 'completed',
    };
    const state = new RunState(context, 'input', agent, 1);
    state._generatedItems.push(
      new RunToolCallItem(program, agent),
      new RunToolCallOutputItem(programOutput, agent, programOutput.output),
    );

    const serialized = state.toJSON();
    expect(serialized.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    expect(restored._generatedItems.map((item) => item.rawItem)).toEqual([
      program,
      programOutput,
    ]);

    serialized.$schemaVersion = '1.13';
    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow('does not support Programmatic Tool Calling items');
  });

  describe('compaction items', () => {
    const compactionItem: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_1',
      encrypted_content: 'ciphertext',
      created_by: 'compaction_endpoint',
      providerData: { extra: 'value' },
    };

    function stateWithCompaction(agent: Agent<any, any>) {
      const state = new RunState(new RunContext(), 'input', agent, 1);
      state._generatedItems.push(new RunCompactionItem(compactionItem, agent));
      state._modelResponses = [
        {
          usage: new Usage(),
          output: [compactionItem],
          responseId: 'response-compaction',
        },
      ];
      state._lastTurnResponse = state._modelResponses[0];
      return state;
    }

    it('round-trips a compaction run item at the current schema version', async () => {
      const agent = new Agent({ name: 'CompactionStateAgent' });
      const serialized = stateWithCompaction(agent).toJSON();
      expect(serialized.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const restoredItem = restored._generatedItems[0] as RunCompactionItem;
      expect(restoredItem).toBeInstanceOf(RunCompactionItem);
      expect(restoredItem.rawItem).toEqual(compactionItem);
      expect(restoredItem.agent.name).toBe('CompactionStateAgent');
      expect(restored._modelResponses[0]?.output[0]).toEqual(compactionItem);
    });

    it('rejects current schema raw compaction without its run item wrapper', async () => {
      const agent = new Agent({ name: 'IncompleteCompactionStateAgent' });
      const serialized = stateWithCompaction(agent).toJSON() as any;
      serialized.generatedItems = [];

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('contains inconsistent compaction items');
    });

    it('round-trips a migrated legacy state with multiple raw compactions', async () => {
      const agent = new Agent({ name: 'MultipleLegacyCompactionAgent' });
      const earlierCompaction = {
        ...compactionItem,
        id: 'cmp_earlier',
        encrypted_content: 'earlier-ciphertext',
      };
      const latestCompaction = {
        ...compactionItem,
        id: 'cmp_latest',
        encrypted_content: 'latest-ciphertext',
      };
      const earlierMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'earlier output' }],
      };
      const latestMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'latest output' }],
      };
      const earlierResponse = {
        usage: new Usage(),
        output: [earlierCompaction, earlierMessage],
        responseId: 'response-earlier-compaction',
      };
      const latestResponse = {
        usage: new Usage(),
        output: [latestCompaction, latestMessage],
        responseId: 'response-latest-compaction',
      };
      const earlierItem = new RunMessageOutputItem(earlierMessage, agent);
      const latestItem = new RunMessageOutputItem(latestMessage, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [earlierResponse, latestResponse];
      state._lastTurnResponse = latestResponse;
      state._generatedItems = [earlierItem, latestItem];
      state._lastProcessedResponse = {
        newItems: [latestItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const migrated = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const roundTripped = await RunState.fromString(
        agent,
        migrated.toString(),
      );

      expect(roundTripped._generatedItems.map((item) => item.type)).toEqual([
        'message_output_item',
        'compaction_item',
        'message_output_item',
      ]);
      expect(
        (roundTripped._generatedItems[1] as RunCompactionItem).rawItem,
      ).toEqual(latestCompaction);
    });

    it.each(['1.0', '1.15'] as const)(
      'rehydrates raw compaction output from legacy schema %s',
      async (schemaVersion) => {
        const agent = new Agent({ name: 'LegacyCompactionAgent' });
        const serialized = stateWithCompaction(agent).toJSON() as any;
        serialized.generatedItems = [];
        serialized.$schemaVersion = schemaVersion;

        const restored = await RunState.fromString(
          agent,
          JSON.stringify(serialized),
        );
        expect(restored._generatedItems).toHaveLength(1);
        expect(restored._generatedItems[0]).toBeInstanceOf(RunCompactionItem);
        expect(restored._generatedItems[0].rawItem).toEqual(compactionItem);
        expect(restored._modelResponses[0]?.output[0]).toEqual(compactionItem);
      },
    );

    it('anchors legacy compaction against a normalized namespaced function call', async () => {
      const namespacedLookup = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Look up a CRM record.',
            parameters: z.object({}).strict(),
            execute: async () => 'lookup',
          }),
        ],
      })[0]!;
      const agent = new Agent({
        name: 'LegacyNamespacedCompactionAgent',
        tools: [namespacedLookup],
      });
      const rawCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'crm.lookup',
        callId: 'call_legacy_namespaced_compaction',
        arguments: '{}',
        status: 'completed',
      };
      const response = {
        usage: new Usage(),
        output: [rawCall, compactionItem],
        responseId: 'response-legacy-namespaced-compaction',
      };
      const processed = processModelResponse(
        response,
        agent,
        [namespacedLookup],
        [],
      );
      const legacyItems = processed.newItems.filter(
        (item) => !(item instanceof RunCompactionItem),
      );
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = legacyItems;
      state._lastProcessedResponse = { ...processed, newItems: legacyItems };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'compaction_item',
      ]);
      expect(restored._generatedItems[0]?.rawItem).toMatchObject({
        name: 'lookup',
        namespace: 'crm',
      });
    });

    it('anchors historical legacy compaction against a normalized namespaced function call', async () => {
      const namespacedLookup = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Look up a CRM record.',
            parameters: z.object({}).strict(),
            execute: async () => 'lookup',
          }),
        ],
      })[0]!;
      const agent = new Agent({
        name: 'HistoricalNamespacedCompactionAgent',
        tools: [namespacedLookup],
      });
      const rawCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'crm.lookup',
        callId: 'call_historical_namespaced_compaction',
        arguments: '{}',
        status: 'completed',
      };
      const laterMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'later response' }],
      };
      const earlierResponse = {
        usage: new Usage(),
        output: [rawCall, compactionItem],
        responseId: 'response-historical-namespaced-compaction',
      };
      const laterResponse = {
        usage: new Usage(),
        output: [laterMessage],
        responseId: 'response-after-namespaced-compaction',
      };
      const earlierProcessed = processModelResponse(
        earlierResponse,
        agent,
        [namespacedLookup],
        [],
      );
      const laterProcessed = processModelResponse(laterResponse, agent, [], []);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [earlierResponse, laterResponse];
      state._lastTurnResponse = laterResponse;
      state._generatedItems = [
        ...earlierProcessed.newItems.filter(
          (item) => !(item instanceof RunCompactionItem),
        ),
        ...laterProcessed.newItems,
      ];
      state._lastProcessedResponse = laterProcessed;
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'compaction_item',
        'message_output_item',
      ]);
    });

    it('ignores later handoffs that released writers omitted around legacy compaction', async () => {
      const firstTarget = new Agent({ name: 'FirstLegacyHandoffTarget' });
      const secondTarget = new Agent({ name: 'SecondLegacyHandoffTarget' });
      const firstHandoff = handoff(firstTarget, {
        toolNameOverride: 'transfer_first',
      });
      const secondHandoff = handoff(secondTarget, {
        toolNameOverride: 'transfer_second',
      });
      const agent = new Agent({
        name: 'MultipleLegacyHandoffCompactionAgent',
        handoffs: [firstHandoff, secondHandoff],
      });
      const firstCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: firstHandoff.toolName,
        callId: 'call_first_legacy_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const secondCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: secondHandoff.toolName,
        callId: 'call_second_legacy_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const response = {
        usage: new Usage(),
        output: [firstCall, compactionItem, secondCall],
        responseId: 'response-multiple-legacy-handoffs',
      };
      const processed = processModelResponse(
        response,
        agent,
        [],
        [firstHandoff, secondHandoff],
      );
      const legacyItems = processed.newItems.filter(
        (item) => !(item instanceof RunCompactionItem),
      );
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = legacyItems;
      state._lastProcessedResponse = { ...processed, newItems: legacyItems };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'handoff_call_item',
        'compaction_item',
      ]);
    });

    it('allocates identical omitted handoffs by occurrence', async () => {
      const target = new Agent({ name: 'RepeatedLegacyHandoffTarget' });
      const repeatedHandoff = handoff(target, {
        toolNameOverride: 'transfer_repeated',
      });
      const agent = new Agent({
        name: 'RepeatedLegacyHandoffCompactionAgent',
        handoffs: [repeatedHandoff],
      });
      const repeatedCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: repeatedHandoff.toolName,
        callId: 'call_repeated_legacy_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const response = {
        usage: new Usage(),
        output: [repeatedCall, compactionItem, repeatedCall],
        responseId: 'response-repeated-legacy-handoffs',
      };
      const processed = processModelResponse(
        response,
        agent,
        [],
        [repeatedHandoff],
      );
      const legacyItems = processed.newItems.filter(
        (item) => !(item instanceof RunCompactionItem),
      );
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = legacyItems;
      state._lastProcessedResponse = { ...processed, newItems: legacyItems };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'handoff_call_item',
        'compaction_item',
      ]);
    });

    it('rejects a missing first wrapper for identical legacy handoffs', async () => {
      const target = new Agent({ name: 'MissingRepeatedHandoffTarget' });
      const repeatedHandoff = handoff(target, {
        toolNameOverride: 'transfer_missing_repeated',
      });
      const agent = new Agent({
        name: 'MissingRepeatedHandoffCompactionAgent',
        handoffs: [repeatedHandoff],
      });
      const repeatedCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: repeatedHandoff.toolName,
        callId: 'call_missing_repeated_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, repeatedCall, repeatedCall],
        responseId: 'response-missing-repeated-handoffs',
      };
      const processed = processModelResponse(
        response,
        agent,
        [],
        [repeatedHandoff],
      );
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [];
      state._lastProcessedResponse = { ...processed, newItems: [] };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('allocates normalized legacy handoff key collisions by occurrence', async () => {
      const target = new Agent({ name: 'NormalizedLegacyHandoffTarget' });
      const repeatedHandoff = handoff(target, {
        toolNameOverride: 'transfer_normalized',
      });
      const agent = new Agent({
        name: 'NormalizedLegacyHandoffCompactionAgent',
        handoffs: [repeatedHandoff],
      });
      const originalCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: repeatedHandoff.toolName,
        callId: 'call_normalized_legacy_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const flattenedCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'transfer.normalized',
        callId: 'call_normalized_legacy_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const namespacedCall: protocol.FunctionCallItem = {
        ...flattenedCall,
        name: 'normalized',
        namespace: 'transfer',
      };
      const response = {
        usage: new Usage(),
        output: [originalCall, compactionItem, originalCall],
        responseId: 'response-normalized-legacy-handoffs',
      };
      const processed = processModelResponse(
        response,
        agent,
        [],
        [repeatedHandoff],
      );
      const legacyItems = processed.newItems.filter(
        (item) => !(item instanceof RunCompactionItem),
      );
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = legacyItems;
      state._lastProcessedResponse = { ...processed, newItems: legacyItems };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      serialized.modelResponses[0].output[0] = flattenedCall;
      serialized.modelResponses[0].output[2] = namespacedCall;
      serialized.lastModelResponse.output[0] = flattenedCall;
      serialized.lastModelResponse.output[2] = namespacedCall;
      serialized.generatedItems[0].rawItem = flattenedCall;
      serialized.lastProcessedResponse.newItems[0].rawItem = flattenedCall;
      serialized.lastProcessedResponse.handoffs[0].toolCall = flattenedCall;
      serialized.lastProcessedResponse.handoffs[1].toolCall = namespacedCall;

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'handoff_call_item',
        'compaction_item',
      ]);
    });

    it('rejects historical omitted handoffs that cannot be proven from the latest processed response', async () => {
      const firstTarget = new Agent({ name: 'FirstHistoricalHandoffTarget' });
      const secondTarget = new Agent({ name: 'SecondHistoricalHandoffTarget' });
      const firstHandoff = handoff(firstTarget, {
        toolNameOverride: 'transfer_historical_first',
      });
      const secondHandoff = handoff(secondTarget, {
        toolNameOverride: 'transfer_historical_second',
      });
      const agent = new Agent({
        name: 'HistoricalMultipleHandoffCompactionAgent',
        handoffs: [firstHandoff, secondHandoff],
      });
      const firstCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: firstHandoff.toolName,
        callId: 'call_historical_first_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const secondCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: secondHandoff.toolName,
        callId: 'call_historical_second_handoff',
        arguments: '{}',
        status: 'completed',
      };
      const laterMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'later response' }],
      };
      const earlierResponse = {
        usage: new Usage(),
        output: [firstCall, compactionItem, secondCall],
        responseId: 'response-historical-multiple-handoffs',
      };
      const laterResponse = {
        usage: new Usage(),
        output: [laterMessage],
        responseId: 'response-after-multiple-handoffs',
      };
      const earlierProcessed = processModelResponse(
        earlierResponse,
        agent,
        [],
        [firstHandoff, secondHandoff],
      );
      const laterProcessed = processModelResponse(laterResponse, agent, [], []);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [earlierResponse, laterResponse];
      state._lastTurnResponse = laterResponse;
      state._generatedItems = [
        ...earlierProcessed.newItems.filter(
          (item) => !(item instanceof RunCompactionItem),
        ),
        ...laterProcessed.newItems,
      ];
      state._lastProcessedResponse = laterProcessed;
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it.each(['latest', 'historical', 'intermediate'] as const)(
      'rejects a missing second normal function wrapper in a %s response boundary',
      async (position) => {
        const agent = new Agent({ name: `MissingFunctionWrapper-${position}` });
        const firstCall: protocol.FunctionCallItem = {
          type: 'function_call',
          name: 'first_normal_tool',
          callId: `call_first_${position}`,
          arguments: '{}',
        };
        const secondCall: protocol.FunctionCallItem = {
          type: 'function_call',
          name: 'second_normal_tool',
          callId: `call_second_${position}`,
          arguments: '{}',
        };
        const latestMessage: protocol.AssistantMessageItem = {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'latest response' }],
        };
        const firstCallItem = new RunToolCallItem(firstCall, agent);
        const latestMessageItem = new RunMessageOutputItem(
          latestMessage,
          agent,
        );
        const responseWithMissingWrapper = {
          usage: new Usage(),
          output: [firstCall, compactionItem, secondCall],
          responseId: `response-missing-function-${position}`,
        };
        const latestResponse = {
          usage: new Usage(),
          output: [latestMessage],
          responseId: `response-latest-after-missing-function-${position}`,
        };
        const state = new RunState(new RunContext(), 'input', agent, 3);

        if (position === 'latest') {
          state._modelResponses = [responseWithMissingWrapper];
          state._lastTurnResponse = responseWithMissingWrapper;
          state._generatedItems = [firstCallItem];
          state._lastProcessedResponse = {
            newItems: [firstCallItem],
            handoffs: [],
            functions: [],
            functionToolsNotFound: [],
            computerActions: [],
            shellActions: [],
            applyPatchActions: [],
            mcpApprovalRequests: [],
            toolsUsed: [],
            hasToolsOrApprovalsToRun: () => false,
          };
        } else if (position === 'historical') {
          state._modelResponses = [responseWithMissingWrapper, latestResponse];
          state._lastTurnResponse = latestResponse;
          state._generatedItems = [firstCallItem, latestMessageItem];
          state._lastProcessedResponse = {
            newItems: [latestMessageItem],
            handoffs: [],
            functions: [],
            functionToolsNotFound: [],
            computerActions: [],
            shellActions: [],
            applyPatchActions: [],
            mcpApprovalRequests: [],
            toolsUsed: [],
            hasToolsOrApprovalsToRun: () => false,
          };
        } else {
          const compactionResponse = {
            usage: new Usage(),
            output: [compactionItem],
            responseId: 'response-before-missing-function-boundary',
          };
          const intermediateResponse = {
            ...responseWithMissingWrapper,
            output: [firstCall, secondCall],
          };
          state._modelResponses = [
            compactionResponse,
            intermediateResponse,
            latestResponse,
          ];
          state._lastTurnResponse = latestResponse;
          state._generatedItems = [firstCallItem, latestMessageItem];
          state._lastProcessedResponse = {
            newItems: [latestMessageItem],
            handoffs: [],
            functions: [],
            functionToolsNotFound: [],
            computerActions: [],
            shellActions: [],
            applyPatchActions: [],
            mcpApprovalRequests: [],
            toolsUsed: [],
            hasToolsOrApprovalsToRun: () => false,
          };
        }

        const serialized = state.toJSON() as any;
        serialized.$schemaVersion = '1.15';

        await expect(
          RunState.fromString(agent, JSON.stringify(serialized)),
        ).rejects.toThrow('provider order is ambiguous');
      },
    );

    it('rehydrates a legacy interrupted response in provider order', async () => {
      const approvalTool = tool({
        name: 'legacy_compaction_tool',
        description: 'Tool requiring approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const agent = new Agent({
        name: 'LegacyCompactionApprovalAgent',
        tools: [approvalTool],
      });
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_legacy_compaction',
        arguments: '{}',
        status: 'completed',
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, functionCall],
        responseId: 'response-compaction-interruption',
      };
      const callItem = new RunToolCallItem(functionCall, agent);
      const approvalItem = new ToolApprovalItem(functionCall, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [callItem, approvalItem];
      state._lastProcessedResponse = {
        newItems: [callItem],
        handoffs: [],
        functions: [{ toolCall: functionCall, tool: approvalTool as any }],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [approvalTool.name],
        hasToolsOrApprovalsToRun: () => true,
      };
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const session = new MemorySession();
      await saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      });

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'tool_call_item',
        'tool_approval_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['compaction_item', 'tool_call_item']);
      expect(restored._currentTurnPersistedItemCount).toBe(3);
      expect(
        restored._pendingLegacyCompactionSessionItems?.map((item) => item.type),
      ).toEqual(['compaction', 'function_call']);
      const pendingRoundTripped = await RunState.fromString(
        agent,
        restored.toString(),
      );
      expect(
        pendingRoundTripped._pendingLegacyCompactionSessionItems?.map(
          (item) => item.type,
        ),
      ).toEqual(['compaction', 'function_call']);

      await saveToSession(session, [], new RunResult(restored as any), {
        runCompaction: false,
      });
      expect((await session.getItems()).map((item) => item.type)).toEqual([
        'compaction',
        'function_call',
      ]);
      expect(restored._pendingLegacyCompactionSessionItems).toBeUndefined();
      const functionResult: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: approvalTool.name,
        callId: functionCall.callId,
        output: 'approved',
        status: 'completed',
      };
      restored._generatedItems.push(
        new RunToolCallOutputItem(functionResult, agent, 'approved'),
      );
      await saveToSession(session, [], new RunResult(restored as any), {
        runCompaction: false,
      });
      expect((await session.getItems()).map((item) => item.type)).toEqual([
        'compaction',
        'function_call',
        'function_call_result',
      ]);
      const prepared = await prepareInputItemsWithSession('continue', session);
      expect(
        (prepared.preparedInput as protocol.ModelItem[]).map(
          (item) => item.type,
        ),
      ).toEqual([
        'compaction',
        'function_call',
        'function_call_result',
        'message',
      ]);
      expect(
        prepareModelInputItems(
          restored._originalInput,
          restored._generatedItems,
        ).map((item) => item.type),
      ).toEqual(['compaction', 'function_call', 'function_call_result']);

      const roundTripped = await RunState.fromString(
        agent,
        restored.toString(),
      );
      expect(
        roundTripped._generatedItems.filter(
          (item) => item instanceof RunCompactionItem,
        ),
      ).toHaveLength(1);
    });

    it('anchors legacy compaction within the latest processed response', async () => {
      const agent = new Agent({ name: 'RepeatedLegacyCompactionAgent' });
      const repeatedMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'repeated output' }],
      };
      const earlierResponse = {
        usage: new Usage(),
        output: [repeatedMessage],
        responseId: 'response-before-compaction',
      };
      const latestResponse = {
        usage: new Usage(),
        output: [compactionItem, repeatedMessage],
        responseId: 'response-with-compaction',
      };
      const earlierItem = new RunMessageOutputItem(repeatedMessage, agent);
      const latestItem = new RunMessageOutputItem(repeatedMessage, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [earlierResponse, latestResponse];
      state._lastTurnResponse = latestResponse;
      state._generatedItems = [earlierItem, latestItem];
      state._lastProcessedResponse = {
        newItems: [latestItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'message_output_item',
        'compaction_item',
        'message_output_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['compaction_item', 'message_output_item']);
    });

    it('uses the latest response wrapper agent for legacy compaction', async () => {
      const sourceAgent = new Agent({ name: 'CompactionSourceAgent' });
      const targetAgent = new Agent({
        name: 'CompactionTargetAgent',
        handoffs: [sourceAgent],
      });
      const message: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'source output' }],
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, message],
        responseId: 'response-with-source-agent-compaction',
      };
      const messageItem = new RunMessageOutputItem(message, sourceAgent);
      const state = new RunState(new RunContext(), 'input', sourceAgent, 2);
      state._currentAgent = targetAgent;
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [messageItem];
      state._lastProcessedResponse = {
        newItems: [messageItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        targetAgent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems[0]).toBeInstanceOf(RunCompactionItem);
      expect((restored._generatedItems[0] as RunCompactionItem).agent).toBe(
        sourceAgent,
      );
      expect((restored._generatedItems[1] as RunMessageOutputItem).agent).toBe(
        sourceAgent,
      );
    });

    it('rehydrates the latest compaction from an earlier model response', async () => {
      const automaticTool = tool({
        name: 'automatic_legacy_tool',
        description: 'Automatically executed tool.',
        parameters: z.object({}),
        execute: async () => 'automatic result',
      });
      const approvalTool = tool({
        name: 'approval_legacy_tool',
        description: 'Tool requiring approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved result',
      });
      const agent = new Agent({
        name: 'HistoricalLegacyCompactionAgent',
        tools: [automaticTool, approvalTool],
      });
      const automaticCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: automaticTool.name,
        callId: 'call_automatic_legacy_compaction',
        arguments: '{}',
        status: 'completed',
      };
      const approvalCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_approval_after_compaction',
        arguments: '{}',
        status: 'completed',
      };
      const earlierResponse = {
        usage: new Usage(),
        output: [compactionItem, automaticCall],
        responseId: 'response-with-earlier-compaction',
      };
      const latestResponse = {
        usage: new Usage(),
        output: [approvalCall],
        responseId: 'response-with-later-approval',
      };
      const earlierProcessed = processModelResponse(
        earlierResponse,
        agent,
        [automaticTool, approvalTool],
        [],
      );
      const approvalCallItem = new RunToolCallItem(approvalCall, agent);
      const approvalItem = new ToolApprovalItem(approvalCall, agent);
      const latestProcessed = {
        newItems: [approvalCallItem, approvalItem],
        handoffs: [],
        functions: [{ toolCall: approvalCall, tool: approvalTool as any }],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [approvalTool.name],
        hasToolsOrApprovalsToRun: () => true,
      };
      const automaticResult: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: automaticTool.name,
        callId: automaticCall.callId,
        output: 'automatic result',
        status: 'completed',
      };
      const state = new RunState(new RunContext(), 'old input', agent, 2);
      state._modelResponses = [earlierResponse, latestResponse];
      state._lastTurnResponse = latestResponse;
      state._generatedItems = [
        ...earlierProcessed.newItems.filter(
          (item) => !(item instanceof RunCompactionItem),
        ),
        new RunToolCallOutputItem(automaticResult, agent, 'automatic result'),
        ...latestProcessed.newItems,
      ];
      state._lastProcessedResponse = latestProcessed;
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'tool_call_item',
        'tool_call_output_item',
        'tool_call_item',
        'tool_approval_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['tool_call_item', 'tool_approval_item']);
      expect(restored.history[0]).toEqual(compactionItem);
      expect(restored.getInterruptions()).toHaveLength(1);
    });

    it('rehydrates a historical compaction-only response before an approval', async () => {
      const approvalTool = tool({
        name: 'approval_after_compaction_only',
        description: 'Tool requiring approval after compaction.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved result',
      });
      const agent = new Agent({
        name: 'HistoricalCompactionOnlyAgent',
        tools: [approvalTool],
      });
      const approvalCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_after_compaction_only',
        arguments: '{}',
        status: 'completed',
      };
      const compactionResponse = {
        usage: new Usage(),
        output: [compactionItem],
        responseId: 'response-compaction-only',
      };
      const approvalResponse = {
        usage: new Usage(),
        output: [approvalCall],
        responseId: 'response-approval-after-compaction-only',
      };
      const approvalCallItem = new RunToolCallItem(approvalCall, agent);
      const approvalItem = new ToolApprovalItem(approvalCall, agent);
      const latestProcessed = {
        newItems: [approvalCallItem, approvalItem],
        handoffs: [],
        functions: [{ toolCall: approvalCall, tool: approvalTool as any }],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [approvalTool.name],
        hasToolsOrApprovalsToRun: () => true,
      };
      const state = new RunState(new RunContext(), 'old input', agent, 2);
      state._modelResponses = [compactionResponse, approvalResponse];
      state._lastTurnResponse = approvalResponse;
      state._generatedItems = latestProcessed.newItems;
      state._lastProcessedResponse = latestProcessed;
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'tool_call_item',
        'tool_approval_item',
      ]);
      expect(restored.history[0]).toEqual(compactionItem);
      expect(restored.getInterruptions()).toHaveLength(1);
      expect((restored._generatedItems[0] as RunCompactionItem).agent).toBe(
        agent,
      );
    });

    it('rehydrates a compaction-only response across multiple later responses', async () => {
      const automaticTool = tool({
        name: 'automatic_after_compaction_only',
        description: 'Automatically executed after compaction.',
        parameters: z.object({}),
        execute: async () => 'automatic result',
      });
      const approvalTool = tool({
        name: 'approval_after_multiple_responses',
        description: 'Requires approval after the automatic turn.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved result',
      });
      const agent = new Agent({
        name: 'MultipleResponsesAfterCompactionAgent',
        tools: [automaticTool, approvalTool],
      });
      const automaticCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: automaticTool.name,
        callId: 'call_after_compaction_only',
        arguments: '{}',
        status: 'completed',
      };
      const automaticResult: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: automaticTool.name,
        callId: automaticCall.callId,
        output: 'automatic result',
        status: 'completed',
      };
      const approvalCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_approval_after_multiple_responses',
        arguments: '{}',
        status: 'completed',
      };
      const compactionResponse = {
        usage: new Usage(),
        output: [compactionItem],
        responseId: 'response-compaction-only-before-multiple',
      };
      const automaticResponse = {
        usage: new Usage(),
        output: [automaticCall],
        responseId: 'response-automatic-after-compaction-only',
      };
      const approvalResponse = {
        usage: new Usage(),
        output: [approvalCall],
        responseId: 'response-approval-after-multiple',
      };
      const automaticCallItem = new RunToolCallItem(automaticCall, agent);
      const automaticResultItem = new RunToolCallOutputItem(
        automaticResult,
        agent,
        'automatic result',
      );
      const approvalCallItem = new RunToolCallItem(approvalCall, agent);
      const approvalItem = new ToolApprovalItem(approvalCall, agent);
      const latestProcessed = {
        newItems: [approvalCallItem, approvalItem],
        handoffs: [],
        functions: [{ toolCall: approvalCall, tool: approvalTool as any }],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [approvalTool.name],
        hasToolsOrApprovalsToRun: () => true,
      };
      const state = new RunState(new RunContext(), 'old input', agent, 3);
      state._modelResponses = [
        compactionResponse,
        automaticResponse,
        approvalResponse,
      ];
      state._lastTurnResponse = approvalResponse;
      state._generatedItems = [
        automaticCallItem,
        automaticResultItem,
        ...latestProcessed.newItems,
      ];
      state._lastProcessedResponse = latestProcessed;
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'tool_call_item',
        'tool_call_output_item',
        'tool_call_item',
        'tool_approval_item',
      ]);
      expect(restored.history[0]).toEqual(compactionItem);
      expect(restored.getInterruptions()).toHaveLength(1);
      expect((restored._generatedItems[0] as RunCompactionItem).agent).toBe(
        agent,
      );
    });

    it('rejects a later response wrapper reused as a historical compaction anchor', async () => {
      const agent = new Agent({ name: 'ReusedHistoricalAnchorAgent' });
      const duplicatedMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'duplicated response' }],
      };
      const compactionResponse = {
        usage: new Usage(),
        output: [compactionItem, duplicatedMessage],
        responseId: 'response-compaction-with-missing-wrapper',
      };
      const laterResponse = {
        usage: new Usage(),
        output: [duplicatedMessage],
        responseId: 'response-with-reused-wrapper',
      };
      const laterProcessed = processModelResponse(laterResponse, agent, [], []);
      const state = new RunState(new RunContext(), 'old input', agent, 2);
      state._modelResponses = [compactionResponse, laterResponse];
      state._lastTurnResponse = laterResponse;
      state._generatedItems = laterProcessed.newItems;
      state._lastProcessedResponse = laterProcessed;
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow(
        'Run state cannot safely restore a legacy compaction item because its provider order is ambiguous.',
      );
    });

    it('rejects an intermediate response with a missing retained wrapper', async () => {
      const agent = new Agent({ name: 'MissingIntermediateWrapperAgent' });
      const message = (text: string): protocol.AssistantMessageItem => ({
        ...TEST_MODEL_MESSAGE,
        content: [{ type: 'output_text', text }],
      });
      const retainedMessage = message('retained intermediate');
      const missingMessage = message('missing intermediate');
      const latestMessage = message('latest response');
      const compactionResponse = {
        usage: new Usage(),
        output: [compactionItem],
      };
      const intermediateResponse = {
        usage: new Usage(),
        output: [retainedMessage, missingMessage],
      };
      const latestResponse = {
        usage: new Usage(),
        output: [latestMessage],
      };
      const retainedProcessed = processModelResponse(
        { usage: new Usage(), output: [retainedMessage] },
        agent,
        [],
        [],
      );
      const latestProcessed = processModelResponse(
        latestResponse,
        agent,
        [],
        [],
      );
      const state = new RunState(new RunContext(), 'old input', agent, 3);
      state._modelResponses = [
        compactionResponse,
        intermediateResponse,
        latestResponse,
      ];
      state._lastTurnResponse = latestResponse;
      state._generatedItems = [
        ...retainedProcessed.newItems,
        ...latestProcessed.newItems,
      ];
      state._lastProcessedResponse = latestProcessed;
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow(
        'Run state cannot safely restore a legacy compaction item because its provider order is ambiguous.',
      );
    });

    it('allows a trailing local result after the validated latest response segment', async () => {
      const approvalTool = tool({
        name: 'approval_with_trailing_result',
        description: 'Requires approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const automaticTool = tool({
        name: 'automatic_with_trailing_result',
        description: 'Runs automatically.',
        parameters: z.object({}),
        execute: async () => 'automatic',
      });
      const agent = new Agent({
        name: 'TrailingLocalResultAgent',
        tools: [approvalTool, automaticTool],
      });
      const approvalCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_trailing_approval',
        arguments: '{}',
      };
      const automaticCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: automaticTool.name,
        callId: 'call_trailing_automatic',
        arguments: '{}',
      };
      const laterResponse = {
        usage: new Usage(),
        output: [approvalCall, automaticCall],
      };
      const laterProcessed = processModelResponse(
        laterResponse,
        agent,
        [approvalTool, automaticTool],
        [],
      );
      const automaticResult: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: automaticTool.name,
        callId: automaticCall.callId,
        status: 'completed',
        output: 'automatic',
      };
      const localResult = new RunToolCallOutputItem(
        automaticResult,
        agent,
        'automatic',
      );
      const state = new RunState(new RunContext(), 'old input', agent, 2);
      state._modelResponses = [
        { usage: new Usage(), output: [compactionItem] },
        laterResponse,
      ];
      state._lastTurnResponse = laterResponse;
      state._generatedItems = [...laterProcessed.newItems, localResult];
      state._lastProcessedResponse = laterProcessed;
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems[0]).toBeInstanceOf(RunCompactionItem);
      expect(restored._generatedItems.at(-1)?.type).toBe(
        'tool_call_output_item',
      );
    });

    it.each([
      [
        'shell',
        {
          type: 'shell_call_output',
          callId: 'call_local_shell_result',
          output: [
            {
              stdout: 'ok',
              stderr: '',
              outcome: { type: 'exit', exitCode: 0 },
            },
          ],
        },
      ],
      [
        'program',
        {
          type: 'program_output',
          callId: 'call_local_program_result',
          output: 'ok',
          status: 'completed',
        },
      ],
    ] as const)(
      'allows a trailing local %s result after the validated latest response segment',
      async (_kind, rawResult) => {
        const agent = new Agent({ name: `TrailingLocalResult-${_kind}` });
        const laterMessage: protocol.AssistantMessageItem = {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'later response' }],
        };
        const laterMessageItem = new RunMessageOutputItem(laterMessage, agent);
        const localResult = new RunToolCallOutputItem(
          rawResult as any,
          agent,
          rawResult.output,
        );
        const laterResponse = {
          usage: new Usage(),
          output: [laterMessage],
        };
        const state = new RunState(new RunContext(), 'old input', agent, 2);
        state._modelResponses = [
          { usage: new Usage(), output: [compactionItem] },
          laterResponse,
        ];
        state._lastTurnResponse = laterResponse;
        state._generatedItems = [laterMessageItem, localResult];
        state._lastProcessedResponse = {
          newItems: [laterMessageItem],
          handoffs: [],
          functions: [],
          functionToolsNotFound: [],
          computerActions: [],
          shellActions: [],
          applyPatchActions: [],
          mcpApprovalRequests: [],
          toolsUsed: [],
          hasToolsOrApprovalsToRun: () => false,
        };
        const serialized = state.toJSON() as any;
        serialized.$schemaVersion = '1.15';

        const restored = await RunState.fromString(
          agent,
          JSON.stringify(serialized),
        );

        expect(restored._generatedItems[0]).toBeInstanceOf(RunCompactionItem);
        expect(restored._generatedItems.at(-1)?.rawItem.type).toBe(
          rawResult.type,
        );
      },
    );

    it('rejects a stale duplicate as the following response boundary', async () => {
      const agent = new Agent({ name: 'StaleFollowingBoundaryAgent' });
      const duplicatedMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'duplicated response' }],
      };
      const unrelatedMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'unrelated later response' }],
      };
      const compactionResponse = {
        usage: new Usage(),
        output: [compactionItem],
        responseId: 'response-stale-boundary-compaction',
      };
      const followingResponse = {
        usage: new Usage(),
        output: [duplicatedMessage],
        responseId: 'response-stale-boundary-following',
      };
      const duplicatedItem = new RunMessageOutputItem(duplicatedMessage, agent);
      const state = new RunState(new RunContext(), 'old input', agent, 2);
      state._modelResponses = [compactionResponse, followingResponse];
      state._lastTurnResponse = followingResponse;
      state._generatedItems = [
        duplicatedItem,
        new RunMessageOutputItem(unrelatedMessage, agent),
      ];
      state._lastProcessedResponse = {
        newItems: [duplicatedItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('ignores dropped unknown output when anchoring legacy compaction', async () => {
      const agent = new Agent({ name: 'UnknownLegacyCompactionAgent' });
      const unknownItem: protocol.UnknownItem = {
        type: 'unknown',
        providerData: { type: 'future_output' },
      };
      const message: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'retained output' }],
      };
      const response = {
        usage: new Usage(),
        output: [unknownItem, compactionItem, message],
        responseId: 'response-unknown-with-compaction',
      };
      const messageItem = new RunMessageOutputItem(message, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [messageItem];
      state._lastProcessedResponse = {
        newItems: [messageItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'message_output_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['compaction_item', 'message_output_item']);
    });

    it('ignores dropped function results when anchoring legacy compaction', async () => {
      const agent = new Agent({ name: 'DroppedResultCompactionAgent' });
      const functionResult: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: 'completed_tool',
        callId: 'call_completed_before_compaction',
        output: 'completed',
        status: 'completed',
      };
      const message: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'retained output' }],
      };
      const response = {
        usage: new Usage(),
        output: [functionResult, compactionItem, message],
        responseId: 'response-dropped-result-with-compaction',
      };
      const messageItem = new RunMessageOutputItem(message, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [messageItem];
      state._lastProcessedResponse = {
        newItems: [messageItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'message_output_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['compaction_item', 'message_output_item']);
    });

    it('ignores synthesized tool search output when anchoring latest compaction', async () => {
      const agent = new Agent({ name: 'LatestToolSearchCompactionAgent' });
      const toolSearchCall = {
        type: 'tool_search_call',
        id: 'ts_call_latest_compaction',
        callId: 'ts_call_latest_compaction',
        status: 'completed',
        arguments: { query: 'latest tools' },
      } as const;
      const synthesizedOutput = {
        type: 'tool_search_output',
        id: 'ts_output_latest_compaction',
        callId: toolSearchCall.callId,
        status: 'completed',
        tools: [],
      } as const;
      const response = {
        usage: new Usage(),
        output: [compactionItem, toolSearchCall],
        responseId: 'response-latest-tool-search-compaction',
      };
      const callItem = new RunToolSearchCallItem(toolSearchCall as any, agent);
      const outputItem = new RunToolSearchOutputItem(
        synthesizedOutput as any,
        agent,
      );
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response as any];
      state._lastTurnResponse = response as any;
      state._generatedItems = [callItem, outputItem];
      state._lastProcessedResponse = {
        newItems: [callItem, outputItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: ['tool_search'],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'tool_search_call_item',
        'tool_search_output_item',
      ]);
    });

    it('ignores synthesized tool search output when anchoring historical compaction', async () => {
      const agent = new Agent({ name: 'HistoricalToolSearchCompactionAgent' });
      const toolSearchCall = {
        type: 'tool_search_call',
        id: 'ts_call_historical_compaction',
        callId: 'ts_call_historical_compaction',
        status: 'completed',
        arguments: { query: 'historical tools' },
      } as const;
      const synthesizedOutput = {
        type: 'tool_search_output',
        id: 'ts_output_historical_compaction',
        callId: toolSearchCall.callId,
        status: 'completed',
        tools: [],
      } as const;
      const anchoredMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'anchored output' }],
      };
      const laterMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'later output' }],
      };
      const compactionResponse = {
        usage: new Usage(),
        output: [toolSearchCall, compactionItem, anchoredMessage],
        responseId: 'response-historical-tool-search-compaction',
      };
      const laterResponse = {
        usage: new Usage(),
        output: [laterMessage],
        responseId: 'response-after-tool-search-compaction',
      };
      const callItem = new RunToolSearchCallItem(toolSearchCall as any, agent);
      const outputItem = new RunToolSearchOutputItem(
        synthesizedOutput as any,
        agent,
      );
      const anchoredItem = new RunMessageOutputItem(anchoredMessage, agent);
      const laterItem = new RunMessageOutputItem(laterMessage, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [compactionResponse as any, laterResponse];
      state._lastTurnResponse = laterResponse;
      state._generatedItems = [callItem, outputItem, anchoredItem, laterItem];
      state._lastProcessedResponse = {
        newItems: [laterItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'tool_search_call_item',
        'tool_search_output_item',
        'compaction_item',
        'message_output_item',
        'message_output_item',
      ]);
    });

    it('anchors a compaction-only response after an empty processed segment', async () => {
      const agent = new Agent({ name: 'EmptyLegacyCompactionSegmentAgent' });
      const earlierMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'earlier output' }],
      };
      const unknownItem: protocol.UnknownItem = {
        type: 'unknown',
        providerData: { type: 'future_output' },
      };
      const response = {
        usage: new Usage(),
        output: [unknownItem, compactionItem],
        responseId: 'response-empty-compaction-segment',
      };
      const earlierItem = new RunMessageOutputItem(earlierMessage, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [earlierItem];
      state._lastProcessedResponse = {
        newItems: [],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'message_output_item',
        'compaction_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['compaction_item']);
    });

    it('keeps trailing legacy compaction after a function approval wrapper', async () => {
      const approvalTool = tool({
        name: 'legacy_trailing_compaction_tool',
        description: 'Tool requiring approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      });
      const agent = new Agent({
        name: 'LegacyTrailingCompactionApprovalAgent',
        tools: [approvalTool],
      });
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_legacy_trailing_compaction',
        arguments: '{}',
        status: 'completed',
      };
      const response = {
        usage: new Usage(),
        output: [functionCall, compactionItem],
        responseId: 'response-trailing-compaction-interruption',
      };
      const callItem = new RunToolCallItem(functionCall, agent);
      const approvalItem = new ToolApprovalItem(functionCall, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [callItem, approvalItem];
      state._lastProcessedResponse = {
        newItems: [callItem],
        handoffs: [],
        functions: [{ toolCall: functionCall, tool: approvalTool as any }],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [approvalTool.name],
        hasToolsOrApprovalsToRun: () => true,
      };
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const session = new MemorySession();
      await saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      });

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_approval_item',
        'compaction_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['tool_call_item', 'compaction_item']);
      expect(restored._pendingLegacyCompactionSessionItems).toBeUndefined();
      expect(restored._currentTurnPersistedItemCount).toBe(2);

      await saveToSession(session, [], new RunResult(restored as any), {
        runCompaction: false,
      });
      expect((await session.getItems()).map((item) => item.type)).toEqual([
        'compaction',
      ]);
    });

    it('rehydrates legacy compaction with a hosted MCP approval', async () => {
      const mcpTool = hostedMcpTool({
        serverLabel: 'legacy_mcp',
        serverUrl: 'https://mcp.example.com/legacy',
        requireApproval: 'always',
      });
      const agent = new Agent({
        name: 'LegacyCompactionMcpAgent',
        tools: [mcpTool],
      });
      const approvalCall: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: 'approval_legacy_compaction',
        name: 'mcp_approval_request',
        status: 'completed',
        providerData: {
          type: 'mcp_approval_request',
          server_label: 'legacy_mcp',
          name: 'list_orders',
          id: 'approval_legacy_compaction',
          arguments: '{}',
        },
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, approvalCall],
        responseId: 'response-compaction-mcp-approval',
      };
      const processedResponse = processModelResponse(
        response,
        agent,
        [mcpTool],
        [],
      );
      const legacyItems = processedResponse.newItems.filter(
        (item) => !(item instanceof RunCompactionItem),
      );
      const approvalItem = legacyItems.find(
        (item): item is ToolApprovalItem => item instanceof ToolApprovalItem,
      );
      expect(approvalItem).toBeDefined();

      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = legacyItems;
      state._lastProcessedResponse = {
        ...processedResponse,
        newItems: legacyItems,
      };
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const session = new MemorySession();
      await saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      });

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'compaction_item',
        'tool_call_item',
        'tool_approval_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['compaction_item', 'tool_call_item', 'tool_approval_item']);
      expect(restored.getInterruptions()).toHaveLength(1);
      expect(restored._currentTurnPersistedItemCount).toBe(3);

      await saveToSession(session, [], new RunResult(restored as any), {
        runCompaction: false,
      });
      expect((await session.getItems()).map((item) => item.type)).toEqual([
        'compaction',
        'hosted_tool_call',
      ]);
    });

    it('rehydrates trailing legacy compaction after a hosted MCP approval', async () => {
      const mcpTool = hostedMcpTool({
        serverLabel: 'legacy_trailing_mcp',
        serverUrl: 'https://mcp.example.com/legacy-trailing',
        requireApproval: 'always',
      });
      const agent = new Agent({
        name: 'LegacyTrailingCompactionMcpAgent',
        tools: [mcpTool],
      });
      const approvalCall: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: 'approval_trailing_compaction',
        name: 'mcp_approval_request',
        status: 'completed',
        providerData: {
          type: 'mcp_approval_request',
          server_label: 'legacy_trailing_mcp',
          name: 'list_orders',
          id: 'approval_trailing_compaction',
          arguments: '{}',
        },
      };
      const response = {
        usage: new Usage(),
        output: [approvalCall, compactionItem],
        responseId: 'response-trailing-compaction-mcp-approval',
      };
      const processedResponse = processModelResponse(
        response,
        agent,
        [mcpTool],
        [],
      );
      const legacyItems = processedResponse.newItems.filter(
        (item) => !(item instanceof RunCompactionItem),
      );
      const approvalItem = legacyItems.find(
        (item): item is ToolApprovalItem => item instanceof ToolApprovalItem,
      );
      expect(approvalItem).toBeDefined();

      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = legacyItems;
      state._lastProcessedResponse = {
        ...processedResponse,
        newItems: legacyItems,
      };
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      const session = new MemorySession();
      await saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      });

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(restored._generatedItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_approval_item',
        'compaction_item',
      ]);
      expect(
        restored._lastProcessedResponse?.newItems.map((item) => item.type),
      ).toEqual(['tool_call_item', 'tool_approval_item', 'compaction_item']);
      expect(restored._pendingLegacyCompactionSessionItems).toBeUndefined();
      expect(restored._currentTurnPersistedItemCount).toBe(2);

      await saveToSession(session, [], new RunResult(restored as any), {
        runCompaction: false,
      });
      expect((await session.getItems()).map((item) => item.type)).toEqual([
        'compaction',
      ]);
    });

    it('rejects reordered provider output after legacy compaction', async () => {
      const agent = new Agent({ name: 'ReorderedLegacyCompactionAgent' });
      const firstMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'first' }],
      };
      const secondMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'second' }],
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, firstMessage, secondMessage],
        responseId: 'response-reordered-after-compaction',
      };
      const reorderedItems = [
        new RunMessageOutputItem(secondMessage, agent),
        new RunMessageOutputItem(firstMessage, agent),
      ];
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = reorderedItems;
      state._lastProcessedResponse = {
        newItems: reorderedItems,
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('rejects same-id provider output reordered across legacy compaction', async () => {
      const agent = new Agent({ name: 'DuplicateIdLegacyCompactionAgent' });
      const firstMessage: protocol.AssistantMessageItem = {
        id: 'msg_duplicate_compaction',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'first' }],
      };
      const secondMessage: protocol.AssistantMessageItem = {
        id: 'msg_duplicate_compaction',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'second' }],
      };
      const response = {
        usage: new Usage(),
        output: [firstMessage, compactionItem, secondMessage],
        responseId: 'response-duplicate-id-compaction',
      };
      const reorderedItems = [
        new RunMessageOutputItem(secondMessage, agent),
        new RunMessageOutputItem(firstMessage, agent),
      ];
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = reorderedItems;
      state._lastProcessedResponse = {
        newItems: reorderedItems,
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('rejects generated provider wrappers absent from the raw response', async () => {
      const agent = new Agent({ name: 'ExtraWrapperLegacyCompactionAgent' });
      const retainedMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'retained' }],
      };
      const extraMessage: protocol.AssistantMessageItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'extra' }],
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, retainedMessage],
        responseId: 'response-extra-wrapper-compaction',
      };
      const retainedItem = new RunMessageOutputItem(retainedMessage, agent);
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [
        retainedItem,
        new RunMessageOutputItem(extraMessage, agent),
      ];
      state._lastProcessedResponse = {
        newItems: [retainedItem],
        handoffs: [],
        functions: [],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => false,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('rejects processed and generated wrappers with different payloads', async () => {
      const approvalTool = tool({
        name: 'legacy_payload_mismatch_tool',
        description: 'Tool used to verify payload matching.',
        parameters: z.object({ value: z.number() }),
        execute: async () => 'done',
      });
      const agent = new Agent({
        name: 'PayloadMismatchLegacyCompactionAgent',
        tools: [approvalTool],
      });
      const rawCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: approvalTool.name,
        callId: 'call_payload_mismatch',
        arguments: '{"value":1}',
        status: 'completed',
      };
      const changedCall: protocol.FunctionCallItem = {
        ...rawCall,
        arguments: '{"value":2}',
      };
      const response = {
        usage: new Usage(),
        output: [compactionItem, rawCall],
        responseId: 'response-payload-mismatch-compaction',
      };
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._modelResponses = [response];
      state._lastTurnResponse = response;
      state._generatedItems = [new RunToolCallItem(changedCall, agent)];
      state._lastProcessedResponse = {
        newItems: [new RunToolCallItem(rawCall, agent)],
        handoffs: [],
        functions: [{ toolCall: rawCall, tool: approvalTool as any }],
        functionToolsNotFound: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [approvalTool.name],
        hasToolsOrApprovalsToRun: () => true,
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('rejects legacy compaction state when provider order is ambiguous', async () => {
      const agent = new Agent({ name: 'AmbiguousLegacyCompactionAgent' });
      const state = stateWithCompaction(agent);
      state._generatedItems = [
        new ToolApprovalItem(
          {
            type: 'function_call',
            name: 'missing_call',
            callId: 'call_missing_compaction_anchor',
            arguments: '{}',
            status: 'completed',
          },
          agent,
        ),
      ];
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('provider order is ambiguous');
    });

    it('rejects an older schema carrying a compaction run item', async () => {
      const agent = new Agent({ name: 'MislabeledCompactionAgent' });
      const serialized = stateWithCompaction(agent).toJSON() as any;
      serialized.$schemaVersion = '1.15';

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow('does not support compaction items');
    });
  });

  it('rejects pre-1.14 state with program-owned hosted calls', async () => {
    const agent = new Agent({ name: 'HostedProgramAgent' });
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'ci_1',
      name: 'code_interpreter_call',
      status: 'completed',
      caller: { type: 'program', callerId: 'call_prog_1' },
      providerData: { type: 'code_interpreter_call' },
    };
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state._generatedItems.push(new RunToolCallItem(hostedCall, agent));

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._generatedItems[0].rawItem).toEqual(hostedCall);

    const serialized = state.toJSON();
    serialized.$schemaVersion = '1.13';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow('does not support Programmatic Tool Calling items');
  });

  it('rechecks allowed callers against rebound tools during resume', async () => {
    const caller = {
      type: 'program' as const,
      callerId: 'call_program',
    };
    const createProcessedResponse = (
      overrides: Record<string, unknown>,
    ): NonNullable<RunState<any, any>['_lastProcessedResponse']> =>
      ({
        newItems: [],
        toolsUsed: [],
        handoffs: [],
        functions: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        hasToolsOrApprovalsToRun: () => true,
        ...overrides,
      }) as NonNullable<RunState<any, any>['_lastProcessedResponse']>;

    const savedFunction = tool({
      name: 'lookup',
      description: 'Look up a value.',
      parameters: z.object({}),
      allowedCallers: ['programmatic'],
      execute: async () => 'saved',
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'lookup',
      callId: 'call_function',
      arguments: '{}',
      caller,
    };
    const savedFunctionAgent = new Agent({
      name: 'FunctionResumeAgent',
      tools: [savedFunction],
    });
    const functionState = new RunState(
      new RunContext(),
      'input',
      savedFunctionAgent,
      1,
    );
    functionState._lastProcessedResponse = createProcessedResponse({
      functions: [{ toolCall: functionCall, tool: savedFunction }],
    });

    await expect(
      RunState.fromString(savedFunctionAgent, functionState.toString()),
    ).resolves.toBeInstanceOf(RunState);

    const reboundFunctionAgent = new Agent({
      name: 'FunctionResumeAgent',
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up a value.',
          parameters: z.object({}),
          execute: async () => 'rebound',
        }),
      ],
    });
    await expect(
      RunState.fromString(reboundFunctionAgent, functionState.toString()),
    ).rejects.toThrow(/caller programmatic/);

    const savedShell = shellTool({
      shell: new FakeShell(),
      allowedCallers: ['programmatic'],
    });
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      action: { commands: ['echo hi'] },
      caller,
    };
    const savedShellAgent = new Agent({
      name: 'ShellResumeAgent',
      tools: [savedShell],
    });
    const shellState = new RunState(
      new RunContext(),
      'input',
      savedShellAgent,
      1,
    );
    shellState._lastProcessedResponse = createProcessedResponse({
      shellActions: [{ toolCall: shellCall, shell: savedShell }],
    });
    const reboundShellAgent = new Agent({
      name: 'ShellResumeAgent',
      tools: [shellTool({ shell: new FakeShell() })],
    });
    await expect(
      RunState.fromString(reboundShellAgent, shellState.toString()),
    ).rejects.toThrow(/caller programmatic/);

    const savedApplyPatch = applyPatchTool({
      editor: new FakeEditor(),
      allowedCallers: ['programmatic'],
    });
    const applyPatchCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_apply_patch',
      status: 'completed',
      operation: { type: 'delete_file', path: 'temp.txt' },
      caller,
    };
    const savedApplyPatchAgent = new Agent({
      name: 'ApplyPatchResumeAgent',
      tools: [savedApplyPatch],
    });
    const applyPatchState = new RunState(
      new RunContext(),
      'input',
      savedApplyPatchAgent,
      1,
    );
    applyPatchState._lastProcessedResponse = createProcessedResponse({
      applyPatchActions: [
        { toolCall: applyPatchCall, applyPatch: savedApplyPatch },
      ],
    });
    const reboundApplyPatchAgent = new Agent({
      name: 'ApplyPatchResumeAgent',
      tools: [applyPatchTool({ editor: new FakeEditor() })],
    });
    await expect(
      RunState.fromString(reboundApplyPatchAgent, applyPatchState.toString()),
    ).rejects.toThrow(/caller programmatic/);

    const savedMcp = hostedMcpTool({
      serverLabel: 'inventory',
      serverUrl: 'https://inventory.example.com/mcp',
      requireApproval: 'always',
      allowedCallers: ['programmatic'],
    });
    const savedMcpAgent = new Agent({
      name: 'McpResumeAgent',
      tools: [savedMcp],
    });
    const mcpApprovalCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'lookup_inventory',
      status: 'in_progress',
      caller,
      providerData: {
        type: 'mcp_approval_request',
        id: 'approval_inventory',
        arguments: '{"sku":"sku_123"}',
        name: 'lookup_inventory',
        server_label: 'inventory',
      },
    };
    const mcpState = new RunState(new RunContext(), 'input', savedMcpAgent, 1);
    mcpState._lastProcessedResponse = createProcessedResponse({
      mcpApprovalRequests: [
        {
          requestItem: new ToolApprovalItem(mcpApprovalCall, savedMcpAgent),
          mcpTool: savedMcp,
        },
      ],
    });
    const reboundMcpAgent = new Agent({
      name: 'McpResumeAgent',
      tools: [
        hostedMcpTool({
          serverLabel: 'inventory',
          serverUrl: 'https://inventory.example.com/mcp',
          requireApproval: 'always',
        }),
      ],
    });
    await expect(
      RunState.fromString(reboundMcpAgent, mcpState.toString()),
    ).rejects.toThrow(/caller programmatic/);
  });

  it('accepts schema 1.13 application data that resembles PTC items', async () => {
    const context = new RunContext({
      nested: { type: 'program_output' },
    });
    context.toolInput = { type: 'program', callId: 'tool_input_program' };
    const agent = new Agent({ name: 'ProgramLikeDataAgent' });
    const state = new RunState(context, 'input', agent, 1);
    const rawItem: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'lookup',
      callId: 'call_program_like_data',
      status: 'completed',
      output: 'done',
      providerData: {
        nested: { type: 'program_output' },
      },
    };
    state._generatedItems.push(
      new RunToolCallOutputItem(rawItem, agent, 'done', {
        nested: { type: 'program', callId: 'custom_data_program' },
      }),
    );

    const serialized = state.toJSON();
    serialized.$schemaVersion = '1.13';

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );

    expect(restored._context.context).toEqual(context.context);
    expect(restored._context.toolInput).toEqual(context.toolInput);
    expect(restored._generatedItems[0].rawItem.providerData).toEqual(
      rawItem.providerData,
    );
    expect(
      (restored._generatedItems[0] as RunToolCallOutputItem).customData,
    ).toEqual({
      nested: { type: 'program', callId: 'custom_data_program' },
    });
  });

  it('throws error if schema version is missing or invalid', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent1' });
    const state = new RunState(context, 'input1', agent, 2);
    const jsonVersion = state.toJSON() as any;
    delete jsonVersion.$schemaVersion;

    const str = JSON.stringify(jsonVersion);
    await expect(() => RunState.fromString(agent, str)).rejects.toThrow(
      'Run state is missing schema version',
    );

    jsonVersion.$schemaVersion = '0.1';
    await expect(() =>
      RunState.fromString(agent, JSON.stringify(jsonVersion)),
    ).rejects.toThrow(
      `Run state schema version 0.1 is not supported. Please use version ${CURRENT_SCHEMA_VERSION}`,
    );
  });

  it('rejects schema version 1.12 payloads with tool output customData', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'CustomDataVersionAgent' });
    const state = new RunState(context, 'input1', agent, 2);
    const rawItem: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'lookup',
      callId: 'call_custom_data',
      status: 'completed',
      output: 'done',
    };
    state._generatedItems.push(
      new RunToolCallOutputItem(rawItem, agent, 'done', {
        auditId: 'audit_123',
      }),
    );

    const jsonVersion = state.toJSON() as any;
    expect(jsonVersion.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    jsonVersion.$schemaVersion = '1.12';

    await expect(() =>
      RunState.fromString(agent, JSON.stringify(jsonVersion)),
    ).rejects.toThrow(
      'Run state schema version 1.12 does not support tool output customData.',
    );
  });

  it('reads schema 1.15 approval keys and emits category-aware schema 1.16 state', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'ApprovalKeyMigrationAgent' });
    const state = new RunState(context, 'input', agent, 2);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'lookup',
      callId: 'legacy-call',
      status: 'completed',
      arguments: '{}',
    };
    state.reject(new ToolApprovalItem(rawItem, agent));

    const serialized = state.toJSON() as any;
    const categoryKey = getFunctionToolStateKeyForCall(rawItem)!;
    const ownerApprovals = serialized.context.functionApprovals.find(
      (entry: any) => entry.agentIdentity === agent.name,
    ).approvals;
    serialized.$schemaVersion = '1.15';
    serialized.context.approvals.lookup = ownerApprovals[categoryKey];
    delete serialized.context.functionApprovals;
    delete serialized.context.legacyFunctionApprovals;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );

    expect(
      restored._context.isToolApproved({
        toolName: 'lookup',
        callId: 'legacy-call',
      }),
    ).toBe(false);
    expect(restored.toJSON().$schemaVersion).toBe('1.16');
  });

  it('rehydrates schema 1.15 approval identity from enabled prepared tools', async () => {
    const enabledLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up a CRM record.',
          parameters: z.object({}),
          execute: async () => 'enabled',
        }),
      ],
    })[0]!;
    const disabledLookup = toolNamespace({
      name: 'crm',
      description: 'Disabled CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Disabled duplicate.',
          parameters: z.object({}),
          isEnabled: false,
          execute: async () => 'disabled',
        }),
      ],
    })[0]!;
    const agent = new Agent({
      name: 'LegacyApprovalAgent',
      tools: [enabledLookup, disabledLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'lookup',
      namespace: 'crm',
      callId: 'legacy-approval-call',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: rawItem, tool: enabledLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['crm.lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [new ToolApprovalItem(rawItem, agent)],
      },
    };

    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';
    delete serialized.currentStep.data.interruptions[0].functionToolStateKey;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    const [approvalItem] = restored.getInterruptions();

    expect(approvalItem.functionToolStateKey).toBe(
      getFunctionToolStateKey(enabledLookup),
    );
    restored.approve(approvalItem);
    expect(
      restored._context.isToolApproved({
        toolName: getFunctionToolStateKey(enabledLookup)!,
        callId: rawItem.callId,
      }),
    ).toBe(true);
  });

  it.each(['namespaced', 'dotted'] as const)(
    'migrates schema 1.15 pending nested state for the exact %s tool category',
    async (pendingCategory) => {
      const dottedLookup = tool({
        name: 'crm_lookup',
        description: 'Look up a dotted CRM record.',
        parameters: z.object({}),
        execute: async () => 'dotted',
      });
      dottedLookup.name = 'crm.lookup';
      const namespacedLookup = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Look up a namespaced CRM record.',
            parameters: z.object({}),
            execute: async () => 'namespaced',
          }),
        ],
      })[0]!;
      const pendingTool =
        pendingCategory === 'namespaced' ? namespacedLookup : dottedLookup;
      const toolCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: pendingCategory === 'namespaced' ? 'lookup' : 'crm.lookup',
        ...(pendingCategory === 'namespaced' ? { namespace: 'crm' } : {}),
        callId: `legacy-${pendingCategory}-call`,
        status: 'completed',
        arguments: '{}',
      };
      const agent = new Agent({
        name: `LegacyPending${pendingCategory}`,
        tools: [dottedLookup, namespacedLookup],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._lastProcessedResponse = {
        newItems: [],
        functions: [{ toolCall, tool: pendingTool as any }],
        handoffs: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: ['crm.lookup'],
        hasToolsOrApprovalsToRun: () => true,
      };
      state.setPendingAgentToolRun(
        'crm.lookup',
        toolCall.callId,
        `${pendingCategory}-state`,
      );

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      delete serialized.pendingAgentToolRunAliases;

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const canonicalKey = getFunctionToolStateKey(pendingTool)!;

      expect(
        restored.getPendingAgentToolRun(canonicalKey, toolCall.callId),
      ).toBe(`${pendingCategory}-state`);
      expect(
        restored.getPendingAgentToolRun('crm.lookup', toolCall.callId),
      ).toBe(`${pendingCategory}-state`);
      expect(restored._pendingAgentToolRuns.size).toBe(1);
    },
  );

  it('migrates pending schema 1.15 approvals while preserving ambiguous permanent owners', async () => {
    const decisions = [
      {
        name: 'approved call',
        record: (callId: string) => ({
          approved: [callId],
          rejected: [],
        }),
        expected: true,
      },
      {
        name: 'rejected call',
        record: (callId: string) => ({
          approved: [],
          rejected: [callId],
          messages: { [callId]: 'Rejected once' },
        }),
        expected: false,
        message: 'Rejected once',
      },
      {
        name: 'permanent approval',
        record: () => ({ approved: true, rejected: [] }),
        expected: true,
      },
      {
        name: 'permanent rejection',
        record: (callId: string) => ({
          approved: false,
          rejected: true,
          messages: { [callId]: 'Always rejected' },
          stickyRejectMessage: 'Always rejected',
        }),
        expected: false,
        message: 'Always rejected',
      },
    ];

    for (const pair of ['bare-deferred', 'dotted-namespaced'] as const) {
      for (const decision of decisions) {
        const bareTool = tool({
          name: pair === 'bare-deferred' ? 'lookup' : 'crm_lookup',
          description: 'Bare lookup.',
          parameters: z.object({}),
          execute: async () => 'bare',
        });
        if (pair === 'dotted-namespaced') {
          bareTool.name = 'crm.lookup';
        }
        const structuredTool =
          pair === 'bare-deferred'
            ? tool({
                name: 'lookup',
                description: 'Deferred lookup.',
                parameters: z.object({}),
                deferLoading: true,
                execute: async () => 'deferred',
              })
            : toolNamespace({
                name: 'crm',
                description: 'CRM tools.',
                tools: [
                  tool({
                    name: 'lookup',
                    description: 'Namespaced lookup.',
                    parameters: z.object({}),
                    execute: async () => 'namespaced',
                  }),
                ],
              })[0]!;
        const callId = `${pair}-${decision.name.replace(/ /g, '-')}`;
        const toolCall: protocol.FunctionCallItem = {
          type: 'function_call',
          name: 'lookup',
          namespace: pair === 'bare-deferred' ? 'lookup' : 'crm',
          callId,
          status: 'completed',
          arguments: '{}',
        };
        const legacyKey = pair === 'bare-deferred' ? 'lookup' : 'crm.lookup';
        const agent = new Agent({
          name: `LegacyApproval-${pair}-${decision.name}`,
          tools: [bareTool, structuredTool],
        });
        const state = new RunState(new RunContext(), 'input', agent, 2);
        state._lastProcessedResponse = {
          newItems: [],
          functions: [{ toolCall, tool: structuredTool as any }],
          handoffs: [],
          computerActions: [],
          shellActions: [],
          applyPatchActions: [],
          mcpApprovalRequests: [],
          toolsUsed: [legacyKey],
          hasToolsOrApprovalsToRun: () => true,
        };
        state._currentStep = {
          type: 'next_step_interruption',
          data: {
            interruptions: [new ToolApprovalItem(toolCall, agent)],
          },
        };

        const serialized = state.toJSON() as any;
        serialized.$schemaVersion = '1.15';
        serialized.context.approvals = {
          [legacyKey]: decision.record(callId),
        };
        delete serialized.currentStep.data.interruptions[0]
          .functionToolStateKey;

        const restored = await RunState.fromString(
          agent,
          JSON.stringify(serialized),
        );
        const canonicalKey = getFunctionToolStateKey(structuredTool)!;
        const isPermanent = decision.name.startsWith('permanent');

        expect(
          restored._context.isToolApproved({
            toolName: canonicalKey,
            callId,
          }),
          `${pair}: ${decision.name}`,
        ).toBe(decision.expected);
        expect(
          restored._context.getRejectionMessage(canonicalKey, callId),
        ).toBe(decision.message);
        expect(
          restored._context.isToolApproved({
            toolName: canonicalKey,
            callId: `${callId}-future`,
          }),
        ).toBe(isPermanent ? decision.expected : undefined);
        expect(
          restored._context.isToolApproved({
            toolName: legacyKey,
            callId,
          }),
          `${pair}: ${decision.name} legacy owner`,
        ).toBe(isPermanent ? decision.expected : undefined);
        expect(
          restored._context.isToolApproved({
            toolName: legacyKey,
            callId: `${callId}-future`,
          }),
          `${pair}: ${decision.name} future legacy owner`,
        ).toBe(isPermanent ? decision.expected : undefined);
      }
    }
  });

  it.each([
    ['permanent approval', { approved: true, rejected: [] }, true, undefined],
    [
      'permanent rejection',
      {
        approved: false,
        rejected: true,
        stickyRejectMessage: 'Always rejected',
      },
      false,
      'Always rejected',
    ],
  ] as const)(
    'migrates a schema 1.15 %s when the legacy function owner is unique',
    async (_name, approvalRecord, expectedApproval, expectedMessage) => {
      const namespacedLookup = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Namespaced lookup.',
            parameters: z.object({}),
            execute: async () => 'namespaced',
          }),
        ],
      })[0]!;
      const callId = 'unique-owner-call';
      const toolCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'lookup',
        namespace: 'crm',
        callId,
        status: 'completed',
        arguments: '{}',
      };
      const agent = new Agent({
        name: 'UniqueLegacyApprovalOwner',
        tools: [namespacedLookup],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._lastProcessedResponse = {
        newItems: [],
        functions: [{ toolCall, tool: namespacedLookup as any }],
        handoffs: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: ['crm.lookup'],
        hasToolsOrApprovalsToRun: () => true,
      };

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      serialized.context.approvals = {
        'crm.lookup': approvalRecord,
      };

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const canonicalKey = getFunctionToolStateKey(namespacedLookup)!;

      expect(
        restored._context.isToolApproved({
          toolName: canonicalKey,
          callId,
        }),
      ).toBe(expectedApproval);
      expect(restored._context.getRejectionMessage(canonicalKey, callId)).toBe(
        expectedMessage,
      );
      expect(
        restored._context.isToolApproved({
          toolName: 'crm.lookup',
          callId,
        }),
      ).toBeUndefined();
      const publicApproval = restored._context.toJSON().approvals['crm.lookup'];
      expect(publicApproval).toBeDefined();
      expect(publicApproval.approved === true).toBe(
        approvalRecord.approved === true,
      );
      expect(publicApproval.rejected === true).toBe(
        approvalRecord.rejected === true,
      );
      expect(
        restored._context.toJSON().approvals[canonicalKey],
      ).toBeUndefined();

      const durable = restored.toJSON() as any;
      expect(durable.context.approvals['crm.lookup']).toBeUndefined();
      const durableApproval = durable.context.functionApprovals.find(
        (entry: any) => entry.agentIdentity === agent.name,
      ).approvals[canonicalKey];
      expect(durableApproval.approved === true).toBe(
        approvalRecord.approved === true,
      );
      expect(durableApproval.rejected === true).toBe(
        approvalRecord.rejected === true,
      );
    },
  );

  it('migrates a unique schema 1.15 permanent owner without a current call', async () => {
    const namespacedLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Namespaced lookup.',
          parameters: z.object({}),
          execute: async () => 'namespaced',
        }),
      ],
    })[0]!;
    const agent = new Agent({
      name: 'Unique inactive legacy approval owner',
      tools: [namespacedLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);

    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';
    serialized.context.approvals = {
      'crm.lookup': { approved: true, rejected: [] },
    };

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    const canonicalKey = getFunctionToolStateKey(namespacedLookup)!;

    expect(
      restored._context.isToolApproved({
        toolName: canonicalKey,
        callId: 'future_call',
      }),
    ).toBe(true);
    expect(
      restored._context.isToolApproved({
        toolName: 'crm.lookup',
        callId: 'future_call',
      }),
    ).toBeUndefined();
    const durable = restored.toJSON() as any;
    expect(durable.context.approvals['crm.lookup']).toBeUndefined();
    expect(durable.context.legacyFunctionApprovals).toBeUndefined();
    expect(
      durable.context.functionApprovals[0].approvals[canonicalKey],
    ).toMatchObject({ approved: true, rejected: [] });
  });

  it('migrates a unique schema 1.15 approval owned by an inactive child agent', async () => {
    const childLookup = toolNamespace({
      name: 'crm',
      description: 'Child CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Child namespaced lookup.',
          parameters: z.object({}),
          execute: async () => 'child',
        }),
      ],
    })[0]!;
    const childAgent = new Agent({
      name: 'Inactive legacy approval child',
      tools: [childLookup],
    });
    const rootAgent = new Agent({
      name: 'Inactive legacy approval root',
      tools: [
        childAgent.asTool({
          toolName: 'run_child',
          toolDescription: 'Runs the child agent.',
        }),
      ],
    });
    const state = new RunState(new RunContext(), 'input', rootAgent, 2);
    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';
    serialized.context.approvals = {
      'crm.lookup': { approved: true, rejected: [] },
    };

    const restored = await RunState.fromString(
      rootAgent,
      JSON.stringify(serialized),
    );
    const canonicalKey = getFunctionToolStateKey(childLookup)!;

    expect(
      restored._context.isToolApproved({
        toolName: canonicalKey,
        callId: 'future_child_call',
        functionTool: false,
        agent: childAgent,
      }),
    ).toBe(true);
    const durable = restored.toJSON() as any;
    expect(durable.context.approvals['crm.lookup']).toBeUndefined();
    expect(durable.context.legacyFunctionApprovals).toBeUndefined();
    expect(
      durable.context.functionApprovals.find(
        (entry: any) => entry.agentIdentity === childAgent.name,
      ).approvals[canonicalKey],
    ).toMatchObject({ approved: true, rejected: [] });
  });

  it('keeps an exact non-function override separate from an inactive schema 1.15 function owner', async () => {
    const namespacedLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Namespaced lookup.',
          parameters: z.object({}),
          execute: async () => 'namespaced',
        }),
      ],
    })[0]!;
    const otherTool = tool({
      name: 'other_tool',
      description: 'Other tool.',
      parameters: z.object({}),
      execute: async () => 'other',
    });
    const otherCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'other_tool',
      callId: 'merge_other_call',
      status: 'completed',
      arguments: '{}',
    };
    const agent = new Agent({
      name: 'Inactive merge approval owner',
      tools: [namespacedLookup, otherTool],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._lastProcessedResponse = {
      newItems: [],
      functions: [
        {
          toolCall: otherCall,
          tool: otherTool as any,
          availableFunctionTools: [namespacedLookup, otherTool] as any,
        },
      ],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['other_tool'],
      hasToolsOrApprovalsToRun: () => true,
    };
    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';
    serialized.context.approvals = {
      'crm.lookup': { approved: true, rejected: [] },
    };
    const overrideContext = new RunContext();
    overrideContext.rejectTool(
      new ToolApprovalItem(
        {
          type: 'shell_call',
          callId: 'shell_crm_lookup',
          status: 'completed',
          action: { commands: ['echo rejected'] },
        },
        agent,
        'crm.lookup',
      ),
      { alwaysReject: true },
    );

    const restored = await RunState.fromStringWithContext(
      agent,
      JSON.stringify(serialized),
      overrideContext,
      { contextStrategy: 'merge' },
    );
    const canonicalKey = getFunctionToolStateKey(namespacedLookup)!;

    expect(
      restored._context.isToolApproved({
        toolName: canonicalKey,
        callId: 'future_function_call',
      }),
    ).toBe(true);
    expect(
      restored._context.isToolApproved({
        toolName: 'crm.lookup',
        callId: 'future_shell_call',
        functionTool: false,
      }),
    ).toBe(false);
  });

  it('keeps ambiguous legacy function fallback separate from an exact non-function override', async () => {
    const dottedLookup = tool({
      name: 'crm_lookup',
      description: 'Dotted lookup.',
      parameters: z.object({}),
      execute: async () => 'dotted',
    });
    dottedLookup.name = 'crm.lookup';
    const namespacedLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Namespaced lookup.',
          parameters: z.object({}),
          execute: async () => 'namespaced',
        }),
      ],
    })[0]!;
    const callId = 'ambiguous_merge_call';
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'lookup',
      namespace: 'crm',
      callId,
      status: 'completed',
      arguments: '{}',
    };
    const agent = new Agent({
      name: 'Ambiguous legacy fallback merge',
      tools: [dottedLookup, namespacedLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall, tool: namespacedLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['crm.lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };
    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';
    serialized.context.approvals = {
      'crm.lookup': {
        approved: false,
        rejected: true,
        stickyRejectMessage: 'Legacy rejection',
      },
    };

    const overrideContext = new RunContext();
    overrideContext.approveTool(
      new ToolApprovalItem(
        {
          type: 'shell_call',
          callId: 'shell_override_call',
          status: 'completed',
          action: { commands: ['echo approved'] },
        },
        agent,
        'crm.lookup',
      ),
      { alwaysApprove: true },
    );

    const restored = await RunState.fromStringWithContext(
      agent,
      JSON.stringify(serialized),
      overrideContext,
      { contextStrategy: 'merge' },
    );
    const namespacedKey = getFunctionToolStateKey(namespacedLookup)!;
    const dottedKey = getFunctionToolStateKey(dottedLookup)!;

    for (const [toolName, checkedCallId] of [
      [namespacedKey, callId],
      [namespacedKey, 'future_namespaced_call'],
      [dottedKey, 'future_dotted_call'],
    ] as const) {
      expect(
        restored._context.isToolApproved({
          toolName,
          callId: checkedCallId,
          functionTool: false,
          agent,
        }),
      ).toBe(false);
    }
    expect(
      restored._context.isToolApproved({
        toolName: 'crm.lookup',
        callId: 'future_shell_call',
        functionTool: false,
      }),
    ).toBe(true);

    const durable = restored.toJSON() as any;
    expect(durable.context.approvals['crm.lookup'].approved).toBe(true);
    expect(durable.context.legacyFunctionApprovals['crm.lookup'].rejected).toBe(
      true,
    );

    const roundTripped = await RunState.fromString(agent, restored.toString());
    expect(
      roundTripped._context.isToolApproved({
        toolName: dottedKey,
        callId: 'round_trip_function_call',
        functionTool: false,
        agent,
      }),
    ).toBe(false);
    expect(
      roundTripped._context.isToolApproved({
        toolName: 'crm.lookup',
        callId: 'round_trip_shell_call',
        functionTool: false,
      }),
    ).toBe(true);
  });

  it('keeps schema 1.15 approval ownership when merging a canonical override context', async () => {
    const decisions = [
      {
        name: 'per-call approval',
        record: (callId: string) => ({
          approved: [callId],
          rejected: [],
        }),
        expected: true,
      },
      {
        name: 'permanent rejection',
        record: (callId: string) => ({
          approved: false,
          rejected: true,
          messages: { [callId]: 'Always rejected' },
          stickyRejectMessage: 'Always rejected',
        }),
        expected: false,
        message: 'Always rejected',
      },
    ];

    for (const decision of decisions) {
      const dottedLookup = tool({
        name: 'crm_lookup',
        description: 'Dotted lookup.',
        parameters: z.object({}),
        execute: async () => 'dotted',
      });
      dottedLookup.name = 'crm.lookup';
      const namespacedLookup = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Namespaced lookup.',
            parameters: z.object({}),
            execute: async () => 'namespaced',
          }),
        ],
      })[0]!;
      const agent = new Agent({
        name: `MergeApproval-${decision.name}`,
        tools: [dottedLookup, namespacedLookup],
      });
      const callId = `namespaced-${decision.name.replace(/ /g, '-')}`;
      const namespacedCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'lookup',
        namespace: 'crm',
        callId,
        status: 'completed',
        arguments: '{}',
      };
      const state = new RunState(new RunContext(), 'input', agent, 2);
      state._lastProcessedResponse = {
        newItems: [],
        functions: [
          { toolCall: namespacedCall, tool: namespacedLookup as any },
        ],
        handoffs: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: ['crm.lookup'],
        hasToolsOrApprovalsToRun: () => true,
      };
      state._currentStep = {
        type: 'next_step_interruption',
        data: {
          interruptions: [new ToolApprovalItem(namespacedCall, agent)],
        },
      };
      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = '1.15';
      serialized.context.approvals = {
        'crm.lookup': decision.record(callId),
        other: {
          approved: ['serialized-other-call'],
          rejected: [],
        },
      };
      delete serialized.currentStep.data.interruptions[0].functionToolStateKey;

      const overrideContext = new RunContext();
      const existingBareCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'crm.lookup',
        callId: 'existing-bare-call',
        status: 'completed',
        arguments: '{}',
      };
      overrideContext.approveTool(
        new ToolApprovalItem(
          existingBareCall,
          agent,
          undefined,
          getFunctionToolStateKey(dottedLookup),
        ),
      );
      overrideContext.approveTool(
        new ToolApprovalItem(
          {
            type: 'function_call',
            name: 'other',
            callId: 'override-other-call',
            status: 'completed',
            arguments: '{}',
          },
          agent,
        ),
      );
      overrideContext.approveTool(
        new ToolApprovalItem(
          {
            type: 'shell_call',
            callId: 'override-shell-call',
            status: 'completed',
            action: { commands: ['echo approved'] },
          },
          agent,
          'crm.lookup',
        ),
        { alwaysApprove: true },
      );

      const restored = await RunState.fromStringWithContext(
        agent,
        JSON.stringify(serialized),
        overrideContext,
        { contextStrategy: 'merge' },
      );
      const namespacedKey = getFunctionToolStateKey(namespacedLookup)!;
      const bareKey = getFunctionToolStateKey(dottedLookup)!;
      const isPermanent = decision.name.startsWith('permanent');

      expect(
        restored._context.isToolApproved({
          toolName: namespacedKey,
          callId,
        }),
        decision.name,
      ).toBe(decision.expected);
      expect(restored._context.getRejectionMessage(namespacedKey, callId)).toBe(
        decision.message,
      );
      expect(
        restored._context.isToolApproved({
          toolName: namespacedKey,
          callId: `${callId}-future`,
        }),
      ).toBe(isPermanent ? decision.expected : undefined);
      expect(
        restored._context.isToolApproved({
          toolName: 'crm.lookup',
          callId,
          functionTool: false,
        }),
      ).toBe(true);
      expect(
        restored._context.getRejectionMessage('crm.lookup', callId, {
          functionTool: false,
        }),
      ).toBeUndefined();
      expect(
        restored._context.isToolApproved({
          toolName: bareKey,
          callId: 'existing-bare-call',
          agent,
        }),
      ).toBe(true);
      expect(
        restored._context.isToolApproved({
          toolName: bareKey,
          callId: 'future-bare-call',
          agent,
        }),
      ).toBe(isPermanent ? decision.expected : undefined);
      expect(
        restored._context.isToolApproved({
          toolName: 'other',
          callId: 'serialized-other-call',
          functionTool: false,
        }),
      ).toBe(true);
      expect(
        restored._context.isToolApproved({
          toolName: '["bare","other"]',
          callId: 'override-other-call',
        }),
      ).toBe(true);
      expect(
        restored._context.isToolApproved({
          toolName: '["bare","other"]',
          callId: 'serialized-other-call',
        }),
      ).toBeUndefined();
      expect(
        restored._context.isToolApproved({
          toolName: 'other',
          callId: 'override-other-call',
          functionTool: false,
        }),
      ).toBeUndefined();
    }
  });

  it('accepts schema version 1.6 payloads during deserialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent16' });
    const state = new RunState(context, 'input1', agent, 2);
    state._modelResponses = [
      {
        usage: new Usage(),
        output: [TEST_MODEL_MESSAGE],
        responseId: 'resp_16',
        requestId: 'req_16',
      },
    ];
    state._lastTurnResponse = state._modelResponses[0];

    const jsonVersion = state.toJSON() as any;
    jsonVersion.$schemaVersion = '1.6';

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(jsonVersion),
    );

    expect(restored._lastTurnResponse?.responseId).toBe('resp_16');
    expect(restored._lastTurnResponse?.requestId).toBe('req_16');
  });

  it('rejects schema version 1.7 payloads with tool_search items during deserialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent18' });
    const state = new RunState(context, 'input1', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_17',
          callId: 'ts_call_17',
          status: 'completed',
          arguments: { paths: ['crm'], query: 'profile' },
        } as any,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_17',
          callId: 'ts_call_17',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'crm',
            },
          ],
        } as any,
        agent,
      ),
    );

    const jsonVersion = state.toJSON() as any;
    jsonVersion.$schemaVersion = '1.7';

    await expect(() =>
      RunState.fromString(agent, JSON.stringify(jsonVersion)),
    ).rejects.toThrow(
      'Run state schema version 1.7 does not support tool_search items.',
    );
  });

  it('accepts schema versions with tool_search support during deserialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent18' });
    const state = new RunState(context, 'input1', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_18',
          callId: 'ts_call_18',
          status: 'completed',
          arguments: { paths: ['crm'], query: 'profile' },
        } as any,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_18',
          callId: 'ts_call_18',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'crm',
            },
          ],
        } as any,
        agent,
      ),
    );

    for (const $schemaVersion of ['1.8', '1.10', '1.11'] as const) {
      const jsonVersion = state.toJSON() as any;
      jsonVersion.$schemaVersion = $schemaVersion;
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(jsonVersion),
      );

      expect(restored._generatedItems[0]).toBeInstanceOf(RunToolSearchCallItem);
      expect(restored._generatedItems[1]).toBeInstanceOf(
        RunToolSearchOutputItem,
      );
    }
  });

  it('preserves raw tool_search call_id and execution fields through RunState serialization', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent18RawSearch' });
    const state = new RunState(context, 'input1', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_raw',
          call_id: 'call_ts_raw',
          execution: 'server',
          status: 'completed',
          arguments: { paths: ['crm'], query: 'profile' },
        } as any,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_raw',
          call_id: 'call_ts_raw',
          execution: 'server',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'crm',
            },
          ],
        } as any,
        agent,
      ),
    );

    const restored = await RunState.fromString(agent, state.toString());
    const restoredCall = restored._generatedItems[0] as RunToolSearchCallItem;
    const restoredOutput = restored
      ._generatedItems[1] as RunToolSearchOutputItem;

    expect(restoredCall.rawItem).toMatchObject({
      type: 'tool_search_call',
      call_id: 'call_ts_raw',
      execution: 'server',
    });
    expect(restoredOutput.rawItem).toMatchObject({
      type: 'tool_search_output',
      call_id: 'call_ts_raw',
      execution: 'server',
    });
  });

  it('rehydrates client tool_search outputs without explicit call_id by FIFO order', async () => {
    const runtimeLookup = tool({
      name: 'lookup_runtime',
      description: 'Look up a runtime record.',
      parameters: z.object({}),
      execute: async () => 'runtime',
    });
    const execute = vi.fn(async () => runtimeLookup);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'No call id tool-search restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_without_call_id',
          execution: 'client',
          status: 'completed',
          arguments: {},
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_without_call_id',
          execution: 'client',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup_runtime',
              description: 'Look up a runtime record.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    const restored = await RunState.fromString(agent, state.toString());

    expect(execute).toHaveBeenCalledOnce();
    expect(
      await (restored.getToolSearchRuntimeTools(agent)[0] as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('runtime');
  });

  it('skips rehydration for server tool_search outputs with concrete tool payloads', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent18ServerSearchConcrete' });
    const state = new RunState(context, 'input1', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_server_concrete',
          call_id: 'call_ts_server_concrete',
          execution: 'server',
          status: 'completed',
          arguments: { query: 'profile' },
        } as any,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_server_concrete',
          call_id: 'call_ts_server_concrete',
          execution: 'server',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup_account',
              description: 'Look up an account.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {
                  customerId: {
                    type: 'string',
                  },
                },
                required: ['customerId'],
                additionalProperties: false,
              },
            },
          ],
        } as any,
        agent,
      ),
    );

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored._generatedItems[0]).toBeInstanceOf(RunToolSearchCallItem);
    expect(restored._generatedItems[1]).toBeInstanceOf(RunToolSearchOutputItem);
    expect(restored.getToolSearchRuntimeTools(agent)).toEqual([]);
  });

  it('rehydrates duplicate-name client tool_search calls by agent identity', async () => {
    const alphaLookup = tool({
      name: 'lookup_alpha',
      description: 'Look up alpha data.',
      parameters: z.object({}).strict(),
      execute: async () => 'alpha',
    });
    const betaLookup = tool({
      name: 'lookup_beta',
      description: 'Look up beta data.',
      parameters: z.object({}).strict(),
      execute: async () => 'beta',
    });
    let alphaExecuteCount = 0;
    let betaExecuteCount = 0;
    const alphaToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
      async () => {
        alphaExecuteCount += 1;
        return alphaLookup;
      },
    );
    const betaToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
      async () => {
        betaExecuteCount += 1;
        return betaLookup;
      },
    );
    const alphaAgent = new Agent({
      name: 'SharedSkill',
      instructions: 'alpha agent',
      tools: [alphaToolSearch],
    });
    const betaAgent = new Agent({
      name: 'SharedSkill',
      instructions: 'beta agent',
      tools: [betaToolSearch],
    });
    const root = new Agent({
      name: 'Root',
      handoffs: [alphaAgent, betaAgent],
    });
    const state = new RunState(new RunContext(), 'input1', root, 2);
    const sharedCallId = 'call_tool_search_shared';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_alpha',
          status: 'completed',
          arguments: {},
          providerData: {
            call_id: sharedCallId,
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        alphaAgent,
      ),
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_beta',
          status: 'completed',
          arguments: {},
          providerData: {
            call_id: sharedCallId,
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        betaAgent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_alpha',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup_alpha',
              description: 'Look up alpha data.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: {
            call_id: sharedCallId,
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        alphaAgent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_beta',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup_beta',
              description: 'Look up beta data.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: {
            call_id: sharedCallId,
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        betaAgent,
      ),
    );

    const restored = await RunState.fromString(root, state.toString());

    expect(alphaExecuteCount).toBe(1);
    expect(betaExecuteCount).toBe(1);
    expect(restored.getToolSearchRuntimeTools(alphaAgent)).toEqual([
      alphaLookup,
    ]);
    expect(restored.getToolSearchRuntimeTools(betaAgent)).toEqual([betaLookup]);
  });

  it('uses the collision-filtered tool winner during tool-search rehydration', async () => {
    const firstDuplicate = tool({
      name: 'duplicate',
      description: 'First duplicate.',
      parameters: z.object({}).strict(),
      execute: async () => 'first',
    });
    const winningDuplicate = tool({
      name: 'duplicate',
      description: 'Winning duplicate.',
      parameters: z.object({}).strict(),
      execute: async () => 'winner',
    });
    const losingRuntimeTool = tool({
      name: 'losing_runtime',
      description: 'Runtime tool selected from the unfiltered list.',
      parameters: z.object({}).strict(),
      execute: async () => 'losing runtime',
    });
    const winningRuntimeTool = tool({
      name: 'winning_runtime',
      description: 'Runtime tool selected from the filtered list.',
      parameters: z.object({}).strict(),
      execute: async () => 'winning runtime',
    });
    const execute = vi.fn(
      async ({ availableTools }: { availableTools: Tool<any>[] }) => {
        const selectedDuplicate = availableTools.find(
          (candidate) =>
            candidate.type === 'function' && candidate.name === 'duplicate',
        );
        return selectedDuplicate === winningDuplicate
          ? winningRuntimeTool
          : losingRuntimeTool;
      },
    );
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
        },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Collision-filtered restore agent',
      tools: [firstDuplicate, winningDuplicate, clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_collision_filtered_restore';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_collision_filtered_restore',
          status: 'completed',
          arguments: { query: 'runtime' },
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_collision_filtered_restore',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'winning_runtime',
              description: 'Runtime tool selected from the filtered list.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    allowConsole(['warn']);
    const restored = await RunState.fromString(agent, state.toString());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].availableTools).toEqual([
      winningDuplicate,
      clientToolSearch,
    ]);
    expect(restored.getToolSearchRuntimeTools(agent)).toEqual([
      winningRuntimeTool,
    ]);
  });

  it('freezes collision-filtered capabilities across tool-search rehydration callbacks', async () => {
    type TestContext = {
      functionEnabled: boolean;
      handoffEnabled: boolean;
    };

    const transferFunction = tool({
      name: 'transfer',
      description: 'Function with the same name as a dynamic handoff.',
      parameters: z.object({}).strict(),
      isEnabled: ({ runContext }) =>
        (runContext.context as TestContext).functionEnabled,
      execute: async () => 'function',
    });
    const firstRuntimeTool = tool({
      name: 'first_runtime',
      description: 'First runtime tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'first runtime',
    });
    const secondRuntimeTool = tool({
      name: 'second_runtime',
      description: 'Second runtime tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'second runtime',
    });
    const availableToolSnapshots: Tool<any>[][] = [];
    const execute = vi.fn(
      async ({
        availableTools,
        runContext,
      }: {
        availableTools: Tool<TestContext>[];
        runContext: RunContext<TestContext>;
      }) => {
        availableToolSnapshots.push(availableTools);
        if (availableToolSnapshots.length === 1) {
          runContext.context.functionEnabled = false;
          runContext.context.handoffEnabled = true;
          return firstRuntimeTool;
        }
        return secondRuntimeTool;
      },
    );
    const clientToolSearch = attachClientToolSearchExecutor<TestContext>(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
        },
      },
      execute,
    );
    const target = new Agent<TestContext>({ name: 'Dynamic target' });
    const agent = new Agent<TestContext>({
      name: 'Frozen capability restore agent',
      tools: [transferFunction, clientToolSearch],
      handoffs: [
        handoff(target, {
          toolNameOverride: 'transfer',
          isEnabled: ({ runContext }) => runContext.context.handoffEnabled,
        }),
      ],
    });
    const state = new RunState(
      new RunContext({ functionEnabled: true, handoffEnabled: false }),
      'input',
      agent,
      2,
    );
    const processedToolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_frozen_capability_restore',
      callId: 'call_frozen_capability_restore',
      name: 'transfer',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [
        { toolCall: processedToolCall, tool: transferFunction as any },
      ],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['transfer'],
      hasToolsOrApprovalsToRun: () => true,
    };
    const addSerializedToolSearchResult = (
      callId: string,
      runtimeToolName: string,
    ) => {
      state._generatedItems.push(
        new RunToolSearchCallItem(
          {
            type: 'tool_search_call',
            id: `ts_${callId}`,
            status: 'completed',
            arguments: { query: runtimeToolName },
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchCallItem,
          agent as Agent<any, any>,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            id: `tso_${callId}`,
            status: 'completed',
            tools: [
              {
                type: 'function',
                name: runtimeToolName,
                description: `${runtimeToolName} description.`,
                strict: true,
                parameters: {
                  type: 'object',
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchOutputItem,
          agent as Agent<any, any>,
        ),
      );
    };
    addSerializedToolSearchResult('call_first', 'first_runtime');
    addSerializedToolSearchResult('call_second', 'second_runtime');

    const restored = await RunState.fromString(agent, state.toString());

    expect(execute).toHaveBeenCalledTimes(2);
    expect(availableToolSnapshots).toEqual([
      [transferFunction, clientToolSearch],
      [transferFunction, clientToolSearch, firstRuntimeTool],
    ]);
    expect(restored.getToolSearchRuntimeTools(agent)).toEqual([
      firstRuntimeTool,
      secondRuntimeTool,
    ]);
    expect(restored._lastProcessedResponse?.functions[0]?.tool).toBe(
      transferFunction,
    );
  });

  it.each(['bare', 'namespaced', 'deferred'] as const)(
    'round-trips the final same-key %s runtime tool from distinct tool-search calls',
    async (kind) => {
      const availableToolNames: string[][] = [];
      const execute = vi.fn(
        async ({
          availableTools,
          toolCall,
        }: {
          availableTools: Tool<any>[];
          toolCall: protocol.ToolSearchCallItem;
        }) => {
          availableToolNames.push(availableTools.map((entry) => entry.name));
          const result = String(
            (toolCall.arguments as { result?: string }).result,
          );
          const runtimeTool = tool({
            name: 'lookup',
            description: `${result} lookup result.`,
            parameters: z.object({}).strict(),
            ...(kind === 'deferred' ? { deferLoading: true } : {}),
            execute: async () => result,
          });
          return kind === 'namespaced'
            ? toolNamespace({
                name: 'crm',
                description: 'CRM tools.',
                tools: [runtimeTool],
              })[0]
            : runtimeTool;
        },
      );
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: {
            type: 'tool_search',
            execution: 'client',
          },
        },
        execute,
      );
      const agent = new Agent({
        name: 'Same-key round-trip agent',
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const createToolSearchCall = (
        id: string,
        result: string,
      ): protocol.ToolSearchCallItem =>
        ({
          type: 'tool_search_call',
          id: `ts_${id}`,
          status: 'completed',
          arguments: { result },
          providerData: { call_id: id, execution: 'client' },
        }) as protocol.ToolSearchCallItem;
      const response: ModelResponse = {
        output: [
          createToolSearchCall('call_first_lookup', 'first'),
          createToolSearchCall('call_second_lookup', 'second'),
        ],
        usage: new Usage(),
      };

      const processed = await processModelResponseAsync(
        response,
        agent,
        [clientToolSearch],
        [],
        state,
        [],
      );
      state._generatedItems.push(...processed.newItems);
      state._lastProcessedResponse = processed;

      const liveTools = state.getToolSearchRuntimeTools(agent);
      expect(liveTools).toHaveLength(1);
      expect(await (liveTools[0] as any).invoke(new RunContext(), '{}')).toBe(
        'second',
      );

      const restored = await RunState.fromString(agent, state.toString());
      const restoredTools = restored.getToolSearchRuntimeTools(agent);

      expect(availableToolNames).toEqual([
        ['tool_search'],
        ['tool_search', 'lookup'],
        ['tool_search'],
        ['tool_search', 'lookup'],
      ]);
      expect(restoredTools).toHaveLength(1);
      expect(
        await (restoredTools[0] as any).invoke(new RunContext(), '{}'),
      ).toBe('second');
    },
  );

  it('round-trips interleaved handlers and callback inputs for repeated client tool_search call ids', async () => {
    const execute = vi.fn(
      async ({
        availableTools,
        toolCall,
      }: {
        availableTools: Tool<any>[];
        toolCall: protocol.ToolSearchCallItem;
      }) => {
        const phase = String((toolCall.arguments as { phase?: string }).phase);
        const hasFirstResult = availableTools.some(
          (availableTool) =>
            availableTool.type === 'function' &&
            availableTool.description === 'first lookup result.',
        );
        const result = phase === 'final' && !hasFirstResult ? 'wrong' : phase;
        return tool({
          name: result === 'wrong' ? 'wrong_lookup' : 'lookup',
          description: `${result} lookup result.`,
          parameters: z.object({}).strict(),
          needsApproval: true,
          execute: async () => result,
        });
      },
    );
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Repeated call id restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const sharedCallId = 'call_repeated_replacement';
    const createToolSearchCall = (
      id: string,
      phase: string,
    ): protocol.ToolSearchCallItem =>
      ({
        type: 'tool_search_call',
        id,
        status: 'completed',
        arguments: { phase },
        providerData: { call_id: sharedCallId, execution: 'client' },
      }) as protocol.ToolSearchCallItem;
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_repeated_replacement',
      callId: 'call_repeated_replacement_function',
      name: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    const processed = await processModelResponseAsync(
      {
        output: [
          createToolSearchCall('ts_repeated_first', 'first'),
          functionCall,
          createToolSearchCall('ts_repeated_final', 'final'),
        ],
        usage: new Usage(),
      },
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;

    expect(
      await (processed.functions[0]!.tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('first');
    expect(state.getToolSearchRuntimeTools(agent)).toHaveLength(1);
    expect(
      await (state.getToolSearchRuntimeTools(agent)[0] as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('final');

    const restored = await RunState.fromString(agent, state.toString());

    expect(execute).toHaveBeenCalledTimes(4);
    expect(restored.getToolSearchRuntimeTools(agent)).toHaveLength(1);
    expect(
      await (restored._lastProcessedResponse?.functions[0]!.tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('first');
    expect(
      await (restored.getToolSearchRuntimeTools(agent)[0] as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('final');

    await rehydrateProcessedResponseTools(
      agent,
      restored,
      restored.getToolSearchRuntimeTools(agent),
    );

    expect(
      await (restored._lastProcessedResponse?.functions[0]!.tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('first');
  });

  it.each(['empty', 'disabled', 'different'] as const)(
    'does not resurrect an older routed owner after a later call is replaced with %s',
    async (replacement) => {
      const firstLookup = tool({
        name: 'lookup',
        description: 'First lookup owner.',
        parameters: z.object({}).strict(),
        execute: async () => 'first',
      });
      const secondLookup = tool({
        name: 'lookup',
        description: 'Second lookup owner.',
        parameters: z.object({}).strict(),
        execute: async () => 'second',
      });
      const disabledLookup = tool({
        name: 'lookup',
        description: 'Disabled final lookup.',
        parameters: z.object({}).strict(),
        isEnabled: false,
        execute: async () => 'disabled',
      });
      const alternateLookup = tool({
        name: 'alternate_lookup',
        description: 'Different final lookup.',
        parameters: z.object({}).strict(),
        execute: async () => 'alternate',
      });
      const execute = vi.fn(
        async ({ toolCall }: { toolCall: protocol.ToolSearchCallItem }) => {
          const phase = String(
            (toolCall.arguments as { phase?: string }).phase,
          );
          if (phase === 'first') {
            return firstLookup;
          }
          if (phase === 'second') {
            return secondLookup;
          }
          if (replacement === 'disabled') {
            return disabledLookup;
          }
          if (replacement === 'different') {
            return alternateLookup;
          }
          return [];
        },
      );
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: { type: 'tool_search', execution: 'client' },
        },
        execute,
      );
      const agent = new Agent({
        name: `Routed owner ${replacement} agent`,
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const createCall = (
        id: string,
        callId: string,
        phase: string,
      ): protocol.ToolSearchCallItem =>
        ({
          type: 'tool_search_call',
          id,
          status: 'completed',
          arguments: { phase },
          providerData: { call_id: callId, execution: 'client' },
        }) as protocol.ToolSearchCallItem;
      const processed = await processModelResponseAsync(
        {
          output: [
            createCall('ts_owner_first', 'call_owner_first', 'first'),
            createCall('ts_owner_second', 'call_owner_second', 'second'),
            createCall('ts_owner_final', 'call_owner_second', 'final'),
          ],
          usage: new Usage(),
        },
        agent,
        [clientToolSearch],
        [],
        state,
        [],
      );
      state._generatedItems.push(...processed.newItems);
      state._lastProcessedResponse = processed;

      const expectedTools = replacement === 'different' ? 1 : 0;
      expect(state.getToolSearchRuntimeTools(agent)).toHaveLength(
        expectedTools,
      );
      if (replacement === 'different') {
        expect(
          await (state.getToolSearchRuntimeTools(agent)[0] as any).invoke(
            new RunContext(),
            '{}',
          ),
        ).toBe('alternate');
      }

      const restored = await RunState.fromString(agent, state.toString());

      expect(restored.getToolSearchRuntimeTools(agent)).toHaveLength(
        expectedTools,
      );
      if (replacement === 'different') {
        expect(
          await (restored.getToolSearchRuntimeTools(agent)[0] as any).invoke(
            new RunContext(),
            '{}',
          ),
        ).toBe('alternate');
      }
    },
  );

  it('keeps a later routed owner when an older call returned the same tool object', async () => {
    const sharedLookup = tool({
      name: 'lookup',
      description: 'Shared lookup owner.',
      parameters: z.object({}).strict(),
      execute: async () => 'shared',
    });
    const execute = vi.fn(
      async ({ toolCall }: { toolCall: protocol.ToolSearchCallItem }) =>
        (toolCall.arguments as { phase?: string }).phase === 'empty'
          ? []
          : sharedLookup,
    );
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Shared object routed owner',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const createSearchCall = (
      id: string,
      callId: string,
      phase: string,
    ): protocol.ToolSearchCallItem =>
      ({
        type: 'tool_search_call',
        id,
        status: 'completed',
        arguments: { phase },
        providerData: { call_id: callId, execution: 'client' },
      }) as protocol.ToolSearchCallItem;
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shared_object_owner',
      callId: 'call_shared_object_owner',
      name: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    const processed = await processModelResponseAsync(
      {
        output: [
          createSearchCall('ts_owner_a', 'owner_a', 'shared'),
          createSearchCall('ts_owner_b', 'owner_b', 'shared'),
          createSearchCall('ts_owner_a_empty', 'owner_a', 'empty'),
          functionCall,
        ],
        usage: new Usage(),
      },
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;

    expect(processed.functions[0]?.tool).toBe(sharedLookup);
    expect(state.getToolSearchRuntimeTools(agent)).toEqual([sharedLookup]);

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored._lastProcessedResponse?.functions[0]?.tool).toBe(
      sharedLookup,
    );
    expect(restored.getToolSearchRuntimeTools(agent)).toEqual([sharedLookup]);
  });

  it('restores the runtime handler bound before a later same-key replacement', async () => {
    const execute = vi.fn(
      async ({ toolCall }: { toolCall: protocol.ToolSearchCallItem }) => {
        const result = String(
          (toolCall.arguments as { result?: string }).result,
        );
        return tool({
          name: 'lookup',
          description: `${result} lookup result.`,
          parameters: z.object({}).strict(),
          needsApproval: true,
          execute: async () => result,
        });
      },
    );
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Interleaved replacement restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const firstSearchCall = {
      type: 'tool_search_call',
      id: 'ts_call_first_interleaved',
      status: 'completed',
      arguments: { result: 'first' },
      providerData: {
        call_id: 'call_first_interleaved',
        execution: 'client',
      },
    } as protocol.ToolSearchCallItem;
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_interleaved_lookup',
      callId: 'call_interleaved_lookup',
      name: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    const secondSearchCall = {
      type: 'tool_search_call',
      id: 'ts_call_second_interleaved',
      status: 'completed',
      arguments: { result: 'second' },
      providerData: {
        call_id: 'call_second_interleaved',
        execution: 'client',
      },
    } as protocol.ToolSearchCallItem;
    const response: ModelResponse = {
      output: [firstSearchCall, functionCall, secondSearchCall],
      usage: new Usage(),
    };

    const processed = await processModelResponseAsync(
      response,
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;

    expect(
      await (processed.functions[0].tool as any).invoke(new RunContext(), '{}'),
    ).toBe('first');
    expect(
      await (state.getToolSearchRuntimeTools(agent)[0] as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('second');

    const restored = await RunState.fromString(agent, state.toString());

    expect(
      await (restored._lastProcessedResponse?.functions[0].tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('first');
    expect(
      await (restored.getToolSearchRuntimeTools(agent)[0] as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('second');
  });

  it('round trips a flattened configured namespace call with its canonical approval key', async () => {
    const namespacedLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Configured CRM lookup.',
          parameters: z.object({}).strict(),
          needsApproval: true,
          execute: async () => 'configured',
        }),
      ],
    })[0];
    const agent = new Agent({
      name: 'Flattened configured namespace restore agent',
      tools: [namespacedLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const flattenedCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_flattened_configured_namespace',
      callId: 'call_flattened_configured_namespace',
      name: 'crm.lookup',
      status: 'completed',
      arguments: '{}',
    };
    const processed = await processModelResponseAsync(
      { output: [flattenedCall], usage: new Usage() },
      agent,
      [namespacedLookup],
      [],
      state,
      [],
    );
    const normalizedCall = processed.functions[0]!.toolCall;
    const canonicalKey = getFunctionToolStateKey(namespacedLookup)!;
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(normalizedCall, agent, undefined, canonicalKey),
        ],
      },
    };

    expect(normalizedCall).toMatchObject({
      name: 'lookup',
      namespace: 'crm',
    });

    const restored = await RunState.fromString(agent, state.toString());

    expect(
      restored._lastProcessedResponse?.functions[0]?.toolCall,
    ).toMatchObject({ name: 'lookup', namespace: 'crm' });
    expect(restored.getInterruptions()[0]?.functionToolStateKey).toBe(
      canonicalKey,
    );
    expect(restored.getInterruptions()[0]?.rawItem).toMatchObject({
      name: 'lookup',
      namespace: 'crm',
    });
    expect(
      await (restored._lastProcessedResponse?.functions[0]?.tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('configured');
  });

  it('round trips a flattened namespace call with its runtime tool-search handler', async () => {
    const execute = vi.fn(async () =>
      toolNamespace({
        name: 'crm',
        description: 'Runtime CRM tools.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Runtime CRM lookup.',
            parameters: z.object({}).strict(),
            needsApproval: true,
            execute: async () => 'runtime',
          }),
        ],
      }),
    );
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Flattened runtime namespace restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const flattenedCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_flattened_runtime_namespace',
      callId: 'call_flattened_runtime_namespace',
      name: 'crm.lookup',
      status: 'completed',
      arguments: '{}',
    };
    const processed = await processModelResponseAsync(
      {
        output: [
          {
            type: 'tool_search_call',
            id: 'ts_flattened_runtime_namespace',
            status: 'completed',
            arguments: {},
            providerData: {
              call_id: 'search_flattened_runtime_namespace',
              execution: 'client',
            },
          } as protocol.ToolSearchCallItem,
          flattenedCall,
        ],
        usage: new Usage(),
      },
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    const normalizedCall = processed.functions[0]!.toolCall;
    const runtimeTool = processed.functions[0]!.tool;
    const canonicalKey = getFunctionToolStateKey(runtimeTool)!;
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(normalizedCall, agent, undefined, canonicalKey),
        ],
      },
    };

    const restored = await RunState.fromString(agent, state.toString());

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      restored._lastProcessedResponse?.functions[0]?.toolCall,
    ).toMatchObject({ name: 'lookup', namespace: 'crm' });
    expect(restored.getInterruptions()[0]?.functionToolStateKey).toBe(
      canonicalKey,
    );
    expect(
      await (restored._lastProcessedResponse?.functions[0]?.tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('runtime');

    const restoredProcessedTool =
      restored._lastProcessedResponse?.functions[0]?.tool;

    await rehydrateProcessedResponseTools(agent, restored, []);

    expect(restored._lastProcessedResponse?.functions[0]?.tool).toBe(
      restoredProcessedTool,
    );
    expect(
      await (restored._lastProcessedResponse?.functions[0]?.tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('runtime');
  });

  it.each([CURRENT_SCHEMA_VERSION, '1.15'] as const)(
    'round trips a deferred runtime tool selected by a legacy bare call in schema %s',
    async (schemaVersion) => {
      const deferredLookup = tool({
        name: 'lookup',
        description: 'Deferred lookup.',
        parameters: z.object({}).strict(),
        deferLoading: true,
        needsApproval: true,
        execute: async () => 'deferred',
      });
      const execute = vi.fn(async () => deferredLookup);
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: { type: 'tool_search', execution: 'client' },
        },
        execute,
      );
      const agent = new Agent({
        name: `Deferred bare restore ${schemaVersion}`,
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        id: `fc_deferred_bare_${schemaVersion}`,
        callId: `call_deferred_bare_${schemaVersion}`,
        name: 'lookup',
        status: 'completed',
        arguments: '{}',
      };
      const processed = await processModelResponseAsync(
        {
          output: [
            {
              type: 'tool_search_call',
              id: `ts_call_deferred_bare_${schemaVersion}`,
              status: 'completed',
              arguments: {},
              providerData: {
                call_id: `search_deferred_bare_${schemaVersion}`,
                execution: 'client',
              },
            } as protocol.ToolSearchCallItem,
            functionCall,
          ],
          usage: new Usage(),
        },
        agent,
        [clientToolSearch],
        [],
        state,
        [],
      );
      state._generatedItems.push(...processed.newItems);
      state._lastProcessedResponse = processed;
      state._currentStep = {
        type: 'next_step_interruption',
        data: {
          interruptions: [
            new ToolApprovalItem(
              functionCall,
              agent,
              undefined,
              getFunctionToolStateKey(deferredLookup),
            ),
          ],
        },
      };

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = schemaVersion;
      if (schemaVersion === '1.15') {
        delete serialized.currentStep.data.interruptions[0]
          .functionToolStateKey;
      }

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );

      expect(execute).toHaveBeenCalledTimes(2);
      expect(restored.getInterruptions()[0]?.functionToolStateKey).toBe(
        getFunctionToolStateKey(deferredLookup),
      );
      expect(
        await (
          restored._lastProcessedResponse?.functions[0].tool as any
        ).invoke(new RunContext(), '{}'),
      ).toBe('deferred');
    },
  );

  it('rejects an unproven deferred bare fallback instead of rebinding a bare owner', async () => {
    const bareLookup = tool({
      name: 'lookup',
      description: 'Bare lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'bare',
    });
    const deferredLookup = tool({
      name: 'lookup',
      description: 'Unproven deferred lookup.',
      parameters: z.object({}).strict(),
      deferLoading: true,
      execute: async () => 'deferred',
    });
    const agent = new Agent({
      name: 'Unproven deferred fallback agent',
      tools: [bareLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_unproven_deferred_fallback',
      callId: 'call_unproven_deferred_fallback',
      name: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    state._generatedItems.push(new RunToolCallItem(functionCall, agent));
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: functionCall, tool: deferredLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(
            functionCall,
            agent,
            undefined,
            getFunctionToolStateKey(deferredLookup),
          ),
        ],
      },
    };

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'function call ID is associated with multiple routed tool identities',
    );
  });

  it('round trips a legacy bare call resolved by a configured deferred owner', async () => {
    const deferredLookup = tool({
      name: 'lookup',
      description: 'Configured deferred lookup.',
      parameters: z.object({}).strict(),
      deferLoading: true,
      execute: async () => 'deferred',
    });
    const agent = new Agent({
      name: 'Configured deferred fallback agent',
      tools: [deferredLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_configured_deferred_fallback',
      callId: 'call_configured_deferred_fallback',
      name: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    state._generatedItems.push(new RunToolCallItem(functionCall, agent));
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: functionCall, tool: deferredLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(
            functionCall,
            agent,
            undefined,
            getFunctionToolStateKey(deferredLookup),
          ),
        ],
      },
    };

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored.getInterruptions()[0]?.functionToolStateKey).toBe(
      getFunctionToolStateKey(deferredLookup),
    );
    expect(
      await (restored._lastProcessedResponse?.functions[0].tool as any).invoke(
        new RunContext(),
        '{}',
      ),
    ).toBe('deferred');
  });

  it.each([CURRENT_SCHEMA_VERSION, '1.15'] as const)(
    'rejects a configured deferred bare fallback hidden by a handoff in schema %s',
    async (schemaVersion) => {
      const deferredLookup = tool({
        name: 'lookup',
        description: 'Configured deferred lookup.',
        parameters: z.object({}).strict(),
        deferLoading: true,
        execute: async () => 'deferred',
      });
      const target = new Agent({ name: 'Deferred lookup target' });
      const agent = new Agent({
        name: `Configured deferred handoff collision ${schemaVersion}`,
        tools: [deferredLookup],
        handoffs: [handoff(target, { toolNameOverride: 'lookup' })],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        id: `fc_configured_deferred_handoff_${schemaVersion}`,
        callId: `call_configured_deferred_handoff_${schemaVersion}`,
        name: 'lookup',
        status: 'completed',
        arguments: '{}',
      };
      state._generatedItems.push(new RunToolCallItem(functionCall, agent));
      state._lastProcessedResponse = {
        newItems: [],
        functions: [{ toolCall: functionCall, tool: deferredLookup as any }],
        handoffs: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: ['lookup'],
        hasToolsOrApprovalsToRun: () => true,
      };
      state._currentStep = {
        type: 'next_step_interruption',
        data: {
          interruptions: [
            new ToolApprovalItem(
              functionCall,
              agent,
              undefined,
              getFunctionToolStateKey(deferredLookup),
            ),
          ],
        },
      };

      const serialized = state.toJSON() as any;
      serialized.$schemaVersion = schemaVersion;
      if (schemaVersion === '1.15') {
        delete serialized.currentStep.data.interruptions[0]
          .functionToolStateKey;
      }

      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow(
        'function call ID is associated with multiple routed tool identities',
      );
    },
  );

  it('scopes repeated function call ids to each interruption agent', async () => {
    const outerTool = tool({
      name: 'outer_tool',
      description: 'Outer tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'outer',
    });
    const childTool = tool({
      name: 'child_tool',
      description: 'Child tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'child',
    });
    const child = new Agent({ name: 'Call id child', tools: [childTool] });
    const root = new Agent({
      name: 'Call id root',
      tools: [outerTool],
      handoffs: [child],
    });
    const state = new RunState(new RunContext(), 'input', root, 2);
    const sharedCallId = 'agent_scoped_call_id';
    const outerCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_outer_agent_scoped',
      callId: sharedCallId,
      name: 'outer_tool',
      status: 'completed',
      arguments: '{}',
    };
    const childCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_child_agent_scoped',
      callId: sharedCallId,
      name: 'child_tool',
      status: 'completed',
      arguments: '{}',
    };
    state._generatedItems.push(
      new RunToolCallItem(outerCall, root),
      new RunToolCallItem(childCall, child),
    );
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: outerCall, tool: outerTool as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['outer_tool'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(
            childCall,
            child,
            undefined,
            getFunctionToolStateKey(childTool),
          ),
        ],
      },
    };

    const restored = await RunState.fromString(root, state.toString());

    expect(restored.getInterruptions()[0]?.agent).toBe(child);
    expect(restored.getInterruptions()[0]?.functionToolStateKey).toBe(
      getFunctionToolStateKey(childTool),
    );
  });

  it('preserves independent function approvals with the same identity across agents', async () => {
    const rootTool = tool({
      name: 'shared_tool',
      description: 'Root shared tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'root',
    });
    const childTool = tool({
      name: 'shared_tool',
      description: 'Child shared tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'child',
    });
    const child = new Agent({
      name: 'Shared approval agent',
      tools: [childTool],
    });
    const root = new Agent({
      name: 'Shared approval agent',
      tools: [rootTool],
      handoffs: [child],
    });
    const sharedCallId = 'shared_approval_call_id';
    const rootCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shared_approval_root',
      callId: sharedCallId,
      name: 'shared_tool',
      status: 'completed',
      arguments: '{}',
    };
    const childCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shared_approval_child',
      callId: sharedCallId,
      name: 'shared_tool',
      status: 'completed',
      arguments: '{}',
    };
    const state = new RunState(new RunContext(), 'input', root, 2);
    state._generatedItems.push(
      new RunToolCallItem(rootCall, root),
      new RunToolCallItem(childCall, child),
    );
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: rootCall, tool: rootTool as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['shared_tool'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(
            rootCall,
            root,
            undefined,
            getFunctionToolStateKey(rootTool),
          ),
          new ToolApprovalItem(
            childCall,
            child,
            undefined,
            getFunctionToolStateKey(childTool),
          ),
        ],
      },
    };

    const sharedStateKey = getFunctionToolStateKey(rootTool)!;
    const legacySerialized = state.toJSON() as any;
    legacySerialized.$schemaVersion = '1.15';
    legacySerialized.context.approvals = {
      shared_tool: { approved: [sharedCallId], rejected: [] },
    };
    delete legacySerialized.context.functionApprovals;
    for (const interruption of legacySerialized.currentStep.data
      .interruptions) {
      delete interruption.functionToolStateKey;
    }
    const legacyRestored = await RunState.fromString(
      root,
      JSON.stringify(legacySerialized),
    );
    for (const owner of [root, child]) {
      expect(
        legacyRestored._context.isToolApproved({
          toolName: sharedStateKey,
          callId: sharedCallId,
          functionTool: false,
          agent: owner,
        }),
      ).toBe(true);
    }
    const legacyRoundTripped = await RunState.fromString(
      root,
      legacyRestored.toString(),
    );
    for (const owner of [root, child]) {
      expect(
        legacyRoundTripped._context.isToolApproved({
          toolName: sharedStateKey,
          callId: sharedCallId,
          functionTool: false,
          agent: owner,
        }),
      ).toBe(true);
    }

    const restored = await RunState.fromString(root, state.toString());
    const [rootApproval, childApproval] = restored.getInterruptions();
    restored.approve(rootApproval, { alwaysApprove: true });
    restored.reject(childApproval, { message: 'Child call rejected.' });

    const roundTripped = await RunState.fromString(root, restored.toString());
    expect(
      roundTripped._context.isToolApproved({
        toolName: sharedStateKey,
        callId: 'future-root-call',
        functionTool: false,
        agent: root,
      }),
    ).toBe(true);
    expect(
      roundTripped._context.isToolApproved({
        toolName: sharedStateKey,
        callId: sharedCallId,
        functionTool: false,
        agent: child,
      }),
    ).toBe(false);
    expect(
      roundTripped._context.isToolApproved({
        toolName: sharedStateKey,
        callId: 'future-child-call',
        functionTool: false,
        agent: child,
      }),
    ).toBeUndefined();
    expect(
      roundTripped._context._getFunctionRejectionMessage(
        sharedStateKey,
        sharedCallId,
        child,
      ),
    ).toBe('Child call rejected.');
    expect(
      roundTripped._context._getFunctionRejectionMessage(
        sharedStateKey,
        sharedCallId,
        root,
      ),
    ).toBeUndefined();
  });

  it('round trips function approvals for reserved agent identity names', async () => {
    const agent = new Agent({ name: '__proto__' });
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'reserved_identity_tool',
      callId: 'reserved_identity_call',
      status: 'completed',
      arguments: '{}',
    };
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state.reject(new ToolApprovalItem(rawItem, agent), {
      message: 'Reserved identity rejected.',
    });

    const serialized = state.toJSON();
    expect(serialized.context.functionApprovals).toEqual([
      {
        agentIdentity: '__proto__',
        approvals: expect.any(Object),
      },
    ]);

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    const stateKey = getFunctionToolStateKeyForCall(rawItem)!;
    expect(
      restored._context.isToolApproved({
        toolName: stateKey,
        callId: rawItem.callId,
        functionTool: false,
        agent,
      }),
    ).toBe(false);
    expect(
      restored._context._getFunctionRejectionMessage(
        stateKey,
        rawItem.callId,
        agent,
      ),
    ).toBe('Reserved identity rejected.');
  });

  it('validates current function approval state before context replacement', async () => {
    const agent = new Agent({ name: 'ApprovalOwnerValidationAgent' });
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'approval_owner_tool',
      callId: 'approval_owner_call',
      status: 'completed',
      arguments: '{}',
    };
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state.approve(new ToolApprovalItem(rawItem, agent));
    const serialized = state.toJSON() as any;
    serialized.context.functionApprovals[0].agentIdentity = 'unknown-agent';

    await expect(
      RunState.fromStringWithContext(
        agent,
        JSON.stringify(serialized),
        new RunContext(),
        { contextStrategy: 'replace' },
      ),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('rejects duplicate function approval owners before tool execution', async () => {
    const execute = vi.fn(async () => 'executed');
    const approvalTool = tool({
      name: 'duplicate_owner_tool',
      description: 'Duplicate owner tool.',
      parameters: z.object({}),
      execute,
    });
    const agent = new Agent({
      name: 'DuplicateApprovalOwnerAgent',
      tools: [approvalTool],
    });
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'duplicate_owner_call',
      status: 'completed',
      arguments: '{}',
    };
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state.approve(new ToolApprovalItem(rawItem, agent));
    const serialized = state.toJSON() as any;
    serialized.context.functionApprovals.push({
      ...serialized.context.functionApprovals[0],
      approvals: {
        ...serialized.context.functionApprovals[0].approvals,
      },
    });

    await expect(
      RunState.fromStringWithContext(
        agent,
        JSON.stringify(serialized),
        new RunContext(),
        { contextStrategy: 'replace' },
      ),
    ).rejects.toBeInstanceOf(UserError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed current function approval state with UserError', async () => {
    const agent = new Agent({ name: 'MalformedApprovalOwnerAgent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const serialized = state.toJSON() as any;
    serialized.context.functionApprovals = [
      {
        agentIdentity: agent.name,
        approvals: {
          malformed: { approved: 'yes', rejected: [] },
        },
      },
    ];

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('rejects noncanonical current function approval keys with UserError', async () => {
    const agent = new Agent({ name: 'NoncanonicalApprovalKeyAgent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const serialized = state.toJSON() as any;
    serialized.context.functionApprovals = [
      {
        agentIdentity: agent.name,
        approvals: {
          lookup: { approved: true, rejected: [] },
        },
      },
    ];

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('preserves ZodError for unrelated malformed run state fields', async () => {
    const agent = new Agent({ name: 'MalformedUnrelatedStateAgent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const serialized = state.toJSON() as any;
    serialized.currentTurn = 'not-a-number';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects owner-scoped approval fields in legacy schemas', async () => {
    const agent = new Agent({ name: 'LegacyApprovalOwnerFieldAgent' });
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'legacy_owner_tool',
      callId: 'legacy_owner_call',
      status: 'completed',
      arguments: '{}',
    };
    const state = new RunState(new RunContext(), 'input', agent, 1);
    state.approve(new ToolApprovalItem(rawItem, agent));
    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(
      'Run state schema version 1.15 does not support owner-scoped function approvals.',
    );
  });

  it('rejects interruption identity mismatches before callbacks without a processed response', async () => {
    const dangerous = tool({
      name: 'dangerous',
      description: 'Dangerous action.',
      parameters: z.object({}).strict(),
      execute: async () => 'dangerous',
    });
    const harmless = tool({
      name: 'harmless',
      description: 'Harmless action.',
      parameters: z.object({}).strict(),
      execute: async () => 'harmless',
    });
    const runtimeLookup = tool({
      name: 'runtime_lookup',
      description: 'Runtime lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'runtime',
    });
    const execute = vi.fn(async () => runtimeLookup);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'No processed response interruption agent',
      tools: [dangerous, harmless, clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_no_processed_response',
      callId: 'call_no_processed_response',
      name: 'dangerous',
      status: 'completed',
      arguments: '{}',
    };
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_no_processed_response',
          status: 'completed',
          arguments: {},
          providerData: {
            call_id: 'search_no_processed_response',
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_no_processed_response',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'runtime_lookup',
              description: 'Runtime lookup.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: {
            call_id: 'search_no_processed_response',
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
      new RunToolCallItem(rawItem, agent),
    );
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(
            rawItem,
            agent,
            undefined,
            getFunctionToolStateKey(harmless),
          ),
        ],
      },
    };

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'function call ID is associated with multiple routed tool identities',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects reused function call ids before tool-search rehydration callbacks', async () => {
    const runtimeLookup = tool({
      name: 'runtime_lookup',
      description: 'Runtime lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'runtime',
    });
    const configuredLookup = tool({
      name: 'configured_lookup',
      description: 'Configured lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'configured',
    });
    const execute = vi.fn(async () => runtimeLookup);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Reused function call id agent',
      tools: [configuredLookup, clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const sharedCallId = 'reused_function_call_id';
    const runtimeCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_runtime_lookup',
      callId: sharedCallId,
      name: 'runtime_lookup',
      status: 'completed',
      arguments: '{}',
    };
    const configuredCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_configured_lookup',
      callId: sharedCallId,
      name: 'configured_lookup',
      status: 'completed',
      arguments: '{}',
    };
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_reused_function_id',
          status: 'completed',
          arguments: {},
          providerData: {
            call_id: 'tool_search_reused_function_id',
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_reused_function_id',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'runtime_lookup',
              description: 'Runtime lookup.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: {
            call_id: 'tool_search_reused_function_id',
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
      new RunToolCallItem(runtimeCall, agent),
      new RunToolCallItem(configuredCall, agent),
    );
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: configuredCall, tool: configuredLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['configured_lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'function call ID is associated with multiple routed tool identities',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects reused function call ids before legacy state migration', async () => {
    const bareLookup = tool({
      name: 'lookup',
      description: 'Bare lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'bare',
    });
    const deferredLookup = tool({
      name: 'lookup',
      description: 'Deferred lookup.',
      parameters: z.object({}).strict(),
      deferLoading: true,
      execute: async () => 'deferred',
    });
    const agent = new Agent({
      name: 'Legacy reused function call id agent',
      tools: [bareLookup, deferredLookup],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const sharedCallId = 'legacy_reused_function_call_id';
    const bareCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_legacy_bare_lookup',
      callId: sharedCallId,
      name: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    const deferredCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_legacy_deferred_lookup',
      callId: sharedCallId,
      name: 'lookup',
      namespace: 'lookup',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [
        { toolCall: bareCall, tool: bareLookup as any },
        { toolCall: deferredCall, tool: deferredLookup as any },
      ],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['lookup'],
      hasToolsOrApprovalsToRun: () => true,
    };

    const serialized = state.toJSON() as any;
    serialized.$schemaVersion = '1.15';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(
      'function call ID is associated with multiple routed tool identities',
    );
  });

  it('rejects an interruption whose routed identity differs from its processed call', async () => {
    const dangerous = tool({
      name: 'dangerous',
      description: 'Dangerous action.',
      parameters: z.object({}).strict(),
      execute: async () => 'dangerous',
    });
    const harmless = tool({
      name: 'harmless',
      description: 'Harmless action.',
      parameters: z.object({}).strict(),
      execute: async () => 'harmless',
    });
    const agent = new Agent({
      name: 'Mismatched interruption identity agent',
      tools: [dangerous, harmless],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_dangerous',
      callId: 'mismatched_interruption_identity',
      name: 'dangerous',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: rawItem, tool: dangerous as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['dangerous'],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [new ToolApprovalItem(rawItem, agent)],
      },
    };

    const serialized = state.toJSON() as any;
    serialized.currentStep.data.interruptions[0].rawItem.name = 'harmless';

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(
      'function call ID is associated with multiple routed tool identities',
    );
  });

  it('validates every tool-search output before invoking a rehydration callback', async () => {
    const runtimeTool = tool({
      name: 'lookup',
      description: 'Lookup result.',
      parameters: z.object({}).strict(),
      execute: async () => 'lookup',
    });
    const execute = vi.fn(async () => runtimeTool);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Tool-search preflight agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_preflight_valid',
          status: 'completed',
          arguments: {},
          providerData: {
            call_id: 'call_preflight_valid',
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_preflight_valid',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Lookup result.',
              strict: true,
              parameters: { type: 'object', properties: {}, required: [] },
            },
          ],
          providerData: {
            call_id: 'call_preflight_valid',
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_preflight_orphan',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'orphan',
              description: 'Orphan result.',
              strict: true,
              parameters: { type: 'object', properties: {}, required: [] },
            },
          ],
          providerData: {
            call_id: 'call_preflight_orphan',
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'serialized state is missing the matching tool_search call item',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed serialized runtime identity before rehydration callbacks', async () => {
    const execute = vi.fn();
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Malformed tool-search identity agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_malformed_identity';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_malformed_identity',
          status: 'completed',
          arguments: {},
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_malformed_identity',
          status: 'completed',
          tools: [{ type: 'function' }],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'function without a valid routed identity',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a reserved serialized namespace before rehydration callbacks', async () => {
    const execute = vi.fn(async () => []);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Reserved serialized namespace agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_reserved_serialized_namespace';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_reserved_serialized_namespace',
          status: 'completed',
          arguments: {},
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_reserved_serialized_namespace',
          status: 'completed',
          tools: [
            {
              type: 'namespace',
              name: 'lookup',
              description: 'Reserved lookup namespace.',
              tools: [
                {
                  type: 'function',
                  name: 'lookup',
                  description: 'Nested lookup.',
                  strict: true,
                  parameters: {
                    type: 'object',
                    properties: {},
                    required: [],
                    additionalProperties: false,
                  },
                },
              ],
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'Responses tool search reserves same-name namespaces for deferred top-level function tools.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a direct serialized self-namespace before rehydration callbacks', async () => {
    const runtimeLookup = tool({
      name: 'lookup',
      description: 'Deferred lookup.',
      parameters: z.object({}).strict(),
      deferLoading: true,
      execute: async () => 'lookup',
    });
    const execute = vi.fn(async () => runtimeLookup);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Direct reserved serialized namespace agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_direct_reserved_serialized_namespace';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_direct_reserved_serialized_namespace',
          status: 'completed',
          arguments: {},
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_direct_reserved_serialized_namespace',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              namespace: 'lookup',
              description: 'Reserved lookup namespace.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'Responses tool search reserves same-name namespaces for deferred top-level function tools.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('replays an empty tool-search callback before later callbacks', async () => {
    type TestContext = { ready: boolean };
    const execute = vi.fn(
      async ({
        runContext,
        toolCall,
      }: {
        runContext: RunContext<TestContext>;
        toolCall: protocol.ToolSearchCallItem;
      }) => {
        const phase = (toolCall.arguments as { phase?: string }).phase;
        if (phase === 'empty') {
          runContext.context.ready = true;
          return [];
        }
        const name = runContext.context.ready ? 'after_empty' : 'wrong';
        return tool({
          name,
          description: 'Result after the empty callback.',
          parameters: z.object({}).strict(),
          execute: async () => name,
        });
      },
    );
    const clientToolSearch = attachClientToolSearchExecutor<TestContext>(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent<TestContext>({
      name: 'Empty callback replay agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(
      new RunContext({ ready: false }),
      'input',
      agent,
      2,
    );
    const createCall = (
      id: string,
      phase: string,
    ): protocol.ToolSearchCallItem =>
      ({
        type: 'tool_search_call',
        id: `ts_${id}`,
        status: 'completed',
        arguments: { phase },
        providerData: { call_id: id, execution: 'client' },
      }) as protocol.ToolSearchCallItem;
    const processed = await processModelResponseAsync(
      {
        output: [
          createCall('call_empty_replay', 'empty'),
          createCall('call_after_empty_replay', 'after'),
        ],
        usage: new Usage(),
      },
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;

    const restored = await RunState.fromStringWithContext(
      agent,
      state.toString(),
      new RunContext({ ready: false }),
      { contextStrategy: 'replace' },
    );

    expect(execute).toHaveBeenCalledTimes(4);
    expect(restored.getToolSearchRuntimeTools(agent)[0]?.name).toBe(
      'after_empty',
    );
  });

  it('rejects an empty custom tool-search output when its executor is unavailable', async () => {
    type TestContext = { ready: boolean };
    const execute = vi.fn(
      async ({ runContext }: { runContext: RunContext<TestContext> }) => {
        runContext.context.ready = true;
        return [];
      },
    );
    const customToolSearchProviderData = {
      type: 'tool_search' as const,
      execution: 'client' as const,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    };
    const clientToolSearch = attachClientToolSearchExecutor<TestContext>(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: customToolSearchProviderData,
      },
      execute,
    );
    const agent = new Agent<TestContext>({
      name: 'Empty custom callback restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(
      new RunContext({ ready: false }),
      'input',
      agent,
      2,
    );
    const processed = await processModelResponseAsync(
      {
        output: [
          {
            type: 'tool_search_call',
            id: 'ts_call_empty_custom_restore',
            status: 'completed',
            arguments: {},
            providerData: {
              call_id: 'call_empty_custom_restore',
              execution: 'client',
            },
          } as protocol.ToolSearchCallItem,
        ],
        usage: new Usage(),
      },
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;

    const replacementAgent = new Agent<TestContext>({
      name: agent.name,
      tools: [
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: customToolSearchProviderData,
        },
      ],
    });
    const replacementContext = new RunContext({ ready: false });

    await expect(
      RunState.fromStringWithContext(
        replacementAgent,
        state.toString(),
        replacementContext,
        { contextStrategy: 'replace' },
      ),
    ).rejects.toThrow(
      'require toolSearchTool({ execution: "client", execute }) when custom client tool_search parameters are provided',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(replacementContext.context.ready).toBe(false);
  });

  it('restores an empty built-in tool-search output without an executor', async () => {
    const clientToolSearch = {
      type: 'hosted_tool' as const,
      name: 'tool_search',
      providerData: {
        type: 'tool_search' as const,
        execution: 'client' as const,
      },
    };
    const agent = new Agent({
      name: 'Empty built-in restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_empty_builtin_restore';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_empty_builtin_restore',
          status: 'completed',
          arguments: { paths: [] },
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_empty_builtin_restore',
          status: 'completed',
          tools: [],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored.getToolSearchRuntimeTools(agent)).toEqual([]);
  });

  it('keeps disabled callback results visible to later tool-search callbacks', async () => {
    type TestContext = { enabled: boolean };
    const availableToolNames: string[][] = [];
    const execute = vi.fn(
      async ({
        availableTools,
        toolCall,
      }: {
        availableTools: Tool<TestContext>[];
        toolCall: protocol.ToolSearchCallItem;
      }) => {
        availableToolNames.push(availableTools.map((entry) => entry.name));
        const phase = (toolCall.arguments as { phase?: string }).phase;
        if (phase === 'disabled') {
          return tool({
            name: 'disabled_runtime',
            description: 'Disabled runtime result.',
            parameters: z.object({}).strict(),
            isEnabled: ({ runContext }) =>
              (runContext.context as TestContext).enabled,
            execute: async () => 'disabled',
          });
        }
        const sawDisabled = availableTools.some(
          (entry) => entry.name === 'disabled_runtime',
        );
        const name = sawDisabled ? 'after_disabled' : 'wrong';
        return tool({
          name,
          description: 'Result after the disabled callback.',
          parameters: z.object({}).strict(),
          execute: async () => name,
        });
      },
    );
    const clientToolSearch = attachClientToolSearchExecutor<TestContext>(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent<TestContext>({
      name: 'Disabled callback replay agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(
      new RunContext({ enabled: false }),
      'input',
      agent,
      2,
    );
    const createCall = (
      id: string,
      phase: string,
    ): protocol.ToolSearchCallItem =>
      ({
        type: 'tool_search_call',
        id: `ts_${id}`,
        status: 'completed',
        arguments: { phase },
        providerData: { call_id: id, execution: 'client' },
      }) as protocol.ToolSearchCallItem;
    const processed = await processModelResponseAsync(
      {
        output: [
          createCall('call_disabled_replay', 'disabled'),
          createCall('call_after_disabled_replay', 'after'),
        ],
        usage: new Usage(),
      },
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );
    state._generatedItems.push(...processed.newItems);
    state._lastProcessedResponse = processed;

    const restored = await RunState.fromString(agent, state.toString());

    expect(availableToolNames).toEqual([
      ['tool_search'],
      ['tool_search', 'disabled_runtime'],
      ['tool_search'],
      ['tool_search', 'disabled_runtime'],
    ]);
    expect(
      restored.getToolSearchRuntimeTools(agent).map((entry) => entry.name),
    ).toEqual(['after_disabled']);
  });

  it.each([
    ['an enabled and a disabled result', true],
    ['two disabled results', false],
  ] as const)(
    'rehydrates client tool-search output after filtering %s',
    async (_description, includeEnabledResult) => {
      const enabledLookup = tool({
        name: 'lookup',
        description: 'Enabled lookup.',
        parameters: z.object({}).strict(),
        execute: async () => 'enabled',
      });
      const disabledLookup = tool({
        name: 'lookup',
        description: 'Disabled lookup.',
        parameters: z.object({}).strict(),
        isEnabled: false,
        execute: async () => 'disabled',
      });
      const otherDisabledLookup = tool({
        name: 'lookup',
        description: 'Other disabled lookup.',
        parameters: z.object({}).strict(),
        isEnabled: false,
        execute: async () => 'other disabled',
      });
      const execute = vi.fn(async () => [
        includeEnabledResult ? enabledLookup : otherDisabledLookup,
        disabledLookup,
      ]);
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: { type: 'tool_search', execution: 'client' },
        },
        execute,
      );
      const agent = new Agent({
        name: `Filtered duplicate restore ${includeEnabledResult}`,
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const processed = await processModelResponseAsync(
        {
          output: [
            {
              type: 'tool_search_call',
              id: 'ts_call_filtered_duplicate_restore',
              status: 'completed',
              arguments: {},
              providerData: {
                call_id: 'call_filtered_duplicate_restore',
                execution: 'client',
              },
            } as protocol.ToolSearchCallItem,
          ],
          usage: new Usage(),
        },
        agent,
        [clientToolSearch],
        [],
        state,
        [],
      );
      state._generatedItems.push(...processed.newItems);
      state._lastProcessedResponse = processed;

      const restored = await RunState.fromString(agent, state.toString());

      expect(execute).toHaveBeenCalledTimes(2);
      expect(restored.getToolSearchRuntimeTools(agent)).toEqual(
        includeEnabledResult ? [enabledLookup] : [],
      );
    },
  );

  it.each([
    ['one serialized tool', true],
    ['an empty serialized result', false],
  ] as const)(
    'rejects extra enabled callback tools when rehydrating %s',
    async (_description, includeSerializedLookup) => {
      const lookup = tool({
        name: 'lookup',
        description: 'Serialized lookup.',
        parameters: z.object({}).strict(),
        execute: async () => 'lookup',
      });
      const extraLookup = tool({
        name: 'extra_lookup',
        description: 'Unexpected extra lookup.',
        parameters: z.object({}).strict(),
        execute: async () => 'extra',
      });
      const execute = vi.fn(async () => [lookup, extraLookup]);
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: { type: 'tool_search', execution: 'client' },
        },
        execute,
      );
      const agent = new Agent({
        name: `Extra enabled restore ${includeSerializedLookup}`,
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const callId = 'call_extra_enabled_restore';
      state._generatedItems.push(
        new RunToolSearchCallItem(
          {
            type: 'tool_search_call',
            id: 'ts_call_extra_enabled_restore',
            status: 'completed',
            arguments: {},
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchCallItem,
          agent,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            id: 'ts_output_extra_enabled_restore',
            status: 'completed',
            tools: includeSerializedLookup
              ? [
                  {
                    type: 'function',
                    name: 'lookup',
                    description: 'Serialized lookup.',
                    strict: true,
                    parameters: {
                      type: 'object',
                      properties: {},
                      required: [],
                      additionalProperties: false,
                    },
                  },
                ]
              : [],
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchOutputItem,
          agent,
        ),
      );

      await expect(
        RunState.fromString(agent, state.toString()),
      ).rejects.toThrow(
        'registered execute callback returned different runtime tools than the serialized state',
      );
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it('rejects duplicate configured identities returned during tool-search rehydration', async () => {
    const configuredTool = tool({
      name: 'configured',
      description: 'Configured tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'configured',
    });
    const runtimeTool = tool({
      name: 'runtime',
      description: 'Runtime tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'runtime',
    });
    const execute = vi.fn(async () => [
      configuredTool,
      configuredTool,
      runtimeTool,
    ]);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Configured duplicate restore agent',
      tools: [configuredTool, clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_configured_duplicate_restore';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_configured_duplicate_restore',
          status: 'completed',
          arguments: { query: 'runtime' },
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_configured_duplicate_restore',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'configured',
              description: 'Configured tool.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
            {
              type: 'function',
              name: 'runtime',
              description: 'Runtime tool.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'Client tool_search execute() returned multiple tools with the same routed identity.',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['accepts the final replacement', true],
    ['rejects a stale first result', false],
  ] as const)(
    '%s when rehydrating repeated client tool_search outputs',
    async (_description, returnFinalReplacement) => {
      const firstLookup = tool({
        name: 'first_lookup',
        description: 'First lookup result.',
        parameters: z.object({}).strict(),
        execute: async () => 'first',
      });
      const latestLookup = tool({
        name: 'latest_lookup',
        description: 'Latest lookup result.',
        parameters: z.object({}).strict(),
        execute: async () => 'latest',
      });
      const execute = vi.fn(async () =>
        returnFinalReplacement ? latestLookup : firstLookup,
      );
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: {
            type: 'tool_search',
            execution: 'client',
          },
        },
        execute,
      );
      const agent = new Agent({
        name: 'Replacement restore agent',
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const callId = 'call_replacement_restore';
      state._generatedItems.push(
        new RunToolSearchCallItem(
          {
            type: 'tool_search_call',
            id: 'ts_call_replacement_restore',
            status: 'completed',
            arguments: { paths: [] },
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchCallItem,
          agent,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            id: 'ts_output_replacement_first',
            status: 'completed',
            tools: [
              {
                type: 'function',
                name: 'first_lookup',
                description: 'First lookup result.',
                strict: true,
                parameters: {
                  type: 'object',
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchOutputItem,
          agent,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            id: 'ts_output_replacement_latest',
            status: 'completed',
            tools: [
              {
                type: 'function',
                name: 'latest_lookup',
                description: 'Latest lookup result.',
                strict: true,
                parameters: {
                  type: 'object',
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchOutputItem,
          agent,
        ),
      );

      const restoredPromise = RunState.fromString(agent, state.toString());
      if (returnFinalReplacement) {
        const restored = await restoredPromise;
        expect(restored.getToolSearchRuntimeTools(agent)).toEqual([
          latestLookup,
        ]);
      } else {
        await expect(restoredPromise).rejects.toThrow(
          'RunState cannot resume custom client tool_search because the registered execute callback returned different runtime tools than the serialized state.',
        );
      }
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('redacts runtime tool identities from RunState callback mismatches', async () => {
    const expectedName = 'secret_expected_lookup';
    const actualName = 'secret_actual_lookup';
    const actualLookup = tool({
      name: actualName,
      description: 'Actual lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'actual',
    });
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      async () => actualLookup,
    );
    const agent = new Agent({
      name: 'Redacted mismatch agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_redacted_mismatch';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_redacted_mismatch',
          status: 'completed',
          arguments: {},
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_redacted_mismatch',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: expectedName,
              description: 'Expected lookup.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );
    const redaction = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);

    try {
      const restored = RunState.fromString(agent, state.toString());
      await expect(restored).rejects.toThrow(
        'RunState cannot resume custom client tool_search because the registered execute callback returned different runtime tools than the serialized state.',
      );
      await expect(restored).rejects.not.toThrow(expectedName);
      await expect(restored).rejects.not.toThrow(actualName);
    } finally {
      redaction.mockRestore();
    }
  });

  it('redacts call and agent identities from missing tool-search executors', async () => {
    const callId = 'secret_missing_executor_call';
    const agent = new Agent({ name: 'Secret missing executor agent' });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_missing_executor',
          status: 'completed',
          arguments: {},
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_missing_executor',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'secret_runtime_lookup',
              description: 'Secret runtime lookup.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );
    const redaction = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);

    try {
      const restored = RunState.fromString(agent, state.toString());
      await expect(restored).rejects.toThrow(
        'RunState cannot resume custom client tool_search because the agent no longer provides toolSearchTool({ execution: "client", execute }).',
      );
      await expect(restored).rejects.not.toThrow(callId);
      await expect(restored).rejects.not.toThrow(agent.name);
    } finally {
      redaction.mockRestore();
    }
  });

  it('rehydrates same-name runtime tools from distinct function categories', async () => {
    const bareLookup = tool({
      name: 'lookup',
      description: 'Immediate lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'bare',
    });
    const deferredLookup = tool({
      name: 'lookup',
      description: 'Deferred lookup.',
      parameters: z.object({}).strict(),
      deferLoading: true,
      execute: async () => 'deferred',
    });
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
        },
      },
      async () => [bareLookup, deferredLookup],
    );
    const agent = new Agent({
      name: 'Category-aware restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_tool_search_categories';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_categories',
          status: 'completed',
          arguments: { paths: [] },
          providerData: {
            call_id: callId,
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_categories',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Immediate lookup.',
              strict: true,
              deferLoading: false,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
            {
              type: 'function',
              name: 'lookup',
              description: 'Deferred lookup.',
              strict: true,
              deferLoading: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: {
            call_id: callId,
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored.getToolSearchRuntimeTools(agent)).toEqual([
      bareLookup,
      deferredLookup,
    ]);
  });

  it('rejects a rehydrated bare runtime function that conflicts with an enabled handoff', async () => {
    const runtimeLookup = tool({
      name: 'lookup',
      description: 'Look up a record.',
      parameters: z.object({}).strict(),
      execute: async () => 'runtime',
    });
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
        },
      },
      async () => runtimeLookup,
    );
    const target = new Agent({ name: 'LookupTarget' });
    const agent = new Agent({
      name: 'RuntimeHandoffCollision',
      tools: [clientToolSearch],
      handoffs: [handoff(target, { toolNameOverride: 'lookup' })],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const callId = 'call_runtime_handoff_collision';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_runtime_handoff_collision',
          status: 'completed',
          arguments: { paths: [] },
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_runtime_handoff_collision',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Look up a record.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: callId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'Client tool_search execute() returned a bare function tool that conflicts with an available handoff. Assign a unique tool name or use a namespace.',
    );
  });

  it.each([false, true])(
    'rejects duplicate routed identities returned during tool-search rehydration (same object: %s)',
    async (repeatSameObject) => {
      const first = tool({
        name: 'lookup',
        description: 'First deferred lookup.',
        parameters: z.object({}).strict(),
        deferLoading: true,
        execute: async () => 'first',
      });
      const second = tool({
        name: 'lookup',
        description: 'Second deferred lookup.',
        parameters: z.object({}).strict(),
        deferLoading: true,
        execute: async () => 'second',
      });
      const clientToolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: {
            type: 'tool_search',
            execution: 'client',
          },
        },
        async () => (repeatSameObject ? [first, first] : [first, second]),
      );
      const agent = new Agent({
        name: 'Duplicate restore agent',
        tools: [clientToolSearch],
      });
      const state = new RunState(new RunContext(), 'input', agent, 2);
      const callId = 'call_duplicate_restore';
      state._generatedItems.push(
        new RunToolSearchCallItem(
          {
            type: 'tool_search_call',
            id: 'ts_call_duplicate_restore',
            status: 'completed',
            arguments: { paths: [] },
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchCallItem,
          agent,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            id: 'ts_output_duplicate_restore',
            status: 'completed',
            tools: [
              {
                type: 'function',
                name: 'lookup',
                description: 'Deferred lookup.',
                strict: true,
                deferLoading: true,
                parameters: {
                  type: 'object',
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            providerData: { call_id: callId, execution: 'client' },
          } as protocol.ToolSearchOutputItem,
          agent,
        ),
      );

      await expect(
        RunState.fromString(agent, state.toString()),
      ).rejects.toThrow(
        'Client tool_search execute() returned multiple tools with the same routed identity.',
      );
    },
  );

  it('rejects duplicate routed identities in serialized tool-search output before rehydration', async () => {
    const validRuntimeLookup = tool({
      name: 'valid_lookup',
      description: 'Valid lookup.',
      parameters: z.object({}).strict(),
      execute: async () => 'valid',
    });
    const duplicateRuntimeLookup = tool({
      name: 'lookup',
      description: 'Deferred lookup.',
      parameters: z.object({}).strict(),
      deferLoading: true,
      execute: async () => 'lookup',
    });
    const execute = vi.fn(async () => validRuntimeLookup);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
        },
      },
      execute,
    );
    const agent = new Agent({
      name: 'Duplicate serialized restore agent',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const validCallId = 'call_valid_serialized_restore';
    const duplicateCallId = 'call_duplicate_serialized_restore';
    const validSerializedTool = {
      type: 'function',
      name: 'valid_lookup',
      description: 'Valid lookup.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    } as const;
    const serializedTool = {
      type: 'function',
      name: duplicateRuntimeLookup.name,
      description: duplicateRuntimeLookup.description,
      strict: true,
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    } as const;
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_valid_serialized_restore',
          status: 'completed',
          arguments: { query: 'valid' },
          providerData: { call_id: validCallId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_valid_serialized_restore',
          status: 'completed',
          tools: [validSerializedTool],
          providerData: { call_id: validCallId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_duplicate_serialized_restore',
          status: 'completed',
          arguments: { query: 'duplicate' },
          providerData: { call_id: duplicateCallId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_duplicate_serialized_restore',
          status: 'completed',
          tools: [serializedTool, serializedTool],
          providerData: { call_id: duplicateCallId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );

    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      'Serialized client tool_search output contains multiple tools with the same routed identity. Assign unique tool names or namespaces before resuming RunState.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts schema version 1.7 payloads when non-item context data mentions tool_search types', async () => {
    const context = new RunContext({
      custom: {
        type: 'tool_search_output',
        note: 'This is plain context data, not a serialized run item.',
      },
    });
    const agent = new Agent({ name: 'Agent17' });
    const state = new RunState(context, 'input1', agent, 2);

    const jsonVersion = state.toJSON() as any;
    jsonVersion.$schemaVersion = '1.7';

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(jsonVersion),
    );

    expect((restored._context.context as any).custom).toEqual({
      type: 'tool_search_output',
      note: 'This is plain context data, not a serialized run item.',
    });
  });

  it('approve updates context approvals correctly', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent2' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolX',
      callId: 'cid123',
      status: 'completed',
      arguments: 'arguments',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);
    state.approve(approvalItem);
    expect(
      state._context.isToolApproved({ toolName: 'toolX', callId: 'cid123' }),
    ).toBe(true);
  });

  it('returns undefined when approval status is unknown', () => {
    const context = new RunContext();
    expect(
      context.isToolApproved({ toolName: 'unknownTool', callId: 'cid999' }),
    ).toBeUndefined();
  });

  it('reject updates context approvals correctly', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent3' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolY',
      callId: 'cid456',
      status: 'completed',
      arguments: 'arguments',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem);

    expect(
      state._context.isToolApproved({ toolName: 'toolY', callId: 'cid456' }),
    ).toBe(false);
  });

  it('reject with message stores it and includes it in getRejectionMessage', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'MsgAgent' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolMsg',
      callId: 'msg-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, { message: 'Not safe to run' });

    expect(
      state._context.isToolApproved({ toolName: 'toolMsg', callId: 'msg-1' }),
    ).toBe(false);
    expect(state._context.getRejectionMessage('toolMsg', 'msg-1')).toBe(
      'Not safe to run',
    );
  });

  it('serialization round-trip preserves rejection messages', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'SerializeMsgAgent' });
    const state = new RunState(context, 'input', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolSer',
      callId: 'ser-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, { message: 'Denied for security' });

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._context.getRejectionMessage('toolSer', 'ser-1')).toBe(
      'Denied for security',
    );
    expect(
      restored._context.isToolApproved({
        toolName: 'toolSer',
        callId: 'ser-1',
      }),
    ).toBe(false);
  });

  it('restores pre-1.7 run states without rejection messages', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'LegacyMsgAgent' });
    const state = new RunState(context, 'input', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolLegacy',
      callId: 'legacy-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, { message: 'Denied for security' });

    const serialized = JSON.parse(state.toString());
    serialized.$schemaVersion = '1.6';
    const approvalKey = getFunctionToolStateKeyForCall(rawItem)!;
    const ownerApprovals = serialized.context.functionApprovals.find(
      (entry: any) => entry.agentIdentity === agent.name,
    ).approvals;
    serialized.context.approvals.toolLegacy = ownerApprovals[approvalKey];
    delete serialized.context.functionApprovals;
    delete serialized.context.approvals.toolLegacy.messages;

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    expect(
      restored._context.isToolApproved({
        toolName: 'toolLegacy',
        callId: 'legacy-1',
      }),
    ).toBe(false);
    expect(
      restored._context.getRejectionMessage('toolLegacy', 'legacy-1'),
    ).toBeUndefined();
  });

  it('per-callId messages: two rejections can have different messages', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'PerCallMsgAgent' });
    const state = new RunState(context, '', agent, 1);

    const rawItem1: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'sharedTool',
      callId: 'call-a',
      status: 'completed',
      arguments: '{}',
    };
    const rawItem2: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'sharedTool',
      callId: 'call-b',
      status: 'completed',
      arguments: '{}',
    };

    state.reject(new ToolApprovalItem(rawItem1, agent), {
      message: 'Reason A',
    });
    state.reject(new ToolApprovalItem(rawItem2, agent), {
      message: 'Reason B',
    });

    expect(state._context.getRejectionMessage('sharedTool', 'call-a')).toBe(
      'Reason A',
    );
    expect(state._context.getRejectionMessage('sharedTool', 'call-b')).toBe(
      'Reason B',
    );
  });

  it('reject with empty message preserves the empty string', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'EmptyMsgAgent' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolEmpty',
      callId: 'empty-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, { message: '' });

    expect(state._context.getRejectionMessage('toolEmpty', 'empty-1')).toBe('');
  });

  it('reject permanently when alwaysReject option is passed', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'Agent4' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolZ',
      callId: 'cid789',
      status: 'completed',
      arguments: 'arguments',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, { alwaysReject: true });

    expect(
      state._context.isToolApproved({ toolName: 'toolZ', callId: 'cid789' }),
    ).toBe(false);
    const approvals = state._context.toJSON().approvals;
    expect(approvals.toolZ.approved).toBe(false);
    expect(approvals.toolZ.rejected).toBe(true);
  });

  it('alwaysReject with message stores call-specific and sticky rejection messages', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'AlwaysRejectMsgAgent' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolAR',
      callId: 'ar-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, {
      alwaysReject: true,
      message: 'Blocked by policy',
    });

    expect(
      state._context.isToolApproved({ toolName: 'toolAR', callId: 'ar-1' }),
    ).toBe(false);
    expect(state._context.getRejectionMessage('toolAR', 'ar-1')).toBe(
      'Blocked by policy',
    );
    expect(state._context.getRejectionMessage('toolAR', 'ar-2')).toBe(
      'Blocked by policy',
    );
    const approvals = state._context.toJSON().approvals;
    expect(approvals.toolAR.rejected).toBe(true);
    expect(approvals.toolAR.messages).toEqual({
      'ar-1': 'Blocked by policy',
    });
    expect(approvals.toolAR.stickyRejectMessage).toBe('Blocked by policy');
  });

  it('alwaysReject with empty message preserves the empty string', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'AlwaysRejectEmptyMsgAgent' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolAREmpty',
      callId: 'ar-empty-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, {
      alwaysReject: true,
      message: '',
    });

    expect(
      state._context.getRejectionMessage('toolAREmpty', 'ar-empty-1'),
    ).toBe('');
    expect(
      state._context.getRejectionMessage('toolAREmpty', 'ar-empty-2'),
    ).toBe('');
  });

  it('serialization round-trip preserves alwaysReject sticky rejection messages', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'AlwaysRejectSerializeMsgAgent' });
    const state = new RunState(context, 'input', agent, 1);
    const rawItem: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'toolSticky',
      callId: 'sticky-1',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.reject(approvalItem, {
      alwaysReject: true,
      message: 'Blocked everywhere',
    });

    const restored = await RunState.fromString(agent, state.toString());
    expect(
      restored._context.getRejectionMessage('toolSticky', 'sticky-1'),
    ).toBe('Blocked everywhere');
    expect(
      restored._context.getRejectionMessage('toolSticky', 'sticky-2'),
    ).toBe('Blocked everywhere');
  });

  it('tracks qualified tool names for namespaced approvals', () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'AgentNamespaceApproval' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'lookup_account',
      namespace: 'crm',
      callId: 'cid_namespace',
      status: 'completed',
      arguments: '{}',
    };
    const approvalItem = new ToolApprovalItem(rawItem, agent);

    state.approve(approvalItem);
    const approvalKey = getFunctionToolStateKeyForCall(rawItem)!;

    expect(
      state._context.isToolApproved({
        toolName: approvalKey,
        callId: 'cid_namespace',
      }),
    ).toBe(true);
    expect(approvalItem.toolName).toBe('crm.lookup_account');
  });

  it('preserves declared tool names for top-level deferred approvals across resume', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'AgentDeferredApproval' });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'get_shipping_eta',
      namespace: 'get_shipping_eta',
      callId: 'cid_shipping_eta',
      status: 'completed',
      arguments: '{}',
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new ToolApprovalItem(rawItem, agent, 'get_shipping_eta'),
        ],
      },
    };

    const restored = await RunState.fromString(agent, state.toString());
    const [approvalItem] = restored.getInterruptions();
    restored.approve(approvalItem);
    const approvalKey = getFunctionToolStateKeyForCall(rawItem)!;

    expect(
      restored._context.isToolApproved({
        toolName: approvalKey,
        callId: 'cid_shipping_eta',
      }),
    ).toBe(true);
    expect(
      restored._context.isToolApproved({
        toolName: 'get_shipping_eta',
        callId: 'cid_shipping_eta',
      }),
    ).toBeUndefined();
    expect(approvalItem.toolName).toBe('get_shipping_eta');
  });

  it('resolves top-level deferred approval names from the agent tool set across resume', async () => {
    const context = new RunContext();
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const agent = new Agent({
      name: 'AgentDeferredApprovalResolved',
      tools: [shippingEta],
    });
    const state = new RunState(context, '', agent, 1);
    const rawItem: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'get_shipping_eta',
      namespace: 'get_shipping_eta',
      callId: 'cid_shipping_eta',
      status: 'completed',
      arguments: '{}',
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [new ToolApprovalItem(rawItem, agent)],
      },
    };

    const restored = await RunState.fromString(agent, state.toString());
    const [approvalItem] = restored.getInterruptions();
    restored.approve(approvalItem);
    const approvalKey = getFunctionToolStateKeyForCall(rawItem)!;

    expect(
      restored._context.isToolApproved({
        toolName: approvalKey,
        callId: 'cid_shipping_eta',
      }),
    ).toBe(true);
    expect(
      restored._context.isToolApproved({
        toolName: 'get_shipping_eta',
        callId: 'cid_shipping_eta',
      }),
    ).toBeUndefined();
    expect(approvalItem.toolName).toBe('get_shipping_eta');
  });

  it('fromString reconstructs state for simple agent', async () => {
    const context = new RunContext({ a: 1 });
    const agent = new Agent({ name: 'Solo' });
    const state = new RunState(context, 'orig', agent, 7);
    state._currentTurn = 5;
    state._noActiveAgentRun = false;
    const str = state.toString();
    const newState = await RunState.fromString(agent, str);
    expect(newState._maxTurns).toBe(7);
    expect(newState._currentTurn).toBe(5);
    expect(newState._currentAgent).toBe(agent);
    expect(newState._noActiveAgentRun).toBe(false);
    expect(newState._context.context).toEqual({ a: 1 });
    expect(newState._generatedItems).toEqual([]);
    expect(newState._modelResponses).toEqual([]);
    expect(newState._trace).toBeNull();
  });

  it('fromString rehydrates interruption items as RunToolApprovalItem', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'InterruptAgent' });
    const state = new RunState(context, 'input', agent, 3);
    const rawApproval: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'secure_tool',
      callId: 'call-secure-1',
      status: 'completed',
      arguments: '{}',
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [new ToolApprovalItem(rawApproval, agent)],
      },
    };

    const restored = await RunState.fromString(agent, state.toString());
    const interruptions = restored.getInterruptions();
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toBeInstanceOf(ToolApprovalItem);
    expect(interruptions[0].name).toBe('secure_tool');
    expect(interruptions[0].agent).toBe(agent);
  });

  it('fromString falls back to current agent for serialized interruptions with unknown agent', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'InterruptFallbackAgent' });
    const state = new RunState(context, 'input', agent, 3);
    const rawApproval: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'nested_tool',
      callId: 'call-nested-1',
      status: 'completed',
      arguments: '{}',
    };
    const serialized = state.toJSON() as any;
    serialized.currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          {
            type: 'tool_approval_item',
            rawItem: rawApproval,
            agent: { name: 'NestedAsToolAgent' },
            toolName: 'nested_tool',
          },
        ],
      },
    };

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    const interruptions = restored.getInterruptions();
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toBeInstanceOf(ToolApprovalItem);
    expect(interruptions[0].name).toBe('nested_tool');
    expect(interruptions[0].agent).toBe(agent);
    expect(() => restored.toString()).not.toThrow();
  });

  it('fromString rehydrates hosted tool interruptions and supports approval', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'HostedInterruptAgent' });
    const state = new RunState(context, 'input', agent, 3);
    const rawApproval: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'approval-1',
      name: 'search_codex_code',
      arguments: '{}',
      status: 'completed',
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [new ToolApprovalItem(rawApproval, agent)],
      },
    };

    const restored = await RunState.fromString(agent, state.toString());
    const interruptions = restored.getInterruptions();
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toBeInstanceOf(ToolApprovalItem);
    expect(interruptions[0].name).toBe('search_codex_code');

    restored.approve(interruptions[0]);
    expect(
      restored._context.isToolApproved({
        toolName: 'search_codex_code',
        callId: 'approval-1',
      }),
    ).toBe(true);
  });

  it('fromString rehydrates interruptions from legacy raw interruption shape', async () => {
    const context = new RunContext();
    const agent = new Agent({ name: 'LegacyInterruptAgent' });
    const state = new RunState(context, 'input', agent, 3);
    const rawApproval: protocol.ToolCallItem = {
      type: 'function_call',
      name: 'legacy_tool',
      callId: 'legacy-call-1',
      status: 'completed',
      arguments: '{}',
    };
    const serialized = state.toJSON() as any;
    serialized.currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          {
            rawItem: rawApproval,
            toolName: 'legacy_tool',
          },
        ],
      },
    };

    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    const interruptions = restored.getInterruptions();
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toBeInstanceOf(ToolApprovalItem);
    expect(interruptions[0].name).toBe('legacy_tool');
    expect(interruptions[0].agent).toBe(agent);
  });

  it('serializes and restores guardrail results', async () => {
    const context = new RunContext();
    const agentA = new Agent({ name: 'A' });
    const agentB = new Agent({ name: 'B' });
    agentA.handoffs = [agentB];

    const state = new RunState(context, 'input', agentA, 2);
    state._inputGuardrailResults = [
      {
        guardrail: { type: 'input', name: 'ig' },
        output: { tripwireTriggered: false, outputInfo: { ok: true } },
      },
    ];
    state._outputGuardrailResults = [
      {
        guardrail: { type: 'output', name: 'og' },
        agent: agentB,
        agentOutput: 'final',
        output: { tripwireTriggered: true, outputInfo: { done: true } },
      },
    ];
    state._toolInputGuardrailResults = [
      {
        guardrail: { type: 'tool_input', name: 'tig' },
        output: {
          behavior: { type: 'rejectContent', message: 'nope' },
          outputInfo: { a: 1 },
        },
      },
    ];
    state._toolOutputGuardrailResults = [
      {
        guardrail: { type: 'tool_output', name: 'tog' },
        output: {
          behavior: { type: 'allow' },
          outputInfo: { b: 2 },
        },
      },
    ];

    const str = state.toString();
    const newState = await RunState.fromString(agentA, str);

    expect(newState._inputGuardrailResults).toEqual(
      state._inputGuardrailResults,
    );
    expect(newState._outputGuardrailResults[0].guardrail).toEqual({
      type: 'output',
      name: 'og',
    });
    expect(newState._outputGuardrailResults[0].agent).toBe(agentB);
    expect(newState._outputGuardrailResults[0].agentOutput).toBe('final');
    expect(newState._outputGuardrailResults[0].output).toEqual({
      tripwireTriggered: true,
      outputInfo: { done: true },
    });
    expect(newState._toolInputGuardrailResults).toEqual(
      state._toolInputGuardrailResults,
    );
    expect(newState._toolOutputGuardrailResults).toEqual(
      state._toolOutputGuardrailResults,
    );
  });

  it('buildAgentMap collects agents without looping', () => {
    const agentA = new Agent({ name: 'AgentA' });
    const agentB = new Agent({ name: 'AgentB' });
    // Create a cycle A -> B -> A
    agentA.handoffs = [agentB];
    agentB.handoffs = [agentA];

    const map = buildAgentMap(agentA);
    expect(map.get('AgentA')).toBe(agentA);
    expect(map.get('AgentB')).toBe(agentB);
    expect(Array.from(map.keys()).sort()).toEqual(['AgentA', 'AgentB']);
  });

  it('buildAgentMap throws when distinct agents share the same name', () => {
    const childA = new Agent({ name: 'Child' });
    const childB = new Agent({ name: 'Child' });
    const root = new Agent({ name: 'Root', handoffs: [childA, childB] });

    expect(() => buildAgentMap(root)).toThrow(
      'Duplicate agent name "Child" detected. Use unique agent names when serializing RunState.',
    );
  });
});

describe('deserialize helpers', () => {
  it('deserializeModelResponse restores response object', () => {
    const serialized = {
      usage: { requests: 1, inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      output: [TEST_MODEL_MESSAGE],
      responseId: 'r1',
    } as any;
    const resp = deserializeModelResponse(serialized);
    expect(resp.responseId).toBe('r1');
    expect(resp.output[0].type).toBe('message');
  });

  it('deserializeItem restores MessageOutputItem', () => {
    const agent = new Agent({ name: 'X' });
    const map = new Map([[agent.name, agent]]);
    const item = deserializeItem(
      {
        type: 'message_output_item',
        rawItem: TEST_MODEL_MESSAGE,
        agent: { name: 'X' },
      },
      map,
    );
    expect(item.type).toBe('message_output_item');
    expect((item as any).agent).toBe(agent);
  });

  it('deserializeItem restores ToolSearchCallItem', () => {
    const agent = new Agent({ name: 'SearchAgent' });
    const map = new Map([[agent.name, agent]]);
    const item = deserializeItem(
      {
        type: 'tool_search_call_item',
        rawItem: {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: { paths: ['crm'], query: 'profile' },
        },
        agent: { name: 'SearchAgent' },
      },
      map,
    );

    expect(item).toBeInstanceOf(RunToolSearchCallItem);
    expect((item as RunToolSearchCallItem).rawItem.arguments).toEqual({
      paths: ['crm'],
      query: 'profile',
    });
  });

  it('deserializeItem restores ToolSearchOutputItem', () => {
    const agent = new Agent({ name: 'SearchAgent' });
    const map = new Map([[agent.name, agent]]);
    const item = deserializeItem(
      {
        type: 'tool_search_output_item',
        rawItem: {
          type: 'tool_search_output',
          id: 'ts_output',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'crm',
            },
          ],
        },
        agent: { name: 'SearchAgent' },
      },
      map,
    );

    expect(item).toBeInstanceOf(RunToolSearchOutputItem);
    expect((item as RunToolSearchOutputItem).rawItem.tools).toEqual([
      {
        type: 'tool_reference',
        functionName: 'lookup_account',
        namespace: 'crm',
      },
    ]);
  });

  it('deserializeItem restores ToolSearchOutputItem with concrete tool payloads', () => {
    const agent = new Agent({ name: 'SearchAgent' });
    const map = new Map([[agent.name, agent]]);
    const item = deserializeItem(
      {
        type: 'tool_search_output_item',
        rawItem: {
          type: 'tool_search_output',
          id: 'ts_output',
          status: 'completed',
          tools: [
            {
              type: 'namespace',
              name: 'crm',
              description: 'CRM tools.',
              tools: [
                {
                  type: 'function',
                  name: 'lookup_account',
                  description: 'Look up an account.',
                  deferLoading: true,
                  strict: true,
                  parameters: {
                    type: 'object',
                    properties: {
                      customerId: {
                        type: 'string',
                      },
                    },
                    required: ['customerId'],
                    additionalProperties: false,
                  },
                },
              ],
            },
          ],
        },
        agent: { name: 'SearchAgent' },
      },
      map,
    );

    expect(item).toBeInstanceOf(RunToolSearchOutputItem);
    expect((item as RunToolSearchOutputItem).rawItem.tools).toEqual([
      {
        type: 'namespace',
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          {
            type: 'function',
            name: 'lookup_account',
            description: 'Look up an account.',
            deferLoading: true,
            strict: true,
            parameters: {
              type: 'object',
              properties: {
                customerId: {
                  type: 'string',
                },
              },
              required: ['customerId'],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);
  });

  it('restores the enabled handoff winner instead of a later disabled duplicate', async () => {
    const enabledTarget = new Agent({
      name: 'SharedTarget',
      instructions: 'enabled target',
    });
    const disabledTarget = new Agent({
      name: 'SharedTarget',
      instructions: 'disabled target',
    });
    const enabledHandoff = handoff(enabledTarget, {
      toolNameOverride: 'transfer',
    });
    const disabledHandoff = handoff(disabledTarget, {
      toolNameOverride: 'transfer',
      isEnabled: false,
    });
    const agent = new Agent({
      name: 'HandoffWinnerRestore',
      handoffs: [enabledHandoff, disabledHandoff],
    });
    const state = new RunState(new RunContext(), '', agent, 1);
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_handoff_winner',
      callId: 'call_handoff_winner',
      name: 'transfer',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [{ toolCall, handoff: enabledHandoff }],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['transfer'],
      hasToolsOrApprovalsToRun: () => true,
    };

    const serialized = state.toJSON() as any;
    expect(
      serialized.lastProcessedResponse.handoffs[0].targetAgent.identity,
    ).toEqual(expect.any(String));
    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );

    expect(restored._lastProcessedResponse?.handoffs[0]?.handoff).toBe(
      enabledHandoff,
    );

    delete serialized.lastProcessedResponse.handoffs[0].targetAgent;
    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(
      'Run state handoff is missing its required target agent identity.',
    );

    serialized.$schemaVersion = '1.15';
    const restoredLegacy = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    expect(restoredLegacy._lastProcessedResponse?.handoffs[0]?.handoff).toBe(
      enabledHandoff,
    );
  });

  it('rejects a schema 1.16 handoff without exact identity instead of rebinding a same-name target', async () => {
    const executeToolSearch = vi.fn(async () => []);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      executeToolSearch,
    );
    const firstTarget = new Agent({ name: 'SharedTarget' });
    const secondTarget = new Agent({ name: 'SharedTarget' });
    const firstHandoff = handoff(firstTarget, {
      toolNameOverride: 'transfer',
    });
    const secondHandoff = handoff(secondTarget, {
      toolNameOverride: 'transfer',
    });
    const agent = new Agent({
      name: 'AmbiguousHandoffRestore',
      tools: [clientToolSearch],
      handoffs: [firstHandoff, secondHandoff],
    });
    const state = new RunState(new RunContext(), '', agent, 1);
    const toolSearchCallId = 'call_ambiguous_handoff_search';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_ambiguous_handoff_search',
          status: 'completed',
          arguments: { paths: [] },
          providerData: {
            call_id: toolSearchCallId,
            execution: 'client',
          },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_ambiguous_handoff_search',
          status: 'completed',
          tools: [],
          providerData: {
            call_id: toolSearchCallId,
            execution: 'client',
          },
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    );
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [
        {
          toolCall: {
            type: 'function_call',
            id: 'fc_ambiguous_handoff',
            callId: 'call_ambiguous_handoff',
            name: 'transfer',
            status: 'completed',
            arguments: '{}',
          },
          handoff: firstHandoff,
        },
      ],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['transfer'],
      hasToolsOrApprovalsToRun: () => true,
    };

    const serialized = state.toJSON() as any;
    allowConsole(['warn']);
    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow('Handoff transfer not found');
    expect(executeToolSearch).not.toHaveBeenCalled();

    const missingTarget = JSON.parse(JSON.stringify(serialized));
    delete missingTarget.lastProcessedResponse.handoffs[0].targetAgent;

    await expect(
      RunState.fromString(agent, JSON.stringify(missingTarget)),
    ).rejects.toThrow(
      'Run state handoff is missing its required target agent identity.',
    );
    expect(executeToolSearch).not.toHaveBeenCalled();

    serialized.lastProcessedResponse.handoffs[0].targetAgent.identity =
      'missing-target-identity';
    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow('Agent identity missing-target-identity not found');
    expect(executeToolSearch).not.toHaveBeenCalled();
  });

  it('rejects a handoff disabled by a replacement context during restore', async () => {
    const target = new Agent<{ enabled: boolean }>({ name: 'DynamicTarget' });
    const dynamicHandoff = handoff(target, {
      toolNameOverride: 'transfer',
      isEnabled: ({ runContext }) => runContext.context.enabled,
    });
    const agent = new Agent<{ enabled: boolean }>({
      name: 'DynamicHandoffRestore',
      handoffs: [dynamicHandoff],
    });
    const state = new RunState(new RunContext({ enabled: true }), '', agent, 1);
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_dynamic_handoff',
      callId: 'call_dynamic_handoff',
      name: 'transfer',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [{ toolCall, handoff: dynamicHandoff }],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['transfer'],
      hasToolsOrApprovalsToRun: () => true,
    };

    await expect(
      RunState.fromStringWithContext(
        agent,
        state.toString(),
        new RunContext({ enabled: false }),
        { contextStrategy: 'replace' },
      ),
    ).rejects.toThrow('Handoff transfer not found');
  });

  it('deserializeProcessedResponse restores namespaced function tools', async () => {
    const crmLookup = tool({
      name: 'lookup_account',
      description: 'Look up an account in CRM.',
      parameters: z.object({
        accountId: z.string(),
      }),
      execute: async () => 'crm',
    });
    const billingLookup = tool({
      name: 'lookup_account',
      description: 'Look up an account in billing.',
      parameters: z.object({
        accountId: z.string(),
      }),
      execute: async () => 'billing',
    });
    const crmNamespace = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [crmLookup],
    });
    const billingNamespace = toolNamespace({
      name: 'billing',
      description: 'Billing tools',
      tools: [billingLookup],
    });
    const agent = new Agent({
      name: 'NamespacedRestore',
      tools: [...crmNamespace, ...billingNamespace],
    });
    const state = new RunState(new RunContext(), '', agent, 1);
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_restore',
      callId: 'call_restore',
      name: 'lookup_account',
      namespace: 'billing',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };

    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: functionCall, tool: billingNamespace[0] as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['billing.lookup_account'],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored._lastProcessedResponse?.functions[0]?.tool).toBe(
      billingNamespace[0],
    );
    expect(restored._lastProcessedResponse?.functions[0]?.toolCall).toEqual(
      functionCall,
    );
  });

  it('deserializeProcessedResponse restores top-level deferred function tools', async () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const agent = new Agent({
      name: 'DeferredRestore',
      tools: [shippingEta],
    });
    const state = new RunState(new RunContext(), '', agent, 1);
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shipping_eta',
      callId: 'call_shipping_eta',
      name: 'get_shipping_eta',
      namespace: 'get_shipping_eta',
      status: 'completed',
      arguments: '{"trackingNumber":"ZX-123"}',
    };

    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall: functionCall, tool: shippingEta as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['get_shipping_eta'],
      hasToolsOrApprovalsToRun: () => true,
    } as any;

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored._lastProcessedResponse?.functions[0]?.tool).toBe(
      shippingEta,
    );
    expect(restored._lastProcessedResponse?.functions[0]?.toolCall).toEqual(
      functionCall,
    );
  });

  it('deserializeProcessedResponse restores computer actions', async () => {
    const tool = computerTool({ computer: new FakeComputer() });
    const agent = new Agent({ name: 'Comp', tools: [tool] });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [{ toolCall: call, computer: tool }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._lastProcessedResponse?.computerActions[0]?.computer).toBe(
      tool,
    );
  });

  it('deserializeProcessedResponse restores batched computer actions', async () => {
    const tool = computerTool({ computer: new FakeComputer() });
    const agent = new Agent({ name: 'Comp', tools: [tool] });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1-batched',
      status: 'completed',
      actions: [
        { type: 'move', x: 1, y: 2 },
        { type: 'click', x: 1, y: 2, button: 'left' },
      ],
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [{ toolCall: call, computer: tool }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(
      restored._lastProcessedResponse?.computerActions[0]?.toolCall.actions,
    ).toEqual(call.actions);
    expect(restored._lastProcessedResponse?.computerActions[0]?.computer).toBe(
      tool,
    );
  });

  it('deserializeProcessedResponse restores GA computer tool aliases', async () => {
    const tool = computerTool({ computer: new FakeComputer() });
    const agent = new Agent({ name: 'Comp', tools: [tool] });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1-alias',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [{ toolCall: call, computer: tool }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const json = state.toJSON();
    json.lastProcessedResponse!.computerActions[0]!.computer.name = 'computer';

    const restored = await RunState.fromString(agent, JSON.stringify(json));
    expect(restored._lastProcessedResponse?.computerActions[0]?.computer).toBe(
      tool,
    );
  });

  it('deserializeProcessedResponse prefers exact computer tool names', async () => {
    const gaTool = computerTool({
      name: 'computer',
      computer: new FakeComputer(),
    });
    const previewTool = computerTool({ computer: new FakeComputer() });
    const agent = new Agent({
      name: 'Comp',
      tools: [gaTool, previewTool],
    });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1-exact-name',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [{ toolCall: call, computer: gaTool }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._lastProcessedResponse?.computerActions[0]?.computer).toBe(
      gaTool,
    );
    expect(
      restored._lastProcessedResponse?.computerActions[0]?.computer,
    ).not.toBe(previewTool);
  });

  it('deserializeProcessedResponse restores shell actions', async () => {
    const shell = shellTool({ shell: new FakeShell() });
    const agent = new Agent({ name: 'Shell', tools: [shell] });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 's1',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [],
      shellActions: [{ toolCall: call, shell }],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._lastProcessedResponse?.shellActions[0]?.shell).toBe(shell);
  });

  it('deserializeProcessedResponse restores apply_patch actions', async () => {
    const editorTool = applyPatchTool({ editor: new FakeEditor() });
    const agent = new Agent({ name: 'Editor', tools: [editorTool] });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'ap1',
      status: 'completed',
      operation: { type: 'delete_file', path: 'tmp.txt' },
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [{ toolCall: call, applyPatch: editorTool }],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(
      restored._lastProcessedResponse?.applyPatchActions[0]?.applyPatch,
    ).toBe(editorTool);
  });

  it('deserializeProcessedResponse restores sandbox-injected apply_patch placeholders', async () => {
    const editorTool = applyPatchTool({ editor: new FakeEditor() });
    const agent = new SandboxAgent({ name: 'SandboxEditor' });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'ap_sandbox',
      status: 'completed',
      operation: { type: 'delete_file', path: 'tmp.txt' },
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [{ toolCall: call, applyPatch: editorTool }],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());

    expect(
      restored._lastProcessedResponse?.applyPatchActions[0]?.applyPatch.name,
    ).toBe('apply_patch');
    expect(
      processedResponseRequiresExecutionToolRehydration(
        restored._lastProcessedResponse,
      ),
    ).toBe(true);
  });

  it('fromString tolerates agents gaining MCP servers after serialization', async () => {
    const agentWithoutMcp = new Agent({ name: 'McpLite' });
    const state = new RunState(new RunContext(), 'input', agentWithoutMcp, 1);
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => false,
    };

    const serialized = state.toString();

    const stubMcpServer: MCPServer = {
      name: 'stub-server',
      cacheToolsList: false,
      toolFilter: undefined,
      async connect() {},
      async close() {},
      async listTools() {
        return [];
      },
      async callTool(
        _toolName: string,
        _args: Record<string, unknown> | null,
        _meta?: Record<string, unknown> | null,
      ) {
        return [];
      },
      async invalidateToolsCache() {},
    };

    const agentWithMcp = new Agent({
      name: 'McpLite',
      mcpServers: [stubMcpServer],
    });

    const restored = await RunState.fromString(agentWithMcp, serialized);
    expect(restored._currentAgent.mcpServers).toHaveLength(1);
    expect(restored._lastProcessedResponse?.hasToolsOrApprovalsToRun()).toBe(
      false,
    );
  });

  it('fromString tolerates serialized traces with new MCP servers', async () => {
    const traceProvider = getGlobalTraceProvider();
    const trace = traceProvider.createTrace({ name: 'restore-with-trace' });
    const agentWithoutMcp = new Agent({ name: 'McpTracey' });
    const state = new RunState(new RunContext(), 'input', agentWithoutMcp, 1);
    state._trace = trace;
    state._currentAgentSpan = createAgentSpan(
      { data: { name: agentWithoutMcp.name } },
      trace,
    );
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => false,
    };

    const serialized = state.toString();

    let listCalled = false;
    const stubMcpTool: MCPTool = {
      name: 'sample_tool',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    const stubMcpServer: MCPServer = {
      name: 'stub-traced-server',
      cacheToolsList: false,
      toolFilter: undefined,
      async connect() {},
      async close() {},
      async listTools() {
        listCalled = true;
        return [stubMcpTool];
      },
      async callTool(
        _toolName: string,
        _args: Record<string, unknown> | null,
        _meta?: Record<string, unknown> | null,
      ) {
        return [];
      },
      async invalidateToolsCache() {},
    };

    const agentWithMcp = new Agent({
      name: 'McpTracey',
      mcpServers: [stubMcpServer],
    });

    const restored = await RunState.fromString(agentWithMcp, serialized);
    expect(restored._currentAgent.mcpServers).toHaveLength(1);
    expect(listCalled).toBe(true);
  });

  it('deserializeProcessedResponse restores currentStep', async () => {
    const tool = computerTool({ computer: new FakeComputer() });
    const currentMcpTool = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: 'always',
      allowedCallers: ['programmatic'],
    });
    const agent = new Agent({
      name: 'Comp',
      tools: [tool, currentMcpTool],
    });
    const state = new RunState(new RunContext(), '', agent, 1);
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      handoffs: [],
      computerActions: [{ toolCall: call, computer: tool }],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [
        {
          requestItem: {
            rawItem: {
              type: 'hosted_tool_call',
              name: 'fetch_generic_url_content',
              status: 'in_progress',
              caller: {
                type: 'program',
                callerId: 'prog_approval_1',
              },
              providerData: {
                id: 'mcpr_685bc3c47ed88192977549b5206db77504d4306d5de6ab36',
                type: 'mcp_approval_request',
                arguments:
                  '{"url":"https://raw.githubusercontent.com/openai/codex/main/README.md"}',
                name: 'fetch_generic_url_content',
                server_label: 'gitmcp',
              },
            },
            type: 'tool_approval_item',
            agent: new Agent({ name: 'foo ' }),
            name: 'fetch_generic_url_content',
            arguments:
              '{"url":"https://raw.githubusercontent.com/openai/codex/main/README.md"}',
            toJSON: function (): any {
              throw new Error('Function not implemented.');
            },
          },
          mcpTool: {
            type: 'hosted_tool',
            name: 'hosted_mcp',
            providerData: {
              type: 'mcp',
              server_label: 'gitmcp',
              server_url: 'https://gitmcp.io/openai/codex',
              require_approval: {
                always: {
                  tool_names: ['fetch_generic_url_content'],
                },
                never: {
                  tool_names: [
                    'search_codex_code',
                    'fetch_codex_documentation',
                  ],
                },
              },
            },
          },
        },
      ],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_handoff',
      newAgent: agent,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._currentStep?.type).toBe('next_step_handoff');
    if (restored._currentStep?.type === 'next_step_handoff') {
      expect(restored._currentStep.newAgent).toBe(agent);
    }
    expect(
      restored._lastProcessedResponse?.mcpApprovalRequests[0].mcpTool,
    ).toBe(currentMcpTool);
    expect(
      restored._lastProcessedResponse?.mcpApprovalRequests[0].requestItem
        .rawItem.providerData,
    ).toEqual(
      state._lastProcessedResponse?.mcpApprovalRequests[0].requestItem.rawItem
        .providerData,
    );
    const restoredApprovalRawItem =
      restored._lastProcessedResponse?.mcpApprovalRequests[0].requestItem
        .rawItem;
    expect(restoredApprovalRawItem?.type).toBe('hosted_tool_call');
    if (restoredApprovalRawItem?.type !== 'hosted_tool_call') {
      throw new Error('Expected a hosted MCP approval item');
    }
    expect(restoredApprovalRawItem.caller).toEqual({
      type: 'program',
      callerId: 'prog_approval_1',
    });
  });

  it('uses an explicit prepared tool snapshot without adding stored runtime tools', async () => {
    const runtimeLookup = tool({
      name: 'lookup_runtime',
      description: 'Look up a runtime record.',
      parameters: z.object({}),
      execute: async () => 'runtime',
    });
    const agent = new Agent({ name: 'ExplicitPreparedTools' });
    const state = new RunState(new RunContext(), '', agent, 1);
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_runtime_explicit',
      callId: 'call_runtime_explicit',
      name: 'lookup_runtime',
      status: 'completed',
      arguments: '{}',
    };
    state.recordToolSearchRuntimeTools(
      agent,
      {
        type: 'tool_search_output',
        id: 'ts_output_runtime_explicit',
        status: 'completed',
        tools: [],
      } as protocol.ToolSearchOutputItem,
      [runtimeLookup],
    );
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall, tool: runtimeLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['lookup_runtime'],
      hasToolsOrApprovalsToRun: () => true,
    };

    await expect(
      rehydrateProcessedResponseTools(agent, state, []),
    ).rejects.toThrow('Tool lookup_runtime not found');
  });

  it('rejects resumed runtime function tools when isEnabled is false in replacement context', async () => {
    const lookupParams = z.object({});
    const runtimeLookup = tool<typeof lookupParams, { enabled: boolean }>({
      name: 'lookup_runtime',
      description: 'Look up a runtime record.',
      parameters: lookupParams,
      isEnabled: async ({ runContext }) => runContext.context.enabled,
      execute: async () => 'runtime',
    });
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
        },
      },
      async () => runtimeLookup,
    );
    const agent = new Agent<{ enabled: boolean }>({
      name: 'RuntimeEnabledRestore',
      tools: [clientToolSearch],
    });
    const state = new RunState(new RunContext({ enabled: true }), '', agent, 1);
    const searchCallId = 'call_runtime_enabled_restore';
    state._generatedItems.push(
      new RunToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call_runtime_enabled_restore',
          status: 'completed',
          arguments: { paths: [] },
          providerData: { call_id: searchCallId, execution: 'client' },
        } as protocol.ToolSearchCallItem,
        agent as any,
      ),
      new RunToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_runtime_enabled_restore',
          status: 'completed',
          tools: [
            {
              type: 'function',
              name: 'lookup_runtime',
              description: 'Look up a runtime record.',
              strict: true,
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
          providerData: { call_id: searchCallId, execution: 'client' },
        } as protocol.ToolSearchOutputItem,
        agent as any,
      ),
    );
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_runtime_enabled_restore',
      callId: 'call_lookup_runtime',
      name: 'lookup_runtime',
      status: 'completed',
      arguments: '{}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall, tool: runtimeLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['lookup_runtime'],
      hasToolsOrApprovalsToRun: () => true,
    };

    await expect(
      RunState.fromStringWithContext(
        agent,
        state.toString(),
        new RunContext({ enabled: false }),
        { contextStrategy: 'replace' },
      ),
    ).rejects.toThrow(
      'registered execute callback returned different runtime tools than the serialized state',
    );
  });

  it('rejects resumed function tools when isEnabled is false in replacement context', async () => {
    const lookupAccountParams = z.object({
      accountId: z.string(),
    });
    const crmLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [
        tool<typeof lookupAccountParams, { enabled: boolean }>({
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: lookupAccountParams,
          isEnabled: async ({ runContext }) => runContext.context.enabled,
          execute: async () => 'crm',
        }),
      ],
    })[0];
    const agent = new Agent({
      name: 'CRM',
      tools: [crmLookup as any],
    });
    const state = new RunState(new RunContext({ enabled: true }), '', agent, 1);
    const toolCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_lookup',
      callId: 'call_lookup',
      name: 'lookup_account',
      namespace: 'crm',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [{ toolCall, tool: crmLookup as any }],
      handoffs: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: ['crm.lookup_account'],
      hasToolsOrApprovalsToRun: () => true,
    };

    await expect(
      RunState.fromStringWithContext(
        agent,
        state.toString(),
        new RunContext({ enabled: false }),
        { contextStrategy: 'replace' },
      ),
    ).rejects.toThrow(/Tool .*lookup_account.* not found/);
  });
});
