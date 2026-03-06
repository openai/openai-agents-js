import { describe, it, expect } from 'vitest';
import {
  RunState,
  buildAgentMap,
  deserializeModelResponse,
  deserializeItem,
  CURRENT_SCHEMA_VERSION,
} from '../src/runState';
import { RunContext } from '../src/runContext';
import { Agent } from '../src/agent';
import { Usage } from '../src/usage';
import {
  RunToolApprovalItem as ToolApprovalItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../src/items';
import {
  applyPatchTool,
  computerTool,
  shellTool,
  tool,
  toolNamespace,
} from '../src/tool';
import * as protocol from '../src/types/protocol';
import {
  TEST_MODEL_MESSAGE,
  FakeComputer,
  FakeShell,
  FakeEditor,
} from './stubs';
import { RunResult } from '../src/result';
import { createAgentSpan } from '../src/tracing';
import { getGlobalTraceProvider } from '../src/tracing/provider';
import type { MCPServer, MCPTool } from '../src/mcp';
import { z } from 'zod';

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

  it('accepts schema version 1.8 payloads with tool_search items during deserialization', async () => {
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

    const restored = await RunState.fromString(agent, state.toString());

    expect(restored._generatedItems[0]).toBeInstanceOf(RunToolSearchCallItem);
    expect(restored._generatedItems[1]).toBeInstanceOf(RunToolSearchOutputItem);
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
    expect(approvals['toolZ'].approved).toBe(false);
    expect(approvals['toolZ'].rejected).toBe(true);
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
    expect(approvals['toolAR'].rejected).toBe(true);
    expect(approvals['toolAR'].messages).toEqual({
      'ar-1': 'Blocked by policy',
    });
    expect(approvals['toolAR'].stickyRejectMessage).toBe('Blocked by policy');
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

    expect(
      state._context.isToolApproved({
        toolName: 'crm.lookup_account',
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

    expect(
      restored._context.isToolApproved({
        toolName: 'get_shipping_eta',
        callId: 'cid_shipping_eta',
      }),
    ).toBe(true);
    expect(
      restored._context.isToolApproved({
        toolName: 'get_shipping_eta.get_shipping_eta',
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

    expect(
      restored._context.isToolApproved({
        toolName: 'get_shipping_eta',
        callId: 'cid_shipping_eta',
      }),
    ).toBe(true);
    expect(
      restored._context.isToolApproved({
        toolName: 'get_shipping_eta.get_shipping_eta',
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
      mcpApprovalRequests: [
        {
          requestItem: {
            rawItem: {
              type: 'hosted_tool_call',
              name: 'fetch_generic_url_content',
              status: 'in_progress',
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
    ).toEqual(state._lastProcessedResponse?.mcpApprovalRequests[0].mcpTool);
    expect(
      restored._lastProcessedResponse?.mcpApprovalRequests[0].requestItem
        .rawItem.providerData,
    ).toEqual(
      state._lastProcessedResponse?.mcpApprovalRequests[0].requestItem.rawItem
        .providerData,
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
