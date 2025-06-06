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
import { RunToolApprovalItem as ToolApprovalItem } from '../src/items';
import { computerTool } from '../src/tool';
import * as protocol from '../src/types/protocol';
import { TEST_MODEL_MESSAGE, FakeComputer } from './stubs';

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
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    const restored = await RunState.fromString(agent, state.toString());
    expect(restored._lastProcessedResponse?.computerActions[0]?.computer).toBe(
      tool,
    );
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
      mcpApprovalRequests: [],
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
  });
});
