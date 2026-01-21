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
import {
  RunToolApprovalItem as ToolApprovalItem,
  RunMessageOutputItem,
  RunToolCallOutputItem,
} from '../src/items';
import { applyPatchTool, computerTool, shellTool } from '../src/tool';
import * as protocol from '../src/types/protocol';
import {
  TEST_MODEL_MESSAGE,
  FakeComputer,
  FakeShell,
  FakeEditor,
} from './stubs';
import { createAgentSpan } from '../src/tracing';
import { getGlobalTraceProvider } from '../src/tracing/provider';
import type { MCPServer, MCPTool } from '../src/mcp';

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
      async callTool() {
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
      async callTool() {
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
});
