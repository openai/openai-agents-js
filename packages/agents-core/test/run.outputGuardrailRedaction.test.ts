import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  GuardrailExecutionError,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunContext,
  RunState,
  RunToolCallItem,
  RunToolCallOutputItem,
  ToolGuardrailFunctionOutputFactory,
  Usage,
  UserError,
  defineToolOutputGuardrail,
  handoff,
  run,
  tool,
  toolNamespace,
  type AgentInputItem,
  type Session,
  type SessionHistoryTransactionArgs,
} from '../src';
import {
  buildBlockedToolOutputRawItem,
  getBlockedOutputSessionSnapshotRunItems,
  isCanonicalBlockedOutputPayload,
  redactBlockedResponseToolOutputs,
} from '../src/runner/blockedOutputPersistence';
import { sanitizeBlockedOutputGuardrailResults } from '../src/runner/guardrails';
import * as protocol from '../src/types/protocol';
import { getFunctionToolStateKeyForCall } from '../src/toolIdentity';
import { getToolInvocationFingerprint } from '../src/toolInvocation';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '../src/testing';

type RunMode = 'non_streamed' | 'streamed';

describe('output guardrail replay redaction', () => {
  it.each([
    {
      outputType: 'text',
      acceptedOutput: 'same value',
      rejectedOutput: 'same value',
    },
    {
      outputType: 'structured',
      acceptedOutput: { token: 'same value' },
      rejectedOutput: { token: 'same value' },
    },
  ])(
    'preserves accepted $outputType guardrail metadata when its value equals rejected output',
    ({ acceptedOutput, rejectedOutput }) => {
      const agent = new Agent({
        name: 'Equal historical guardrail output agent',
      });
      const state = new RunState(new RunContext(), 'input', agent, 1);
      const accepted = {
        guardrail: { type: 'output' as const, name: 'accepted guardrail' },
        agent,
        agentOutput: acceptedOutput,
        output: {
          tripwireTriggered: false,
          outputInfo: 'accepted historical guardrail metadata',
        },
      };
      const rejected = {
        guardrail: { type: 'output' as const, name: 'rejected guardrail' },
        agent,
        agentOutput: rejectedOutput,
        output: {
          tripwireTriggered: true,
          outputInfo: 'rejected guardrail metadata',
        },
      };
      state._outputGuardrailResults = [accepted, rejected];

      sanitizeBlockedOutputGuardrailResults(
        state,
        1,
        'Output withheld by an output guardrail.',
        new Map([[rejected, true]]),
      );

      expect(state._outputGuardrailResults[0]).toBe(accepted);
      expect(state._outputGuardrailResults[0]?.output.outputInfo).toBe(
        'accepted historical guardrail metadata',
      );
      expect(state._outputGuardrailResults[1]?.agentOutput).toBe(
        'Output withheld by an output guardrail.',
      );
      expect(
        state._outputGuardrailResults[1]?.output.outputInfo,
      ).toBeUndefined();
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves released $mode terminal resume behavior without output guardrails',
    async (mode) => {
      const terminalTool = tool({
        name: 'unguarded_restored_terminal_tool',
        description: 'Returns terminal output after a guardrail is removed.',
        parameters: z.object({}),
        execute: async () => 'unguarded terminal output',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'unguarded_restored_terminal_tool',
              {},
              { callId: 'unguarded-restored-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      let guardrailExecutions = 0;
      const agent = new Agent({
        name: 'Unguarded restored terminal agent',
        model,
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'removed terminal guardrail',
            execute: async () => {
              guardrailExecutions += 1;
              throw new Error('temporary guardrail error');
            },
          },
        ],
      });
      let failedState: RunState<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(GuardrailExecutionError);
        failedState = (error as GuardrailExecutionError).state;
      }
      failedState!._outputGuardrailResults.push({
        guardrail: { type: 'output', name: 'previous accepted guardrail' },
        agent,
        agentOutput: 'accepted historical output',
        output: {
          tripwireTriggered: false,
          outputInfo: 'accepted historical metadata',
        },
      });
      agent.outputGuardrails = [];
      const restored = await RunState.fromString(
        agent,
        failedState!.toString(),
      );

      let resumeError: unknown;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, restored, { stream: true });
          await result.completed;
        } else {
          await run(agent, restored);
        }
      } catch (error) {
        resumeError = error;
      }

      expect(resumeError).toBeInstanceOf(UserError);
      expect((resumeError as UserError).message).toContain(
        'Accepted final output cannot be resumed directly from serialized terminal state',
      );
      expect((resumeError as UserError).message).not.toContain(
        'previous output guardrail result ownership',
      );
      expect(guardrailExecutions).toBe(1);
      expect(model.calls).toHaveLength(1);
      expect(restored._outputGuardrailResults[0]?.output.outputInfo).toBe(
        'accepted historical metadata',
      );
    },
  );

  it('fails closed for unknown hosted output payloads', () => {
    const agent = new Agent({ name: 'Unknown hosted output redaction agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const rawItems = [
      {
        type: 'hosted_tool_call' as const,
        name: 'custom_hosted_call',
        status: 'completed',
        output: 'custom-top-level-secret',
      },
      {
        type: 'hosted_tool_call' as const,
        name: 'web_search_call',
        status: 'completed',
        providerData: {
          type: 'web_search_call',
          results: [{ text: 'web-search-provider-secret' }],
        },
      },
    ];
    state._generatedItems = rawItems.map(
      (rawItem) => new RunToolCallItem(rawItem, agent),
    );
    state._modelResponses = [
      {
        output: structuredClone(rawItems),
        usage: new Usage(),
      },
    ];
    state._lastTurnResponse = state._modelResponses[0];

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    const serialized = JSON.stringify({
      generatedItems: state._generatedItems,
      modelResponses: state._modelResponses,
    });
    expect(serialized).not.toContain('custom-top-level-secret');
    expect(serialized).not.toContain('web-search-provider-secret');
    expect(state._generatedItems).toEqual([]);
    expect(state._modelResponses[0]?.output).toEqual([]);
  });

  it('preserves accepted tool completion evidence when an unknown current suffix is dropped', () => {
    const agent = new Agent({ name: 'Accepted completion evidence agent' });
    const state = new RunState(new RunContext(), 'input', agent, 2);
    const acceptedCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'accepted_tool',
      callId: 'accepted-call',
      arguments: '{}',
    };
    const acceptedResult: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'accepted_tool',
      callId: 'accepted-call',
      status: 'completed',
      output: 'accepted-output',
    };
    const acceptedCallItem = new RunToolCallItem(acceptedCall, agent);
    const acceptedResultItem = new RunToolCallOutputItem(
      acceptedResult,
      agent,
      acceptedResult.output,
    );
    const acceptedFingerprint = getToolInvocationFingerprint(
      getFunctionToolStateKeyForCall(acceptedCall, 'accepted_tool')!,
      acceptedCall,
    );
    state._generatedItems = [acceptedCallItem, acceptedResultItem];
    state._completedToolInvocations.set(
      agent,
      new Map([['accepted-call', acceptedFingerprint]]),
    );
    state._completedToolInvocationEvidence.set(
      agent,
      new Map([
        [
          'accepted-call',
          {
            fingerprint: acceptedFingerprint,
            items: [acceptedCallItem, acceptedResultItem],
          },
        ],
      ]),
    );

    const rejectedCall = {
      type: 'hosted_tool_call' as const,
      name: 'custom_hosted_call',
      status: 'completed',
      output: 'rejected-current-output',
    };
    state._generatedItems.push(new RunToolCallItem(rejectedCall, agent));
    state._currentTurnPersistedItemCount = 2;
    state._modelResponses = [{ output: [rejectedCall], usage: new Usage() }];
    state._lastTurnResponse = state._modelResponses[0];

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);
    expect(state._generatedItems).toEqual([
      acceptedCallItem,
      acceptedResultItem,
    ]);
    expect(
      state._preflightToolInvocation(
        agent,
        'accepted-call',
        acceptedFingerprint,
      ),
    ).toBe(true);
    expect(
      state._completedToolInvocationEvidence.get(agent)?.has('accepted-call'),
    ).toBe(true);
    expect(state.toString()).not.toContain('rejected-current-output');
  });

  it('recognizes only complete canonical blocked-output payloads', () => {
    const raw: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      id: 'output-id',
      name: 'sensitive_tool',
      callId: 'call-id',
      status: 'completed',
      output: 'secret',
    };
    const canonical = buildBlockedToolOutputRawItem(raw);
    const forged = {
      ...canonical,
      providerData: { secret: 'forged-provider-secret' },
    } as protocol.FunctionCallResultItem;

    expect(isCanonicalBlockedOutputPayload(canonical)).toBe(true);
    expect(isCanonicalBlockedOutputPayload(forged)).toBe(false);
    expect(
      isCanonicalBlockedOutputPayload({
        ...canonical,
        providerData: {
          id: 'conversation-item-id',
          type: 'function_call_output',
        },
      }),
    ).toBe(false);
  });

  it('rebuilds known function pairs without forward-compatible extra fields', () => {
    const agent = new Agent({ name: 'Known call allowlist agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const rawItem = {
      type: 'function_call' as const,
      id: 'known-call-item',
      name: 'known_tool',
      callId: 'known-call',
      status: 'completed' as const,
      arguments: '{}',
      providerData: { future_secret: 'provider-extra-secret' },
      futureResult: 'top-level-extra-secret',
    };
    const rawResult = {
      type: 'function_call_result' as const,
      name: 'known_tool',
      callId: 'known-call',
      status: 'completed' as const,
      output: 'known-result-secret',
      providerData: { future_secret: 'result-provider-extra-secret' },
      futureResult: 'result-top-level-extra-secret',
    };
    state._generatedItems = [
      new RunToolCallItem(rawItem as protocol.FunctionCallItem, agent),
      new RunToolCallOutputItem(
        rawResult as protocol.FunctionCallResultItem,
        agent,
        rawResult.output,
      ),
    ];
    state._modelResponses = [
      {
        output: [rawItem as protocol.FunctionCallItem],
        usage: new Usage(),
      },
    ];
    state._lastTurnResponse = state._modelResponses[0];

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    const retained = JSON.stringify({
      generatedItems: state._generatedItems,
      modelResponses: state._modelResponses,
    });
    expect(retained).not.toContain('provider-extra-secret');
    expect(retained).not.toContain('top-level-extra-secret');
    expect(retained).not.toContain('known-result-secret');
    expect(state._generatedItems[0]?.rawItem).toEqual({
      type: 'function_call',
      id: 'known-call-item',
      name: 'known_tool',
      callId: 'known-call',
      status: 'completed',
      arguments: '{}',
    });
    expect(state._generatedItems[1]?.rawItem).toEqual({
      type: 'function_call_result',
      name: 'known_tool',
      callId: 'known-call',
      status: 'completed',
      output: 'Output withheld by an output guardrail.',
    });
  });

  it('drops the complete current suffix for incomplete or ambiguous function pairs', () => {
    const cases = [
      {
        name: 'orphan call',
        calls: [['first_tool', 'first-call']] as const,
        results: [] as const,
      },
      {
        name: 'mismatched result',
        calls: [['first_tool', 'first-call']] as const,
        results: [['other_tool', 'other-call']] as const,
      },
      {
        name: 'duplicate result',
        calls: [['first_tool', 'first-call']] as const,
        results: [
          ['first_tool', 'first-call'],
          ['first_tool', 'first-call'],
        ] as const,
      },
      {
        name: 'reordered results',
        calls: [
          ['first_tool', 'first-call'],
          ['second_tool', 'second-call'],
        ] as const,
        results: [
          ['second_tool', 'second-call'],
          ['first_tool', 'first-call'],
        ] as const,
      },
    ];

    for (const testCase of cases) {
      const agent = new Agent({ name: `${testCase.name} agent` });
      const state = new RunState(new RunContext(), 'input', agent, 1);
      const calls = testCase.calls.map(([name, callId]) => ({
        type: 'function_call' as const,
        name,
        callId,
        arguments: '{}',
      }));
      const callItems = calls.map((call) => new RunToolCallItem(call, agent));
      const resultItems = testCase.results.map(([name, callId], index) => {
        const rawResult: protocol.FunctionCallResultItem = {
          type: 'function_call_result',
          name,
          callId,
          status: 'completed',
          output: `${testCase.name}-secret-${index}`,
        };
        return new RunToolCallOutputItem(rawResult, agent, rawResult.output);
      });
      state._generatedItems = [...callItems, ...resultItems];
      state._modelResponses = [{ output: calls, usage: new Usage() }];
      state._lastTurnResponse = state._modelResponses[0];

      expect(redactBlockedResponseToolOutputs(state), testCase.name).toBe(true);
      expect(state._generatedItems, testCase.name).toEqual([]);
      expect(state._lastTurnResponse?.output, testCase.name).toEqual([]);
    }
  });

  it('builds the blocked Session snapshot only from the current sanitized suffix', () => {
    const agent = new Agent({ name: 'Current blocked snapshot agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const currentCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'shared_tool',
      callId: 'shared-call',
      arguments: '{}',
    };
    const historicalResult: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'shared_tool',
      callId: 'shared-call',
      status: 'completed',
      output: 'accepted-historical-result',
    };
    const currentResult: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'shared_tool',
      callId: 'shared-call',
      status: 'completed',
      output: 'rejected-current-result',
    };
    const currentCallItem = new RunToolCallItem(currentCall, agent);
    state._generatedItems = [
      new RunToolCallOutputItem(
        historicalResult,
        agent,
        historicalResult.output,
      ),
      currentCallItem,
      new RunToolCallOutputItem(currentResult, agent, currentResult.output),
    ];
    state._lastProcessedResponse = {
      newItems: [currentCallItem],
    } as RunState<any, any>['_lastProcessedResponse'];
    state._modelResponses = [{ output: [currentCall], usage: new Usage() }];
    state._lastTurnResponse = state._modelResponses[0];

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);
    const snapshot = getBlockedOutputSessionSnapshotRunItems(state);

    expect(snapshot.map((item) => item.rawItem.type)).toEqual([
      'function_call',
      'function_call_result',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(
      'accepted-historical-result',
    );
    expect(JSON.stringify(snapshot)).not.toContain('rejected-current-result');
    expect(JSON.stringify(snapshot)).toContain(
      'Output withheld by an output guardrail.',
    );
  });

  it('replaces immutable response aliases with data-free SDK-owned clones', () => {
    const agent = new Agent({ name: 'Immutable response cleanup agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const malformed = {
      type: 'function_call_result',
      name: 'malformed_tool',
      callId: '',
      status: 'completed',
      output: 'immutable-secret',
    } as protocol.FunctionCallResultItem;
    const later = {
      type: 'function_call_result',
      name: 'later_tool',
      callId: 'later-call',
      status: 'completed',
      output: 'later-secret',
    } as protocol.FunctionCallResultItem;
    const frozenResponse = Object.freeze({
      output: [structuredClone(malformed)],
      usage: new Usage(),
      responseId: 'shared-response',
      providerData: { output: [structuredClone(malformed)] },
    });
    const laterResponse = {
      output: [structuredClone(later)],
      usage: new Usage(),
      responseId: 'shared-response',
      providerData: { output: [structuredClone(later)] },
    };
    state._generatedItems = [
      new RunToolCallOutputItem(malformed, agent, malformed.output),
      new RunToolCallOutputItem(later, agent, later.output),
    ];
    state._modelResponses = [laterResponse, frozenResponse];
    state._lastTurnResponse = frozenResponse;

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    const retained = JSON.stringify({
      generatedItems: state._generatedItems,
      modelResponses: state._modelResponses,
      lastTurnResponse: state._lastTurnResponse,
    });
    expect(retained).not.toContain('immutable-secret');
    expect(retained).toContain('later-secret');
    expect(state._modelResponses[0]).toBe(laterResponse);
    expect(state._modelResponses[1]).not.toBe(frozenResponse);
    expect(state._modelResponses[0]?.providerData).toBeDefined();
    expect(state._modelResponses[1]?.providerData).toBeUndefined();
    expect(frozenResponse.output[0]).toMatchObject({
      output: 'immutable-secret',
    });
  });

  it('replaces a response whose output getter throws', () => {
    const agent = new Agent({ name: 'Throwing response cleanup agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const throwingResponse = {
      usage: new Usage(),
      responseId: 'throwing-response',
      get output(): protocol.ModelItem[] {
        throw new TypeError('throwing-output-secret');
      },
    };
    state._modelResponses = [throwingResponse];
    state._lastTurnResponse = throwingResponse;

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    expect(state._lastTurnResponse === throwingResponse).toBe(false);
    expect(state._lastTurnResponse?.output).toEqual([]);
    expect(JSON.stringify(state._modelResponses)).not.toContain(
      'throwing-output-secret',
    );
  });

  it('drops raw provider response snapshots from a sanitized response', () => {
    const agent = new Agent({ name: 'Provider snapshot cleanup agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const raw: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'sensitive_tool',
      callId: 'call-id',
      status: 'completed',
      output: 'provider-snapshot-secret',
    };
    const response = {
      output: [raw],
      usage: new Usage(),
      responseId: 'response-id',
      requestId: 'request-id',
      providerData: { output: [structuredClone(raw)] },
    };
    state._generatedItems = [new RunToolCallOutputItem(raw, agent, raw.output)];
    state._modelResponses = [response];
    state._lastTurnResponse = response;

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    expect(JSON.stringify(state._modelResponses)).not.toContain(
      'provider-snapshot-secret',
    );
    expect(state._lastTurnResponse).toMatchObject({
      responseId: 'response-id',
      requestId: 'request-id',
    });
    expect(state._lastTurnResponse?.providerData).toBeUndefined();
  });

  it('scrubs every discovered alias when an early payload is malformed', () => {
    const agent = new Agent({ name: 'Atomic cleanup agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const malformed = {
      type: 'function_call_result',
      name: 'malformed_tool',
      callId: '',
      status: 'completed',
      output: 'malformed-secret',
    } as protocol.FunctionCallResultItem;
    const valid: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'later_tool',
      callId: 'later-call',
      status: 'completed',
      output: 'later-secret',
    };
    state._generatedItems = [
      new RunToolCallOutputItem(malformed, agent, malformed.output),
      new RunToolCallOutputItem(valid, agent, valid.output),
    ];
    state._modelResponses = [
      {
        output: [structuredClone(malformed), structuredClone(valid)],
        usage: new Usage(),
      },
    ];
    state._lastTurnResponse = state._modelResponses[0];

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    const retained = JSON.stringify({
      generatedItems: state._generatedItems,
      modelResponses: state._modelResponses,
    });
    expect(retained).not.toContain('malformed-secret');
    expect(retained).not.toContain('later-secret');
    expect(state._modelResponses[0]?.output).toEqual([]);
  });

  it('does not scrub an unrelated response that reused a provider ID', () => {
    const agent = new Agent({ name: 'Bounded response redaction agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const terminal = {
      type: 'hosted_tool_call' as const,
      id: 'reused-mcp-id',
      name: 'mcp_call',
      status: 'completed' as const,
      output: 'terminal-secret',
      providerData: {
        type: 'mcp_call',
        id: 'reused-mcp-id',
        name: 'lookup',
        arguments: '{}',
        server_label: 'server',
      },
    };
    const unrelated = {
      ...structuredClone(terminal),
      output: 'unrelated-secret',
      providerData: {
        ...structuredClone(terminal.providerData),
      },
    };
    const terminalItem = new RunToolCallItem(terminal, agent);
    const unrelatedResponse = {
      output: [unrelated],
      usage: new Usage(),
      responseId: 'unrelated-response',
    };
    const terminalResponse = {
      output: [terminal],
      usage: new Usage(),
      responseId: 'terminal-response',
    };
    state._generatedItems = [terminalItem];
    state._modelResponses = [unrelatedResponse, terminalResponse];
    state._lastTurnResponse = terminalResponse;

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    expect(JSON.stringify(state._generatedItems)).not.toContain(
      'terminal-secret',
    );
    expect(JSON.stringify(state._lastTurnResponse)).not.toContain(
      'terminal-secret',
    );
    expect(JSON.stringify(unrelatedResponse)).toContain('unrelated-secret');
  });

  it('does not use a repeated responseId to revoke an earlier response', () => {
    const agent = new Agent({ name: 'Structural response ownership agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const archived: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'archived-mcp-id',
      name: 'mcp_call',
      status: 'completed',
      output: 'archived-secret',
      providerData: {
        type: 'mcp_call',
        id: 'archived-mcp-id',
        name: 'lookup',
        arguments: '{}',
        server_label: 'server',
      },
    };
    const terminal = {
      ...structuredClone(archived),
      id: 'terminal-mcp-id',
      output: 'terminal-secret',
      providerData: {
        ...structuredClone(archived.providerData),
        id: 'terminal-mcp-id',
        arguments: 42,
      },
    } as unknown as protocol.HostedToolCallItem;
    const archivedResponse = {
      output: [archived],
      usage: new Usage(),
      responseId: 'reused-response-id',
    };
    const terminalResponse = {
      output: [terminal],
      usage: new Usage(),
      responseId: 'reused-response-id',
    };
    state._generatedItems = [new RunToolCallItem(terminal, agent)];
    state._modelResponses = [archivedResponse, terminalResponse];
    state._lastTurnResponse = terminalResponse;

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    expect(JSON.stringify(archivedResponse)).toContain('archived-secret');
    expect(state._modelResponses[1]?.output).toEqual([]);
    expect(JSON.stringify(state._generatedItems)).not.toContain(
      'terminal-secret',
    );
  });

  it('revokes only the structurally current processed-item suffix', () => {
    const agent = new Agent({ name: 'Current suffix ownership agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const archivedRaw: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'archived_tool',
      callId: 'archived-call',
      status: 'completed',
      output: 'archived-secret',
    };
    const terminalRaw: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'terminal_tool',
      callId: 'terminal-call',
      status: 'completed',
      output: 'terminal-secret',
    };
    const archivedItem = new RunToolCallOutputItem(
      archivedRaw,
      agent,
      archivedRaw.output,
    );
    const terminalItem = new RunToolCallOutputItem(
      terminalRaw,
      agent,
      terminalRaw.output,
    );
    const terminalResponse = {
      output: [terminalRaw],
      usage: new Usage(),
      responseId: 'terminal-response',
    };
    state._generatedItems = [archivedItem, terminalItem];
    state._lastProcessedResponse = {
      newItems: [terminalItem],
    } as RunState<any, any>['_lastProcessedResponse'];
    state._modelResponses = [terminalResponse];
    state._lastTurnResponse = terminalResponse;

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    expect(JSON.stringify(state._generatedItems[0])).toContain(
      'archived-secret',
    );
    expect(JSON.stringify(state._generatedItems)).not.toContain(
      'terminal-secret',
    );
    expect(JSON.stringify(state._lastProcessedResponse)).not.toContain(
      'terminal-secret',
    );
  });

  it.each([
    'unowned',
    'stale_processed',
    'mixed_processed',
    'mixed_current_aliases',
    'restored_mixed_current_aliases',
    'historical_completion',
  ] as const)(
    'does not infer current ownership from $mode historical evidence after object identity is lost',
    (mode) => {
      const agent = new Agent({ name: 'Historical signature collision agent' });
      const state = new RunState(new RunContext(), 'input', agent, 1);
      const historicalCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'shared_tool',
        callId: 'shared-call',
        arguments: '{}',
      };
      const historicalResult: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        name: 'shared_tool',
        callId: 'shared-call',
        status: 'completed',
        output: 'accepted-historical-output',
      };
      const rejectedResult: protocol.FunctionCallResultItem = {
        ...historicalResult,
        output: 'rejected-current-output',
      };
      const currentResponseCall = structuredClone(historicalCall);
      const hasCurrentAliases =
        mode === 'mixed_current_aliases' ||
        mode === 'restored_mixed_current_aliases';
      if (hasCurrentAliases) {
        historicalCall.providerData = {
          retained: 'accepted-historical-provider-metadata',
        };
        currentResponseCall.providerData = {
          retained: 'rejected-current-provider-secret',
        };
      }
      if (mode === 'restored_mixed_current_aliases') {
        historicalCall.namespace = 'crm';
        historicalResult.namespace = 'crm';
        rejectedResult.namespace = 'crm';
        currentResponseCall.namespace = 'crm';
      }
      const historicalProcessedCall =
        mode === 'restored_mixed_current_aliases'
          ? structuredClone(historicalCall)
          : historicalCall;
      const currentProcessedCall =
        mode === 'restored_mixed_current_aliases'
          ? structuredClone(currentResponseCall)
          : currentResponseCall;
      const currentCallItem = new RunToolCallItem(currentResponseCall, agent);
      const historicalCallItem = new RunToolCallItem(historicalCall, agent);
      const historicalResultItem = new RunToolCallOutputItem(
        historicalResult,
        agent,
        historicalResult.output,
      );
      state._generatedItems = [
        historicalCallItem,
        historicalResultItem,
        ...(hasCurrentAliases ? [currentCallItem] : []),
        new RunToolCallOutputItem(rejectedResult, agent, rejectedResult.output),
      ];
      state._currentTurnPersistedItemCount = 2;
      state._lastProcessedResponse = {
        newItems:
          mode === 'stale_processed'
            ? [historicalCallItem]
            : mode === 'mixed_processed'
              ? [
                  historicalCallItem,
                  new RunToolCallItem(currentResponseCall, agent),
                ]
              : hasCurrentAliases
                ? [
                    historicalCallItem,
                    new RunToolCallItem(currentResponseCall, agent),
                    new RunToolCallOutputItem(
                      structuredClone(rejectedResult),
                      agent,
                      rejectedResult.output,
                    ),
                  ]
                : mode === 'unowned'
                  ? [
                      new RunToolCallItem(
                        structuredClone(historicalCall),
                        agent,
                      ),
                    ]
                  : [],
        functions:
          mode === 'historical_completion'
            ? [{ toolCall: structuredClone(historicalCall) }]
            : hasCurrentAliases
              ? [
                  { toolCall: historicalProcessedCall },
                  { toolCall: currentProcessedCall },
                ]
              : [],
      } as RunState<any, any>['_lastProcessedResponse'];
      if (mode === 'restored_mixed_current_aliases') {
        state._currentStep = {
          type: 'next_step_final_output',
          output: 'rejected-current-output',
        };
        state._serializedCurrentStep = state._currentStep;
      }
      if (mode === 'historical_completion' || mode === 'mixed_processed') {
        state._completedToolInvocationEvidence.set(
          agent,
          new Map([
            [
              historicalCall.callId,
              {
                fingerprint: 'accepted-historical-fingerprint',
                items: [historicalCallItem, historicalResultItem],
              },
            ],
          ]),
        );
        state._completedToolInvocations.set(
          agent,
          new Map([[historicalCall.callId, 'accepted-historical-fingerprint']]),
        );
      }
      state._modelResponses = [
        { output: [currentResponseCall], usage: new Usage() },
      ];
      state._lastTurnResponse = state._modelResponses[0];

      expect(redactBlockedResponseToolOutputs(state)).toBe(true);

      expect(state._generatedItems.slice(0, 2)).toEqual([
        historicalCallItem,
        historicalResultItem,
      ]);
      expect(JSON.stringify(state._generatedItems)).toContain(
        'accepted-historical-output',
      );
      expect(JSON.stringify(state._generatedItems)).not.toContain(
        'rejected-current-output',
      );
      if (mode === 'historical_completion' || mode === 'mixed_processed') {
        expect(
          state._completedToolInvocationEvidence
            .get(agent)
            ?.has(historicalCall.callId),
        ).toBe(true);
        expect(
          state._completedToolInvocations
            .get(agent)
            ?.get(historicalCall.callId),
        ).toBe('accepted-historical-fingerprint');
      }
      if (hasCurrentAliases) {
        expect(JSON.stringify(state._lastProcessedResponse)).not.toContain(
          'rejected-current-output',
        );
        expect(state._lastProcessedResponse?.newItems[0]).toBe(
          historicalCallItem,
        );
        expect(state._lastTurnResponse?.output).toHaveLength(1);
        expect(state._lastTurnResponse?.output[0]).toBe(
          state._generatedItems[2]?.rawItem,
        );
        expect(state._lastProcessedResponse?.functions[0]?.toolCall).toBe(
          historicalProcessedCall,
        );
        expect(state._lastProcessedResponse?.functions[1]?.toolCall).toBe(
          state._generatedItems[2]?.rawItem,
        );
        expect(
          JSON.stringify(state._lastProcessedResponse?.functions),
        ).toContain('accepted-historical-provider-metadata');
        expect(
          JSON.stringify(state._lastProcessedResponse?.functions),
        ).not.toContain('rejected-current-provider-secret');
        expect(getBlockedOutputSessionSnapshotRunItems(state)).toHaveLength(2);
      } else {
        expect(state._lastTurnResponse?.output).toEqual([]);
      }
    },
  );

  it('does not use a stale last-processed response as a structural anchor', () => {
    const agent = new Agent({ name: 'Stale response anchor agent' });
    const state = new RunState(new RunContext(), 'input', agent, 1);
    const unrelated = {
      type: 'hosted_tool_call' as const,
      id: 'unrelated-mcp-id',
      name: 'mcp_call',
      status: 'completed' as const,
      output: 'unrelated-secret',
      providerData: {
        type: 'mcp_call',
        id: 'unrelated-mcp-id',
        name: 'lookup',
        arguments: '{}',
        server_label: 'server',
      },
    };
    const terminal = {
      ...structuredClone(unrelated),
      id: 'terminal-mcp-id',
      output: 'terminal-secret',
      providerData: {
        ...structuredClone(unrelated.providerData),
        id: 'terminal-mcp-id',
      },
    };
    const unrelatedResponse = {
      output: [unrelated],
      usage: new Usage(),
      responseId: 'reused-response-id',
    };
    const terminalResponse = {
      output: [terminal],
      usage: new Usage(),
      responseId: 'reused-response-id',
    };
    state._modelResponses = [unrelatedResponse];
    state._lastTurnResponse = terminalResponse;
    state._lastProcessedResponse = {
      newItems: [new RunToolCallItem(unrelated, agent)],
    } as RunState<any, any>['_lastProcessedResponse'];

    expect(redactBlockedResponseToolOutputs(state)).toBe(true);

    expect(JSON.stringify(state._lastTurnResponse)).not.toContain(
      'terminal-secret',
    );
    expect(JSON.stringify(unrelatedResponse)).toContain('unrelated-secret');
    expect(JSON.stringify(state._lastProcessedResponse)).toContain(
      'unrelated-secret',
    );
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'allows a non-transactional $mode Session with run_llm_again',
    async (mode) => {
      class NonTransactionalSession implements Session {
        readonly items: AgentInputItem[] = [];

        async getSessionId(): Promise<string> {
          return 'non-transactional-run-again';
        }

        async getItems(): Promise<AgentInputItem[]> {
          return structuredClone(this.items);
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.items.push(...structuredClone(items));
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.items.pop();
        }

        async clearSession(): Promise<void> {
          this.items.length = 0;
        }
      }
      const model = new ScriptedModel([
        modelResponse({
          output: [assistantMessage('safe model output')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Supported Session agent',
        model,
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'output guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new NonTransactionalSession();

      if (mode === 'streamed') {
        const result = await run(agent, 'input', {
          session,
          stream: true,
        });
        await result.completed;
      } else {
        await run(agent, 'input', { session });
      }

      expect(model.calls).toHaveLength(1);
      expect(JSON.stringify(await session.getItems())).toContain(
        'safe model output',
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'runs output guardrails for a marker-valued terminal tool in $mode mode',
    async (mode) => {
      const executeGuardrail = vi.fn(async () => ({
        outputInfo: undefined,
        tripwireTriggered: false,
      }));
      const markerTool = tool({
        name: 'marker_tool',
        description: 'Returns the public blocked-output marker as normal data.',
        parameters: z.object({}),
        execute: async () => 'Output withheld by an output guardrail.',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [functionCall('marker_tool', {}, { callId: 'marker-call' })],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Marker-valued terminal tool agent',
        model,
        tools: [markerTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'passing output guardrail',
            execute: executeGuardrail,
          },
        ],
      });

      if (mode === 'streamed') {
        const result = await run(agent, 'input', { stream: true });
        await result.completed;
        expect(result.finalOutput).toBe(
          'Output withheld by an output guardrail.',
        );
      } else {
        const result = await run(agent, 'input');
        expect(result.finalOutput).toBe(
          'Output withheld by an output guardrail.',
        );
      }
      expect(executeGuardrail).toHaveBeenCalledTimes(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'redacts a terminal tool trip without mutating frozen guardrail outputs in $mode mode',
    async (mode) => {
      const frozenToolGuardrailOutput = Object.freeze({
        outputInfo: 'frozen-tool-output-info',
        behavior: Object.freeze({ type: 'allow' as const }),
        retainedOutput: 'frozen terminal tool secret',
      });
      const frozenOutputGuardrailOutput = Object.freeze({
        outputInfo: 'frozen-agent-output-info',
        tripwireTriggered: true,
      });
      const terminalTool = tool({
        name: 'frozen_guardrail_terminal_tool',
        description: 'Returns output rejected by a frozen guardrail result.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'frozen tool output guardrail',
            run: async () => frozenToolGuardrailOutput,
          }),
        ],
        execute: async () => 'frozen terminal tool secret',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'frozen_guardrail_terminal_tool',
              {},
              { callId: 'frozen-guardrail-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Frozen guardrail output agent',
        model,
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'frozen output guardrail',
            execute: async () => frozenOutputGuardrailOutput,
          },
        ],
      });

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(tripwire?.message).toBe('Output guardrail triggered.');
      expect(tripwire?.result.output).not.toBe(frozenOutputGuardrailOutput);
      expect(tripwire?.result.output.outputInfo).toBeUndefined();
      expect(tripwire?.state?._toolOutputGuardrailResults[0]?.output).not.toBe(
        frozenToolGuardrailOutput,
      );
      expect(
        tripwire?.state?._toolOutputGuardrailResults[0]?.output.outputInfo,
      ).toBeUndefined();
      expect(
        tripwire?.state?._toolOutputGuardrailResults[0]?.output,
      ).not.toHaveProperty('retainedOutput');
      expect(tripwire?.state?.toString()).not.toContain(
        'frozen terminal tool secret',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'frozen-agent-output-info',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'frozen-tool-output-info',
      );
      expect(frozenOutputGuardrailOutput.outputInfo).toBe(
        'frozen-agent-output-info',
      );
      expect(frozenToolGuardrailOutput.outputInfo).toBe(
        'frozen-tool-output-info',
      );
      expect(frozenToolGuardrailOutput.retainedOutput).toBe(
        'frozen terminal tool secret',
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'omits a terminal tool guardrail result when its behavior becomes unreadable in $mode mode',
    async (mode) => {
      let behaviorTypeReads = 0;
      const behavior = Object.defineProperty({}, 'type', {
        enumerable: true,
        get() {
          behaviorTypeReads += 1;
          if (behaviorTypeReads >= 3) {
            throw new Error('behavior type is no longer readable');
          }
          return 'allow';
        },
      }) as { type: 'allow' };
      const terminalTool = tool({
        name: 'unreadable_guardrail_terminal_tool',
        description: 'Returns output rejected by an output guardrail.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'unreadable tool output guardrail',
            run: async () => ({
              outputInfo: 'unreadable-tool-output-info',
              behavior,
              retainedOutput: 'unreadable terminal tool secret',
            }),
          }),
        ],
        execute: async () => 'unreadable terminal tool secret',
      });
      const agent = new Agent({
        name: 'Unreadable guardrail output agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'unreadable_guardrail_terminal_tool',
                {},
                { callId: 'unreadable-guardrail-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'blocking output guardrail',
            execute: async () => ({
              outputInfo: 'unreadable-output-guardrail-info',
              tripwireTriggered: true,
            }),
          },
        ],
      });

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(behaviorTypeReads).toBe(3);
      expect(tripwire?.message).toBe('Output guardrail triggered.');
      expect(tripwire?.state?._toolOutputGuardrailResults).toEqual([]);
      expect(tripwire?.state?.toString()).not.toContain(
        'unreadable terminal tool secret',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'unreadable-tool-output-info',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'unreadable-output-guardrail-info',
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'completes terminal cleanup when the fulfilled output verdict becomes unreadable in $mode mode',
    async (mode) => {
      let tripwireReads = 0;
      const outputGuardrailVerdict = {
        outputInfo: 'unreadable-verdict-output-info',
        get tripwireTriggered() {
          tripwireReads += 1;
          if (tripwireReads >= 2) {
            throw new Error('verdict is no longer readable');
          }
          return true;
        },
      };
      const terminalTool = tool({
        name: 'unreadable_verdict_terminal_tool',
        description: 'Returns output rejected by an unreadable verdict.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'unreadable verdict tool output guardrail',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'unreadable-verdict-tool-metadata',
              ),
          }),
        ],
        execute: async () => 'unreadable verdict terminal tool secret',
      });
      const agent = new Agent({
        name: 'Unreadable verdict agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'unreadable_verdict_terminal_tool',
                {},
                { callId: 'unreadable-verdict-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'unreadable output verdict',
            execute: async () => outputGuardrailVerdict,
          },
        ],
      });

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(tripwireReads).toBe(1);
      expect(tripwire?.message).toBe('Output guardrail triggered.');
      expect(tripwire?.result.output).toEqual({
        outputInfo: undefined,
        tripwireTriggered: true,
      });
      expect(
        tripwire?.state?._toolOutputGuardrailResults[0]?.output.outputInfo,
      ).toBeUndefined();
      expect(tripwire?.state?.toString()).not.toContain(
        'unreadable verdict terminal tool secret',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'unreadable-verdict-tool-metadata',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'unreadable-verdict-output-info',
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves every first-observed output verdict during terminal cleanup in $mode mode',
    async (mode) => {
      let tripwireReads = 0;
      let passingReads = 0;
      const tripwireVerdict = {
        outputInfo: 'multi-verdict-trip-output-info',
        get tripwireTriggered() {
          tripwireReads += 1;
          if (tripwireReads >= 2) {
            throw new Error('trip verdict was read twice');
          }
          return true;
        },
      };
      const passingVerdict = {
        outputInfo: 'multi-verdict-pass-output-info',
        get tripwireTriggered() {
          passingReads += 1;
          if (passingReads >= 2) {
            throw new Error('passing verdict was read twice');
          }
          return false;
        },
      };
      const terminalTool = tool({
        name: 'multiple_verdict_terminal_tool',
        description: 'Returns output rejected by one of multiple guardrails.',
        parameters: z.object({}),
        execute: async () => 'multiple verdict terminal tool secret',
      });
      const agent = new Agent({
        name: 'Multiple verdict agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'multiple_verdict_terminal_tool',
                {},
                { callId: 'multiple-verdict-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'multiple verdict trip guardrail',
            execute: async () => tripwireVerdict,
          },
          {
            name: 'multiple verdict passing guardrail',
            execute: async () => passingVerdict,
          },
        ],
      });

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(tripwireReads).toBe(1);
      expect(passingReads).toBe(1);
      expect(
        tripwire?.state?._outputGuardrailResults.map(
          (result) => result.output.tripwireTriggered,
        ),
      ).toEqual([true, false]);
      expect(tripwire?.state?.toString()).not.toContain(
        'multiple verdict terminal tool secret',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'multi-verdict-trip-output-info',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'multi-verdict-pass-output-info',
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'redacts a terminal tool verdict when tripwire formatting fails in $mode mode',
    async (mode) => {
      const circularOutputInfo: Record<string, unknown> = {
        secret: 'circular-output-info-secret',
      };
      circularOutputInfo.self = circularOutputInfo;
      const terminalTool = tool({
        name: 'non_json_guardrail_terminal_tool',
        description:
          'Returns output rejected with non-JSON guardrail metadata.',
        parameters: z.object({}),
        execute: async () => 'non-json terminal tool secret',
      });
      const agent = new Agent({
        name: 'Non-JSON guardrail output agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'non_json_guardrail_terminal_tool',
                {},
                { callId: 'non-json-guardrail-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'non-JSON output guardrail',
            execute: async () => ({
              outputInfo: circularOutputInfo,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();
      let failure: unknown;

      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { session, stream: true });
          await result.completed;
        } else {
          await run(agent, 'input', { session });
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(GuardrailExecutionError);
      const state = (failure as GuardrailExecutionError).state!;
      expect(state._outputGuardrailResults.at(-1)?.output.outputInfo).toBe(
        undefined,
      );
      expect(state.toString()).not.toContain('non-json terminal tool secret');
      expect(state.toString()).not.toContain('circular-output-info-secret');
      const persisted = JSON.stringify(await session.getItems());
      expect(persisted).toContain('Output withheld by an output guardrail.');
      expect(persisted).not.toContain('non-json terminal tool secret');
      expect(persisted).not.toContain('circular-output-info-secret');
      expect(circularOutputInfo.secret).toBe('circular-output-info-secret');
    },
  );

  it.each<{
    mode: RunMode;
    failureSurface: 'guardrail' | 'persistence';
  }>([
    { mode: 'non_streamed', failureSurface: 'guardrail' },
    { mode: 'streamed', failureSurface: 'guardrail' },
    { mode: 'non_streamed', failureSurface: 'persistence' },
    { mode: 'streamed', failureSurface: 'persistence' },
  ])(
    'redacts parsed structured output fields from $mode $failureSurface errors',
    async ({ mode, failureSurface }) => {
      const token = 'parsed-structured-terminal-secret';
      const rejectedOutput = JSON.stringify({ token });
      const terminalTool = tool({
        name: 'structured_error_terminal_tool',
        description:
          'Returns structured output rejected by an output guardrail.',
        parameters: z.object({}),
        execute: async () => rejectedOutput,
      });
      const agent = new Agent({
        name: 'Structured sibling guardrail error agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'structured_error_terminal_tool',
                {},
                { callId: 'structured-error-guardrail-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputType: z.object({ token: z.string() }),
        outputGuardrails: [
          {
            name: 'completed structured trip guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: true,
            }),
          },
          ...(failureSurface === 'guardrail'
            ? [
                {
                  name: 'rejecting structured sibling guardrail',
                  execute: async ({
                    agentOutput,
                  }: {
                    agentOutput: { token: string };
                  }) => {
                    throw new Error(agentOutput.token);
                  },
                },
              ]
            : []),
        ],
      });

      class RejectingStructuredSession extends MemorySession {
        override async applyHistoryTransaction(
          _args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          throw new Error(token);
        }
      }

      const session =
        failureSurface === 'persistence'
          ? new RejectingStructuredSession()
          : new MemorySession();
      let failure: unknown;

      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { session, stream: true });
          await result.completed;
        } else {
          await run(agent, 'input', { session });
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(
        failureSurface === 'guardrail'
          ? GuardrailExecutionError
          : OutputGuardrailTripwireTriggered,
      );
      expect((failure as Error).message).not.toContain(token);
      expect((failure as Error).stack).not.toContain(token);
      expect(JSON.stringify(failure)).not.toContain(token);
      if (failure instanceof GuardrailExecutionError) {
        expect(failure.error.message).not.toContain(token);
        expect(failure.error.stack).not.toContain(token);
      }
      const cause = (failure as Error & { cause?: unknown }).cause;
      if (cause instanceof Error) {
        expect(cause.message).not.toContain(token);
        expect(cause.stack).not.toContain(token);
      }
      const state = (
        failure as
          GuardrailExecutionError | OutputGuardrailTripwireTriggered<any, any>
      ).state!;
      expect(state.toString()).not.toContain(token);
      expect(JSON.stringify(await session.getItems())).not.toContain(token);
    },
  );

  it.each<{
    mode: RunMode;
    includeRejectedOutput: boolean;
  }>([
    { mode: 'non_streamed', includeRejectedOutput: false },
    { mode: 'streamed', includeRejectedOutput: false },
    { mode: 'non_streamed', includeRejectedOutput: true },
    { mode: 'streamed', includeRejectedOutput: true },
  ])(
    'redacts a terminal tool verdict and preserves safe sibling diagnostics in $mode mode with rejected output exposed: $includeRejectedOutput',
    async ({ mode, includeRejectedOutput }) => {
      const rejectedOutput = 'sibling-error terminal tool secret';
      const siblingError = new Error(
        includeRejectedOutput
          ? `sibling guardrail failed: ${rejectedOutput}`
          : 'sibling guardrail failed',
      );
      if (includeRejectedOutput) {
        (siblingError as Error & { cause?: unknown }).cause = new Error(
          rejectedOutput,
        );
        (siblingError as Error & { rejectedOutput?: string }).rejectedOutput =
          rejectedOutput;
      }
      let tripwireReads = 0;
      const completedTripVerdict = {
        outputInfo: 'sibling-trip-output-info-secret',
        get tripwireTriggered() {
          tripwireReads += 1;
          if (tripwireReads >= 2) {
            throw new Error('sibling verdict is no longer readable');
          }
          return true;
        },
      };
      const terminalTool = tool({
        name: 'sibling_error_terminal_tool',
        description:
          'Returns output rejected before a sibling guardrail fails.',
        parameters: z.object({}),
        execute: async () => rejectedOutput,
      });
      const agent = new Agent({
        name: 'Sibling guardrail error agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'sibling_error_terminal_tool',
                {},
                { callId: 'sibling-error-guardrail-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'completed trip guardrail',
            execute: async () => completedTripVerdict,
          },
          {
            name: 'rejecting sibling guardrail',
            execute: async () => {
              throw siblingError;
            },
          },
        ],
      });
      const session = new MemorySession();
      let failure: unknown;

      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { session, stream: true });
          await result.completed;
        } else {
          await run(agent, 'input', { session });
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(GuardrailExecutionError);
      expect((failure as Error).message).toContain('sibling guardrail failed');
      expect((failure as Error).message).not.toContain(rejectedOutput);
      expect((failure as Error).stack).not.toContain(rejectedOutput);
      expect((failure as GuardrailExecutionError).error.message).not.toContain(
        rejectedOutput,
      );
      expect((failure as GuardrailExecutionError).error.stack).not.toContain(
        rejectedOutput,
      );
      expect(
        (
          (failure as GuardrailExecutionError).error as Error & {
            cause?: unknown;
          }
        ).cause,
      ).toBeUndefined();
      expect(
        (
          (failure as GuardrailExecutionError).error as Error & {
            rejectedOutput?: string;
          }
        ).rejectedOutput,
      ).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain(rejectedOutput);
      expect(tripwireReads).toBe(1);
      const state = (failure as GuardrailExecutionError).state!;
      expect(state._outputGuardrailResults.at(-1)?.output.outputInfo).toBe(
        undefined,
      );
      expect(state.toString()).not.toContain(
        'sibling-error terminal tool secret',
      );
      expect(state.toString()).not.toContain('sibling-trip-output-info-secret');
      const persisted = JSON.stringify(await session.getItems());
      expect(persisted).toContain('Output withheld by an output guardrail.');
      expect(persisted).not.toContain('sibling-error terminal tool secret');
      expect(persisted).not.toContain('sibling-trip-output-info-secret');
    },
  );

  it.each<{
    mode: RunMode;
    includeSiblingFailure: boolean;
  }>([
    { mode: 'non_streamed', includeSiblingFailure: false },
    { mode: 'streamed', includeSiblingFailure: false },
    { mode: 'non_streamed', includeSiblingFailure: true },
    { mode: 'streamed', includeSiblingFailure: true },
  ])(
    'never attaches unsafe blocked-output persistence causes in $mode mode with sibling failure: $includeSiblingFailure',
    async ({ mode, includeSiblingFailure }) => {
      const rejectedOutput = 'blocked-persistence-cause-secret';
      const persistenceError = new Error(
        `Persistence rejected ${rejectedOutput}`,
      );
      (persistenceError as Error & { cause?: unknown }).cause = new Error(
        rejectedOutput,
      );
      (persistenceError as Error & { rejectedOutput?: string }).rejectedOutput =
        rejectedOutput;

      class RejectingSession extends MemorySession {
        override async applyHistoryTransaction(
          _args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          throw persistenceError;
        }
      }

      const terminalTool = tool({
        name: 'blocked_persistence_terminal_tool',
        description: 'Returns output rejected before Session persistence.',
        parameters: z.object({}),
        execute: async () => rejectedOutput,
      });
      const agent = new Agent({
        name: 'Blocked persistence error agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'blocked_persistence_terminal_tool',
                {},
                { callId: 'blocked-persistence-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'completed rejection guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: true,
            }),
          },
          ...(includeSiblingFailure
            ? [
                {
                  name: 'safe sibling failure guardrail',
                  execute: async () => {
                    throw new Error('safe sibling guardrail failure');
                  },
                },
              ]
            : []),
        ],
      });

      let failure: unknown;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', {
            session: new RejectingSession(),
            stream: true,
          });
          await result.completed;
        } else {
          await run(agent, 'input', { session: new RejectingSession() });
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(
        includeSiblingFailure
          ? GuardrailExecutionError
          : OutputGuardrailTripwireTriggered,
      );
      const safePersistenceError = (failure as Error & { cause?: unknown })
        .cause as Error & { cause?: unknown; rejectedOutput?: string };
      expect(safePersistenceError).toBeInstanceOf(Error);
      expect(safePersistenceError).not.toBe(persistenceError);
      expect(safePersistenceError.message).toContain('Persistence rejected');
      expect(safePersistenceError.message).toContain(
        'Output withheld by an output guardrail.',
      );
      expect(safePersistenceError.message).not.toContain(rejectedOutput);
      expect(safePersistenceError.stack).not.toContain(rejectedOutput);
      expect(safePersistenceError.cause).toBeUndefined();
      expect(safePersistenceError.rejectedOutput).toBeUndefined();
      expect((failure as Error).message).not.toContain(rejectedOutput);
      expect((failure as Error).stack).not.toContain(rejectedOutput);
      expect(JSON.stringify(failure)).not.toContain(rejectedOutput);
      expect(
        (
          failure as
            GuardrailExecutionError | OutputGuardrailTripwireTriggered<any, any>
        ).state?.toString(),
      ).not.toContain(rejectedOutput);
    },
  );

  it.each<{
    mode: RunMode;
    completedSiblingVerdict: boolean;
  }>([
    { mode: 'non_streamed', completedSiblingVerdict: false },
    { mode: 'streamed', completedSiblingVerdict: false },
    { mode: 'non_streamed', completedSiblingVerdict: true },
    { mode: 'streamed', completedSiblingVerdict: true },
  ])(
    'only trusts a real completed sibling verdict for caller-thrown tripwires in $mode mode: $completedSiblingVerdict',
    async ({ mode, completedSiblingVerdict }) => {
      const terminalOutput = completedSiblingVerdict
        ? 'caller-owned tripwire terminal output secret'
        : 'unblocked terminal tool output';
      const foreignAgent = new Agent({ name: 'Foreign tripwire agent' });
      const foreignState = new RunState(
        new RunContext(),
        completedSiblingVerdict ? terminalOutput : 'foreign input',
        foreignAgent,
        1,
      );
      const thrownTripwire = new OutputGuardrailTripwireTriggered(
        'Caller-thrown tripwire error',
        {
          guardrail: { type: 'output', name: 'caller-thrown tripwire' },
          agent: foreignAgent,
          agentOutput: completedSiblingVerdict
            ? terminalOutput
            : 'foreign output',
          output: {
            outputInfo: completedSiblingVerdict
              ? terminalOutput
              : 'foreign output info',
            tripwireTriggered: true,
          },
        } as any,
        foreignState,
      );
      if (completedSiblingVerdict) {
        (thrownTripwire as Error & { cause?: unknown }).cause = new Error(
          terminalOutput,
        );
        (thrownTripwire as Error & { rejectedOutput?: string }).rejectedOutput =
          terminalOutput;
      }
      const terminalTool = tool({
        name: 'thrown_tripwire_terminal_tool',
        description:
          'Returns output before a guardrail throws a tripwire error.',
        parameters: z.object({}),
        execute: async () => terminalOutput,
      });
      const agent = new Agent({
        name: 'Thrown tripwire error agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'thrown_tripwire_terminal_tool',
                {},
                { callId: 'thrown-tripwire-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          ...(completedSiblingVerdict
            ? [
                {
                  name: 'completed sibling rejection',
                  execute: async () => ({
                    outputInfo: undefined,
                    tripwireTriggered: true,
                  }),
                },
              ]
            : []),
          {
            name: 'throws a tripwire error',
            execute: async () => {
              throw thrownTripwire;
            },
          },
        ],
      });
      const session = new MemorySession();
      let failure: unknown;

      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { session, stream: true });
          await result.completed;
        } else {
          await run(agent, 'input', { session });
        }
      } catch (error) {
        failure = error;
      }

      const persisted = JSON.stringify(await session.getItems());
      if (!completedSiblingVerdict) {
        expect(failure).toBe(thrownTripwire);
        expect(thrownTripwire.state).toBe(foreignState);
        expect(persisted).toContain('unblocked terminal tool output');
        expect(persisted).not.toContain(
          'Output withheld by an output guardrail.',
        );
        return;
      }

      expect(failure).toBeInstanceOf(OutputGuardrailTripwireTriggered);
      expect(failure).not.toBe(thrownTripwire);
      const safeTripwire = failure as OutputGuardrailTripwireTriggered<
        any,
        any
      >;
      expect(safeTripwire.state).not.toBe(foreignState);
      expect(safeTripwire.state?._currentAgent).toBe(agent);
      expect(safeTripwire.result.agent).toBe(agent);
      expect(safeTripwire.result.guardrail.name).toBe(
        'completed sibling rejection',
      );
      expect(safeTripwire.result.agentOutput).toBe(
        'Output withheld by an output guardrail.',
      );
      expect(safeTripwire.result.output.outputInfo).toBeUndefined();
      expect(
        (safeTripwire as Error & { cause?: unknown }).cause,
      ).toBeUndefined();
      expect(
        (safeTripwire as Error & { rejectedOutput?: string }).rejectedOutput,
      ).toBeUndefined();
      expect(JSON.stringify(safeTripwire)).not.toContain(terminalOutput);
      expect(safeTripwire.state?.toString()).not.toContain(terminalOutput);
      expect(persisted).not.toContain(terminalOutput);
      expect(persisted).toContain('Output withheld by an output guardrail.');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves a restored $mode assistant trip with historical processed tool actions',
    async (mode) => {
      const acceptedTool = tool({
        name: 'historical_assistant_tool',
        description: 'Returns accepted output before an assistant response.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'historical assistant tool metadata',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'accepted assistant history metadata',
              ),
          }),
        ],
        execute: async () => 'accepted assistant history output',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'historical_assistant_tool',
              {},
              { callId: 'historical-assistant-call' },
            ),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [assistantMessage('assistant final output')],
          usage: new Usage(),
        }),
      ]);
      let attempts = 0;
      const agent = new Agent({
        name: 'Restored assistant historical action agent',
        model,
        tools: [acceptedTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'retrying assistant output guardrail',
            execute: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw new Error('temporary assistant guardrail failure');
              }
              return {
                outputInfo: 'assistant guardrail metadata',
                tripwireTriggered: true,
              };
            },
          },
        ],
      });
      const runOnce = async (input: string | RunState<any, any>) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { stream: true });
          await result.completed;
          return result;
        }
        return run(agent, input);
      };
      let failedState: RunState<any, any> | undefined;
      try {
        await runOnce('use the accepted tool');
      } catch (error) {
        expect(error).toBeInstanceOf(GuardrailExecutionError);
        failedState = (error as GuardrailExecutionError).state;
      }
      const historicalCall = failedState!._generatedItems.find(
        (item): item is RunToolCallItem =>
          item instanceof RunToolCallItem &&
          item.rawItem.type === 'function_call' &&
          item.rawItem.callId === 'historical-assistant-call',
      )!;
      const processedFunctions = failedState!._lastProcessedResponse!.functions;
      processedFunctions.push({
        tool: acceptedTool as unknown as (typeof processedFunctions)[number]['tool'],
        toolCall: historicalCall.rawItem as protocol.FunctionCallItem,
      });
      const restored = await RunState.fromString(
        agent,
        failedState!.toString(),
      );

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        await runOnce(restored);
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(attempts).toBe(2);
      expect(model.calls).toHaveLength(2);
      expect(tripwire?.result.agentOutput).toBe('assistant final output');
      expect(tripwire?.result.output.outputInfo).toBe(
        'assistant guardrail metadata',
      );
      expect(
        tripwire?.state?._toolOutputGuardrailResults[0]?.output.outputInfo,
      ).toBe('accepted assistant history metadata');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves earlier accepted tool guardrail metadata after a later model trip in $mode mode',
    async (mode) => {
      const acceptedTool = tool({
        name: 'accepted_tool',
        description:
          'Returns an accepted result before the later model output.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'accepted tool output guardrail',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'accepted-tool-output-info',
              ),
          }),
        ],
        execute: async () => 'accepted tool value',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('accepted_tool', {}, { callId: 'accepted-call' }),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [assistantMessage('blocked model output')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Later model trip metadata agent',
        model,
        tools: [acceptedTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'blocking output guardrail',
            execute: async () => ({
              outputInfo: 'model-output-info',
              tripwireTriggered: true,
            }),
          },
        ],
      });

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(tripwire?.result.agentOutput).toBe('blocked model output');
      expect(tripwire?.result.output.outputInfo).toBe('model-output-info');
      expect(
        tripwire?.state?._toolOutputGuardrailResults[0]?.output.outputInfo,
      ).toBe('accepted-tool-output-info');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'sanitizes only current terminal tool guardrail metadata in $mode mode',
    async (mode) => {
      const acceptedTool = tool({
        name: 'accepted_prefix_tool',
        description: 'Produces an accepted prefix before the terminal tool.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'accepted prefix output guardrail',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'accepted-prefix-output-info',
              ),
          }),
        ],
        execute: async () => 'accepted prefix value',
      });
      const terminalTool = tool({
        name: 'blocked_terminal_tool',
        description: 'Produces the rejected terminal result.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'terminal output guardrail',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'terminal-output-secret',
              ),
          }),
        ],
        execute: async () => 'blocked terminal value',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('accepted_prefix_tool', {}, { callId: 'prefix-call' }),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [
            functionCall(
              'blocked_terminal_tool',
              {},
              {
                callId: 'terminal-call',
              },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Current terminal guardrail metadata agent',
        model,
        tools: [acceptedTool, terminalTool],
        toolUseBehavior: { stopAtToolNames: ['blocked_terminal_tool'] },
        outputGuardrails: [
          {
            name: 'blocking output guardrail',
            execute: async () => ({
              outputInfo: 'terminal-agent-output-info',
              tripwireTriggered: true,
            }),
          },
        ],
      });

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(tripwire?.result.agentOutput).toBe(
        'Output withheld by an output guardrail.',
      );
      expect(tripwire?.result.output.outputInfo).toBeUndefined();
      expect(
        tripwire?.state?._toolOutputGuardrailResults.map(
          (result) => result.output.outputInfo,
        ),
      ).toEqual(['accepted-prefix-output-info', undefined]);
      expect(tripwire?.state?.toString()).not.toContain(
        'terminal-output-secret',
      );
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      (['live', 'restored'] as const).flatMap((continuation) =>
        (continuation === 'restored'
          ? (['unique', 'duplicate'] as const)
          : (['unique'] as const)
        ).map((guardrailNames) => ({ mode, continuation, guardrailNames })),
      ),
    ),
  )(
    'sanitizes previous $continuation $mode output guardrail attempts with $guardrailNames names',
    async ({ mode, continuation, guardrailNames }) => {
      const terminalTool = tool({
        name: 'previous_attempt_terminal_tool',
        description: 'Returns output checked by parallel agent guardrails.',
        parameters: z.object({}),
        execute: async () => 'previous-attempt-terminal-secret',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'previous_attempt_terminal_tool',
              {},
              { callId: 'previous-attempt-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      let attempts = 0;
      const agent = new Agent({
        name: 'Previous output guardrail attempt agent',
        model,
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name:
              guardrailNames === 'duplicate'
                ? 'shared sibling guardrail'
                : 'passing sibling guardrail',
            execute: async () => ({
              outputInfo: 'previous-attempt-guardrail-secret',
              tripwireTriggered: false,
            }),
          },
          {
            name:
              guardrailNames === 'duplicate'
                ? 'shared sibling guardrail'
                : 'retrying sibling guardrail',
            execute: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw new Error('temporary sibling guardrail failure');
              }
              return {
                outputInfo: 'current-attempt-guardrail-secret',
                tripwireTriggered: true,
              };
            },
          },
        ],
      });
      const runOnce = async (input: string | RunState<any, any>) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { stream: true });
          await result.completed;
          return result;
        }
        return run(agent, input);
      };

      let failedState: RunState<any, any> | undefined;
      try {
        await runOnce('run the terminal tool');
      } catch (error) {
        expect(error).toBeInstanceOf(GuardrailExecutionError);
        failedState = (error as GuardrailExecutionError).state;
      }

      failedState!._outputGuardrailResults.unshift({
        guardrail: {
          type: 'output',
          name:
            guardrailNames === 'duplicate'
              ? 'shared sibling guardrail'
              : 'accepted historical guardrail',
        },
        agent,
        agentOutput: 'accepted historical output',
        output: {
          outputInfo: 'accepted historical metadata',
          tripwireTriggered: false,
        },
      });
      const retryState =
        continuation === 'restored'
          ? await RunState.fromString(agent, failedState!.toString())
          : failedState!;

      if (continuation === 'restored') {
        let resumeError: unknown;
        try {
          await runOnce(retryState);
        } catch (error) {
          resumeError = error;
        }
        expect(resumeError).toBeInstanceOf(UserError);
        expect((resumeError as UserError).message).toContain(
          'previous output guardrail result ownership was not preserved',
        );
        expect(model.calls).toHaveLength(1);
        expect(attempts).toBe(1);
        expect(retryState._outputGuardrailResults[0]?.output.outputInfo).toBe(
          'accepted historical metadata',
        );
        return;
      }

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        await runOnce(retryState);
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(model.calls).toHaveLength(1);
      expect(attempts).toBe(2);
      expect(
        tripwire?.state?._outputGuardrailResults.map(
          (result) => result.output.outputInfo,
        ),
      ).toEqual([
        'accepted historical metadata',
        undefined,
        undefined,
        undefined,
      ]);
      const retained = tripwire?.state?.toString();
      expect(retained).toContain('accepted historical output');
      expect(retained).not.toContain('previous-attempt-terminal-secret');
      expect(retained).not.toContain('previous-attempt-guardrail-secret');
      expect(retained).not.toContain('current-attempt-guardrail-secret');
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      (
        [
          'unchanged',
          'removed',
          'short_circuit',
          'historical_collision',
          'changed_to_run_llm_again',
          'changed_stop_name',
          'changed_stop_to_historical',
        ] as const
      ).map((guardrails) => ({
        mode,
        guardrails,
      })),
    ),
  )(
    'redacts a serialized $mode terminal retry with $guardrails tool guardrails',
    async ({ mode, guardrails }) => {
      const acceptedTool = tool({
        name: 'restored_accepted_tool',
        description: 'Produces previously accepted output.',
        parameters: z.object({}),
        outputGuardrails:
          guardrails === 'historical_collision'
            ? []
            : [
                defineToolOutputGuardrail({
                  name: 'restored accepted metadata',
                  run: async () =>
                    ToolGuardrailFunctionOutputFactory.allow(
                      'accepted-metadata',
                    ),
                }),
              ],
        execute: async () => 'accepted-prefix-output',
      });
      const terminalTool = tool({
        name: 'restored_terminal_tool',
        description:
          'Produces terminal output that a resumed guardrail rejects.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'restored terminal metadata',
            run: async () =>
              guardrails === 'short_circuit'
                ? ToolGuardrailFunctionOutputFactory.rejectContent(
                    'replacement-terminal-secret',
                    'terminal-metadata-secret',
                  )
                : ToolGuardrailFunctionOutputFactory.allow(
                    'terminal-metadata-secret',
                  ),
          }),
          ...(guardrails === 'short_circuit'
            ? [
                defineToolOutputGuardrail({
                  name: 'terminal guardrail that does not execute',
                  run: async () => ToolGuardrailFunctionOutputFactory.allow(),
                }),
              ]
            : []),
        ],
        execute: async () => 'restored-terminal-output-secret',
      });
      const siblingTool = tool({
        name: 'restored_sibling_tool',
        description:
          'Produces sibling output in the rejected current response.',
        parameters: z.object({}),
        outputGuardrails:
          guardrails === 'historical_collision'
            ? []
            : [
                defineToolOutputGuardrail({
                  name: 'restored sibling metadata',
                  run: async () =>
                    ToolGuardrailFunctionOutputFactory.allow(
                      'sibling-metadata-secret',
                    ),
                }),
              ],
        execute: async () => 'restored-sibling-output-secret',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'restored_accepted_tool',
              {},
              { callId: 'accepted-call' },
            ),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [
            functionCall(
              'restored_sibling_tool',
              {},
              { callId: 'sibling-call' },
            ),
            functionCall(
              'restored_terminal_tool',
              {},
              { callId: 'terminal-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      let attempts = 0;
      const agent = new Agent({
        name: 'Serialized terminal guardrail retry agent',
        model,
        tools: [acceptedTool, siblingTool, terminalTool],
        toolUseBehavior: { stopAtToolNames: ['restored_terminal_tool'] },
        outputGuardrails: [
          {
            name: 'retrying terminal output guardrail',
            execute: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw new Error('temporary guardrail failure');
              }
              return {
                outputInfo: 'terminal-verdict-secret',
                tripwireTriggered: true,
              };
            },
          },
        ],
      });

      let failedState: RunState<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(GuardrailExecutionError);
        failedState = (error as GuardrailExecutionError).state;
      }

      expect(failedState?._finalOutputSource).toBe('tool_result');
      if (guardrails === 'removed') {
        terminalTool.outputGuardrails = [];
        siblingTool.outputGuardrails = [];
      } else if (guardrails === 'historical_collision') {
        acceptedTool.outputGuardrails = [
          defineToolOutputGuardrail({
            name: 'restored terminal metadata',
            run: async () => ToolGuardrailFunctionOutputFactory.allow(),
          }),
        ];
      } else if (guardrails === 'changed_to_run_llm_again') {
        agent.toolUseBehavior = 'run_llm_again';
      } else if (guardrails === 'changed_stop_name') {
        agent.toolUseBehavior = {
          stopAtToolNames: ['a_different_terminal_tool'],
        };
      } else if (guardrails === 'changed_stop_to_historical') {
        const historicalCall = failedState!._generatedItems.find(
          (item): item is RunToolCallItem =>
            item instanceof RunToolCallItem &&
            item.rawItem.type === 'function_call' &&
            item.rawItem.callId === 'accepted-call',
        )!;
        const processedFunctions =
          failedState!._lastProcessedResponse!.functions;
        processedFunctions.unshift({
          ...processedFunctions[0]!,
          tool: acceptedTool as unknown as (typeof processedFunctions)[number]['tool'],
          toolCall: historicalCall.rawItem as protocol.FunctionCallItem,
        });
        agent.toolUseBehavior = {
          stopAtToolNames: ['restored_accepted_tool'],
        };
      }
      const restored = await RunState.fromString(
        agent,
        failedState!.toString(),
      );
      expect(restored._finalOutputSource).toBeUndefined();

      if (
        guardrails === 'changed_to_run_llm_again' ||
        guardrails === 'changed_stop_name' ||
        guardrails === 'changed_stop_to_historical'
      ) {
        let resumeError: unknown;
        try {
          if (mode === 'streamed') {
            const result = await run(agent, restored, { stream: true });
            await result.completed;
          } else {
            await run(agent, restored);
          }
        } catch (error) {
          resumeError = error;
        }
        expect(resumeError).toBeInstanceOf(UserError);
        expect((resumeError as UserError).message).toContain(
          'terminal tool output provenance could not be verified',
        );
        expect(model.calls).toHaveLength(2);
        expect(attempts).toBe(1);
        return;
      }

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, restored, { stream: true });
          await result.completed;
        } else {
          await run(agent, restored);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(model.calls).toHaveLength(2);
      expect(attempts).toBe(2);
      expect(tripwire?.result.agentOutput).toBe(
        'Output withheld by an output guardrail.',
      );
      expect(
        tripwire?.state?._toolOutputGuardrailResults.map(
          (result) => result.output.outputInfo,
        ),
      ).toEqual(
        guardrails === 'historical_collision'
          ? [undefined]
          : [undefined, undefined, undefined],
      );
      const retained = tripwire?.state?.toString();
      expect(retained).toContain('accepted-prefix-output');
      expect(retained).not.toContain('restored-terminal-output-secret');
      expect(retained).not.toContain('restored-sibling-output-secret');
      expect(retained).not.toContain('replacement-terminal-secret');
      expect(retained).not.toContain('terminal-metadata-secret');
      expect(retained).not.toContain('sibling-metadata-secret');
      expect(retained).not.toContain('terminal-verdict-secret');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'redacts a restored $mode terminal retry selected by a qualified tool name',
    async (mode) => {
      let attempts = 0;
      const [lookupAccount] = toolNamespace({
        name: 'crm',
        description: 'CRM account tools.',
        tools: [
          tool({
            name: 'lookup_account',
            description: 'Looks up a CRM account.',
            parameters: z.object({}),
            execute: async () => 'namespaced-terminal-output-secret',
          }),
        ],
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'lookup_account',
              {},
              {
                callId: 'namespaced-terminal-call',
                namespace: 'crm',
                providerData: {
                  rejectedOutput: 'namespaced-terminal-output-secret',
                  retainedMetadata: 'processed-function-provider-secret',
                },
              },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Namespaced restored terminal agent',
        model,
        tools: [lookupAccount],
        toolUseBehavior: { stopAtToolNames: ['crm.lookup_account'] },
        outputGuardrails: [
          {
            name: 'retrying namespaced output guardrail',
            execute: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw new Error('temporary namespaced guardrail failure');
              }
              return {
                outputInfo: 'namespaced-verdict-secret',
                tripwireTriggered: true,
              };
            },
          },
        ],
      });

      let failedState: RunState<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'input', { stream: true });
          await result.completed;
        } else {
          await run(agent, 'input');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(GuardrailExecutionError);
        failedState = (error as GuardrailExecutionError).state;
      }

      const restored = await RunState.fromString(
        agent,
        failedState!.toString(),
      );
      expect(restored._finalOutputSource).toBeUndefined();

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, restored, { stream: true });
          await result.completed;
        } else {
          await run(agent, restored);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(model.calls).toHaveLength(1);
      expect(attempts).toBe(2);
      expect(tripwire?.result.agentOutput).toBe(
        'Output withheld by an output guardrail.',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'namespaced-terminal-output-secret',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'namespaced-verdict-secret',
      );
      expect(tripwire?.state?.toString()).not.toContain(
        'processed-function-provider-secret',
      );
      expect(
        tripwire?.state?._generatedItems
          .filter(
            (item) =>
              item instanceof RunToolCallItem ||
              item instanceof RunToolCallOutputItem,
          )
          .map((item) =>
            'namespace' in item.rawItem ? item.rawItem.namespace : undefined,
          ),
      ).toEqual(['crm', 'crm']);
      expect(tripwire?.state?._lastTurnResponse?.output[0]).toMatchObject({
        name: 'lookup_account',
        namespace: 'crm',
      });
      expect(
        tripwire?.state?._lastProcessedResponse?.functions[0]?.toolCall,
      ).toBe(tripwire?.state?._lastTurnResponse?.output[0]);
      expect(
        JSON.stringify(tripwire?.state?._lastProcessedResponse?.functions),
      ).not.toContain('processed-function-provider-secret');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves server-managed $mode assistant output guardrails',
    async (mode) => {
      const model = new ScriptedModel([
        modelResponse({
          output: [assistantMessage('safe server-managed assistant output')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Server-managed assistant output agent',
        model,
        outputGuardrails: [
          {
            name: 'passing assistant output guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });

      if (mode === 'streamed') {
        const result = await run(agent, 'input', {
          conversationId: 'server-conversation',
          stream: true,
        });
        await result.completed;
        expect(result.finalOutput).toBe('safe server-managed assistant output');
      } else {
        const result = await run(agent, 'input', {
          conversationId: 'server-conversation',
        });
        expect(result.finalOutput).toBe('safe server-managed assistant output');
      }
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a safe $mode approval checkpoint when output guardrails are configured',
    async (mode) => {
      const approvalTool = tool({
        name: 'guarded_approval_tool',
        description: 'Requires approval before producing any output.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved result',
      });
      const agent = new Agent({
        name: 'Guarded call-only approval agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'guarded_approval_tool',
                {},
                { callId: 'guarded-approval-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [approvalTool],
        outputGuardrails: [
          {
            name: 'guard that runs only after final output',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'input', { session, stream: true });
        await result.completed;
        expect(result.interruptions).toHaveLength(1);
      } else {
        const result = await run(agent, 'input', { session });
        expect(result.interruptions).toHaveLength(1);
      }

      expect(
        (await session.getItems()).some(
          (item) =>
            item.type === 'function_call' &&
            item.callId === 'guarded-approval-call',
        ),
      ).toBe(true);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'resumes a guarded $mode approval after its safe calls were checkpointed',
    async (mode) => {
      const firstTool = tool({
        name: 'checkpointed_first_tool',
        description: 'Requires the first approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'first checkpointed output',
      });
      const secondTool = tool({
        name: 'checkpointed_second_tool',
        description: 'Requires the second approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'second checkpointed output',
      });
      const agent = new Agent({
        name: 'Checkpointed multi-approval agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'checkpointed_first_tool',
                {},
                { callId: 'checkpointed-first-call' },
              ),
              functionCall(
                'checkpointed_second_tool',
                {},
                { callId: 'checkpointed-second-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [firstTool, secondTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'guard checkpointed tool output',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new MemorySession();
      const runOnce = async (input: string | RunState<any, any>) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return run(agent, input, { session });
      };

      const first = await runOnce('approve both tools');
      expect(
        (await session.getItems()).filter(
          (item) => item.type === 'function_call',
        ),
      ).toHaveLength(2);
      first.state.approve(first.interruptions[0]!);
      const partial = await runOnce(first.state);
      expect(partial.interruptions).toHaveLength(1);
      partial.state.approve(partial.interruptions[0]!);

      const completed = await runOnce(partial.state);
      expect(completed.finalOutput).toBe('second checkpointed output');
      expect(
        (await session.getItems()).filter(
          (item) => item.type === 'function_call',
        ),
      ).toHaveLength(2);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not defer a $mode approval for a disabled guarded handoff',
    async (mode) => {
      const guardedTarget = new Agent({
        name: 'Disabled guarded target',
        outputGuardrails: [
          {
            name: 'unreachable target guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const approvedTool = tool({
        name: 'disabled_handoff_approval_tool',
        description: 'Requires approval while the guarded handoff is disabled.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved result',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'disabled_handoff_approval_tool',
              {},
              { callId: 'approval-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Disabled handoff approval agent',
        model,
        tools: [approvedTool],
        handoffs: [handoff(guardedTarget, { isEnabled: false })],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'input', { session, stream: true });
        await result.completed;
        expect(result.interruptions).toHaveLength(1);
      } else {
        const result = await run(agent, 'input', { session });
        expect(result.interruptions).toHaveLength(1);
      }

      expect(
        (await session.getItems()).some(
          (item) =>
            item.type === 'function_call' && item.callId === 'approval-call',
        ),
      ).toBe(true);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves server-managed $mode handoffs to guarded agents',
    async (mode) => {
      const guardedModel = new ScriptedModel([
        modelResponse({
          output: [assistantMessage('safe guarded handoff output')],
          usage: new Usage(),
        }),
      ]);
      const guardedAgent = new Agent({
        name: 'Guarded handoff target',
        model: guardedModel,
        outputGuardrails: [
          {
            name: 'target output guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const targetHandoff = handoff(guardedAgent);
      const startingModel = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              targetHandoff.toolName,
              {},
              { callId: 'handoff-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const startingAgent = new Agent({
        name: 'Server-managed starting agent',
        model: startingModel,
        handoffs: [targetHandoff],
      });

      if (mode === 'streamed') {
        const result = await run(startingAgent, 'handoff', {
          conversationId: 'server-conversation',
          stream: true,
        });
        await result.completed;
        expect(result.finalOutput).toBe('safe guarded handoff output');
      } else {
        const result = await run(startingAgent, 'handoff', {
          conversationId: 'server-conversation',
        });
        expect(result.finalOutput).toBe('safe guarded handoff output');
      }
      expect(startingModel.calls).toHaveLength(1);
      expect(guardedModel.calls).toHaveLength(1);
    },
  );
});
