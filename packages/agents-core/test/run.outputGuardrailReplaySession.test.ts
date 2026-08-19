import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunContext,
  RunResult,
  RunState,
  StreamedRunResult,
  ToolGuardrailFunctionOutputFactory,
  Usage,
  defineToolOutputGuardrail,
  run,
  tool,
  toolNamespace,
  type AgentInputItem,
  type Session,
  type SessionHistoryTransactionArgs,
  type ToolUseBehavior,
} from '../src';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '../src/testing';
import {
  saveStreamResultToSession,
  saveToSession,
} from '../src/runner/sessionPersistence';

type RunMode = 'non_streamed' | 'streamed';

class AppendOnlySession implements Session {
  readonly items: AgentInputItem[] = [];

  async getSessionId(): Promise<string> {
    return 'append-only-output-guardrail-session';
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

const terminalToolBehaviors: Array<{
  name: string;
  value: ToolUseBehavior;
}> = [
  { name: 'stop_on_first_tool', value: 'stop_on_first_tool' },
  {
    name: 'stopAtToolNames',
    value: { stopAtToolNames: ['sensitive_tool'] },
  },
  {
    name: 'custom finalizer',
    value: async (_context, results) => ({
      isFinalOutput: true,
      isInterrupted: undefined,
      finalOutput: String(
        results.find((result) => result.type === 'function_output')?.output,
      ),
    }),
  },
];

describe('output guardrails with Session persistence', () => {
  it.each(
    terminalToolBehaviors.flatMap(({ name, value }) =>
      (['non_streamed', 'streamed'] as const).flatMap((mode) =>
        [false, true].map((tripwire) => ({
          behaviorName: name,
          mode,
          toolUseBehavior: value,
          tripwire,
        })),
      ),
    ),
  )(
    'handles $behaviorName in $mode mode when guardrails trip=$tripwire',
    async ({ mode, toolUseBehavior, tripwire }) => {
      const executeTool = vi.fn(async () => 'sensitive tool output');
      const executeGuardrail = vi.fn(async () => ({
        outputInfo: undefined,
        tripwireTriggered: tripwire,
      }));
      const sensitiveTool = tool({
        name: 'sensitive_tool',
        description: 'Returns a sensitive value.',
        parameters: z.object({}),
        execute: executeTool,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('sensitive_tool', {}, { callId: 'sensitive-call' }),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Terminal tool Session agent',
        model,
        tools: [sensitiveTool],
        toolUseBehavior,
        outputGuardrails: [
          {
            name: 'output guardrail',
            execute: executeGuardrail,
          },
        ],
      });
      const session = new AppendOnlySession();

      if (tripwire && mode === 'streamed') {
        const result = await run(agent, 'input', { session, stream: true });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else if (tripwire) {
        await expect(run(agent, 'input', { session })).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else if (mode === 'streamed') {
        const result = await run(agent, 'input', { session, stream: true });
        await result.completed;
      } else {
        await run(agent, 'input', { session });
      }

      expect(model.calls).toHaveLength(1);
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeGuardrail).toHaveBeenCalledTimes(1);
      const stored = JSON.stringify(await session.getItems());
      if (tripwire) {
        expect(stored).not.toContain('sensitive tool output');
        expect(stored).toContain('Output withheld by an output guardrail.');

        const replayModel = new ScriptedModel([
          modelResponse({
            output: [assistantMessage('safe replay output')],
            usage: new Usage(),
          }),
        ]);
        const replayAgent = new Agent({
          name: 'Replay Session agent',
          model: replayModel,
        });
        await run(replayAgent, 'Continue', { session });
        const replayInput = JSON.stringify(replayModel.calls[0]?.request.input);
        expect(replayInput).not.toContain('sensitive tool output');
        expect(replayInput).toContain(
          'Output withheld by an output guardrail.',
        );
      } else {
        expect(stored).toContain('sensitive tool output');
      }
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      (['none', 'before_commit', 'after_commit'] as const).map(
        (failureTiming) => ({ mode, failureTiming }),
      ),
    ),
  )(
    'persists an input-only blocked $mode transaction with $failureTiming failure',
    async ({ mode, failureTiming }) => {
      class RetryableInputOnlySession extends MemorySession {
        readonly operationIds: string[] = [];
        readonly transactionItems: AgentInputItem[][] = [];
        directWrites = 0;
        private shouldFail = failureTiming !== 'none';

        override async addItems(items: AgentInputItem[]): Promise<void> {
          this.directWrites += 1;
          await super.addItems(items);
        }

        override async applyHistoryTransaction(
          args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          this.operationIds.push(args.operationId);
          if (args.transaction.type !== 'append_items') {
            throw new Error('Expected an input-only append transaction.');
          }
          this.transactionItems.push(structuredClone(args.transaction.items));
          if (this.shouldFail && failureTiming === 'before_commit') {
            this.shouldFail = false;
            throw new Error('input-only transaction failed before commit');
          }
          await super.applyHistoryTransaction(args);
          if (this.shouldFail && failureTiming === 'after_commit') {
            this.shouldFail = false;
            throw new Error('input-only transaction failed after commit');
          }
        }
      }

      const executeTool = vi.fn(async () => 'discarded terminal tool secret');
      const terminalTool = tool({
        name: 'discarded_response_tool',
        description: 'Returns output from a response that cannot be rebuilt.',
        parameters: z.object({}),
        execute: executeTool,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            assistantMessage('discarded assistant response secret'),
            functionCall(
              'discarded_response_tool',
              {},
              { callId: 'discarded-response-call' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Input-only blocked transaction agent',
        model,
        tools: [terminalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'reject unsafe mixed terminal response',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new RetryableInputOnlySession();
      const invoke = async (input: string | RunState<any, any>) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return;
        }
        await run(agent, input, { session });
      };

      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        await invoke('preserve the discarded response input');
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }

      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.directWrites).toBe(0);
      expect(session.operationIds).toHaveLength(1);
      expect(session.transactionItems[0]).toHaveLength(1);
      expect(JSON.stringify(session.transactionItems[0])).toContain(
        'preserve the discarded response input',
      );
      expect(JSON.stringify(session.transactionItems[0])).not.toContain(
        'discarded terminal tool secret',
      );
      expect(JSON.stringify(session.transactionItems[0])).not.toContain(
        'discarded assistant response secret',
      );

      if (failureTiming !== 'none') {
        expect(
          tripwire?.state?._pendingSessionHistoryTransaction,
        ).toBeDefined();
        await expect(invoke(tripwire!.state!)).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        expect(session.operationIds).toHaveLength(2);
        expect(session.operationIds[1]).toBe(session.operationIds[0]);
      }

      const persisted = await session.getItems();
      expect(persisted).toHaveLength(1);
      expect(JSON.stringify(persisted)).toContain(
        'preserve the discarded response input',
      );
      expect(JSON.stringify(persisted)).not.toContain(
        'discarded terminal tool secret',
      );
      expect(JSON.stringify(persisted)).not.toContain(
        'discarded assistant response secret',
      );
      expect(session.directWrites).toBe(0);
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not create an empty blocked-output transaction in $mode mode',
    async (mode) => {
      class RecordingSession extends MemorySession {
        transactionCalls = 0;

        override async applyHistoryTransaction(
          args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          this.transactionCalls += 1;
          await super.applyHistoryTransaction(args);
        }
      }

      const session = new RecordingSession();
      const agent = new Agent({ name: 'Empty blocked transaction agent' });
      const state: RunState<any, any> = new RunState(
        new RunContext(),
        'input',
        agent,
        1,
      );
      state._currentTurnSessionHistoryTransactionInputItems = [];

      if (mode === 'streamed') {
        await saveStreamResultToSession(
          session,
          new StreamedRunResult({ state }),
          { outputBlocked: true },
          [],
        );
      } else {
        await saveToSession(session, [], new RunResult(state), {
          outputBlocked: true,
        });
      }

      expect(session.transactionCalls).toBe(0);
      expect(await session.getItems()).toEqual([]);
      expect(state._pendingSessionHistoryTransaction).toBeUndefined();
      expect(state._currentTurnBlockedSessionStartIndex).toBeUndefined();
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves the separate function namespace in a blocked $mode Session snapshot',
    async (mode) => {
      const [namespacedTool] = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup_account',
            description: 'Returns a sensitive CRM account.',
            parameters: z.object({}),
            execute: async () => 'namespaced Session output secret',
          }),
        ],
      });
      const agent = new Agent({
        name: 'Namespaced blocked Session agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'lookup_account',
                {},
                {
                  callId: 'namespaced-session-call',
                  namespace: 'crm',
                },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [namespacedTool],
        toolUseBehavior: { stopAtToolNames: ['crm.lookup_account'] },
        outputGuardrails: [
          {
            name: 'block namespaced Session output',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new AppendOnlySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'Look up the account.', {
          session,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          run(agent, 'Look up the account.', { session }),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      const toolItems = (await session.getItems()).filter(
        (item) =>
          item.type === 'function_call' || item.type === 'function_call_result',
      );
      expect(
        toolItems.map((item) => ({
          type: item.type,
          name: item.name,
          namespace: item.namespace,
        })),
      ).toEqual([
        { type: 'function_call', name: 'lookup_account', namespace: 'crm' },
        {
          type: 'function_call_result',
          name: 'lookup_account',
          namespace: 'crm',
        },
      ]);
      expect(JSON.stringify(toolItems)).not.toContain(
        'namespaced Session output secret',
      );
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      (
        [
          'run_llm_again',
          'stop_on_first_tool',
          'stop_at_names',
          'custom',
        ] as const
      ).map((behavior) => ({ mode, behavior })),
    ),
  )(
    'preserves a completed $mode approval sibling before resuming with $behavior',
    async ({ mode, behavior }) => {
      const approveExecute = vi.fn(async () => 'approved sibling output');
      const siblingExecute = vi.fn(async () => 'completed nonterminal sibling');
      const approvalTool = tool({
        name: 'pending_approval_tool',
        description: 'Requires approval before execution.',
        parameters: z.object({}),
        needsApproval: true,
        execute: approveExecute,
      });
      const siblingTool = tool({
        name: 'completed_sibling_tool',
        description: 'Completes while a sibling awaits approval.',
        parameters: z.object({}),
        execute: siblingExecute,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'pending_approval_tool',
              {},
              {
                callId: 'pending-approval-call',
              },
            ),
            functionCall(
              'completed_sibling_tool',
              {},
              {
                callId: 'completed-sibling-call',
              },
            ),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [assistantMessage('approved sibling continuation')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Nonterminal approval sibling agent',
        model,
        tools: [approvalTool, siblingTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'guard the eventual model output',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new MemorySession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return run(agent, input, { session });
      };

      const first = await runOnce('Use both approval siblings.');
      expect(first.interruptions).toHaveLength(1);
      expect(siblingExecute).toHaveBeenCalledTimes(1);
      expect(approveExecute).not.toHaveBeenCalled();
      const checkpoint = await session.getItems();
      expect(
        checkpoint
          .filter(
            (item) =>
              (item.type === 'function_call' ||
                item.type === 'function_call_result') &&
              item.callId === 'completed-sibling-call',
          )
          .map((item) => item.type),
      ).toEqual(['function_call', 'function_call_result']);
      expect(JSON.stringify(checkpoint)).toContain(
        'completed nonterminal sibling',
      );
      expect(first.state._currentTurnPersistedItemCount).toBeGreaterThan(0);
      first.state.approve(first.interruptions[0]!);

      if (behavior !== 'run_llm_again') {
        agent.toolUseBehavior =
          behavior === 'stop_on_first_tool'
            ? 'stop_on_first_tool'
            : behavior === 'stop_at_names'
              ? { stopAtToolNames: ['pending_approval_tool'] }
              : async (_context, results) => ({
                  isFinalOutput: true,
                  isInterrupted: undefined,
                  finalOutput: String(
                    results.find((result) => result.type === 'function_output')
                      ?.output,
                  ),
                });
        await expect(runOnce(first.state)).rejects.toThrow(
          'persisted response ownership cannot be proven',
        );
        expect(approveExecute).not.toHaveBeenCalled();
        expect(siblingExecute).toHaveBeenCalledTimes(1);
        expect(model.calls).toHaveLength(1);
        expect(await session.getItems()).toEqual(checkpoint);
        return;
      }

      const resumed = await runOnce(first.state);
      expect(resumed.finalOutput).toBe('approved sibling continuation');
      expect(approveExecute).toHaveBeenCalledTimes(1);
      expect(siblingExecute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      const persisted = await session.getItems();
      for (const callId of [
        'pending-approval-call',
        'completed-sibling-call',
      ]) {
        expect(
          persisted
            .filter(
              (item) =>
                (item.type === 'function_call' ||
                  item.type === 'function_call_result') &&
                item.callId === callId,
            )
            .map((item) => item.type),
        ).toEqual(['function_call', 'function_call_result']);
      }
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'resumes a later call-only approval after an earlier $mode tool result',
    async (mode) => {
      const historicalExecute = vi.fn(async () => 'accepted earlier result');
      const approvedExecute = vi.fn(async () => 'approved later result');
      const historicalTool = tool({
        name: 'historical_tool',
        description: 'Returns an accepted result before the approval.',
        parameters: z.object({}),
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'accepted historical tool guardrail',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'accepted historical guardrail metadata',
              ),
          }),
        ],
        execute: historicalExecute,
      });
      const approvalTool = tool({
        name: 'later_approval_tool',
        description: 'Requires approval after the earlier result.',
        parameters: z.object({}),
        needsApproval: true,
        execute: approvedExecute,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('historical_tool', {}, { callId: 'historical-call' }),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [
            functionCall(
              'later_approval_tool',
              {},
              { callId: 'later-approval-call' },
            ),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [assistantMessage('approved continuation complete')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Historical result before approval agent',
        model,
        tools: [historicalTool, approvalTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'passing approval output guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new MemorySession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
        useSession = true,
      ) => {
        const options = useSession ? { session } : {};
        if (mode === 'streamed') {
          const result = await run(agent, input, {
            ...options,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return run(agent, input, options);
      };

      const first = await runOnce('Run both tools.', false);
      expect(first.interruptions).toHaveLength(1);
      expect(historicalExecute).toHaveBeenCalledTimes(1);
      expect(approvedExecute).not.toHaveBeenCalled();
      expect(
        first.state._toolOutputGuardrailResults[0]?.output.outputInfo,
      ).toBe('accepted historical guardrail metadata');

      const restored = await RunState.fromString(agent, first.state.toString());
      restored.approve(restored.getInterruptions()[0]!);
      const resumed = await runOnce(restored);

      expect(resumed.finalOutput).toBe('approved continuation complete');
      expect(historicalExecute).toHaveBeenCalledTimes(1);
      expect(approvedExecute).toHaveBeenCalledTimes(1);
      expect(
        resumed.state._toolOutputGuardrailResults[0]?.output.outputInfo,
      ).toBe('accepted historical guardrail metadata');
      const stored = JSON.stringify(await session.getItems());
      expect(stored).toContain('accepted earlier result');
      expect(stored).toContain('approved later result');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a legacy persisted partial approval before $mode resume side effects',
    async (mode) => {
      const firstExecute = vi.fn(async () => 'legacy first secret');
      const secondExecute = vi.fn(async () => 'legacy second secret');
      const firstTool = tool({
        name: 'legacy_first_tool',
        description: 'Returns the first legacy value.',
        parameters: z.object({}),
        needsApproval: true,
        execute: firstExecute,
      });
      const secondTool = tool({
        name: 'legacy_second_tool',
        description: 'Returns the second legacy value.',
        parameters: z.object({}),
        needsApproval: true,
        execute: secondExecute,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('legacy_first_tool', {}, { callId: 'legacy-first' }),
            functionCall('legacy_second_tool', {}, { callId: 'legacy-second' }),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Legacy partial approval agent',
        model,
        tools: [firstTool, secondTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'passing legacy output guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new AppendOnlySession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
        sessionInputCallback?: (
          history: AgentInputItem[],
          newItems: AgentInputItem[],
        ) => AgentInputItem[],
        reasoningItemIdPolicy?: 'preserve' | 'omit',
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, {
            session,
            sessionInputCallback,
            reasoningItemIdPolicy,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return run(agent, input, {
          session,
          sessionInputCallback,
          reasoningItemIdPolicy,
        });
      };

      const first = await runOnce('Use both legacy tools');
      first.state.approve(first.interruptions[0]);
      const partial = await runOnce(first.state);
      expect(firstExecute).toHaveBeenCalledTimes(1);
      expect(secondExecute).not.toHaveBeenCalled();

      partial.state._currentTurnPersistedItemCount = 1;
      partial.state.approve(partial.interruptions[0]);
      partial.state.setReasoningItemIdPolicy('preserve');
      const sessionBefore = structuredClone(await session.getItems());
      const modelCallCount = model.calls.length;
      const callback = vi.fn(
        (history: AgentInputItem[], newItems: AgentInputItem[]) => [
          ...history,
          ...newItems,
        ],
      );

      await expect(runOnce(partial.state, callback, 'omit')).rejects.toThrow(
        'persisted response ownership cannot be proven',
      );
      expect(firstExecute).toHaveBeenCalledTimes(1);
      expect(secondExecute).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(modelCallCount);
      expect(callback).not.toHaveBeenCalled();
      expect(await session.getItems()).toEqual(sessionBefore);
      expect(partial.state._reasoningItemIdPolicy).toBe('preserve');
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      (['pass', 'trip', 'error'] as const).map((verdict) => ({
        mode,
        verdict,
      })),
    ),
  )(
    'defers partial approval output until a $mode output guardrail $verdict verdict',
    async ({ mode, verdict }) => {
      const firstTool = tool({
        name: 'first_sensitive_tool',
        description: 'Returns the first sensitive value.',
        parameters: z.object({}),
        needsApproval: true,
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'first approved tool verdict',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'first approval tool guardrail secret',
              ),
          }),
        ],
        execute: async () => 'first partial approval secret',
      });
      const secondTool = tool({
        name: 'second_sensitive_tool',
        description: 'Returns the second sensitive value.',
        parameters: z.object({}),
        needsApproval: true,
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'approved terminal tool verdict',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.allow(
                'second approval tool guardrail secret',
              ),
          }),
        ],
        execute: async () => 'second approval secret',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('first_sensitive_tool', {}, { callId: 'first-call' }),
            functionCall(
              'second_sensitive_tool',
              {},
              { callId: 'second-call' },
            ),
            {
              type: 'hosted_tool_call',
              name: 'file_search_call',
              status: 'completed',
              providerData: {
                type: 'file_search_call',
                queries: ['sensitive query'],
                results: [{ text: 'hosted partial approval secret' }],
              },
            },
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Partial approval Session agent',
        model,
        tools: [firstTool, secondTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'blocking output guardrail',
            execute: async () => {
              if (verdict === 'error') {
                throw new Error('approval output guardrail failed');
              }
              return {
                outputInfo: undefined,
                tripwireTriggered: verdict === 'trip',
              };
            },
          },
        ],
      });
      const session = new MemorySession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return run(agent, input, { session });
      };

      const first = await runOnce('Use both tools');
      expect(first.interruptions).toHaveLength(2);
      first.state.approve(first.interruptions[0]);

      const partial = await runOnce(first.state);
      expect(partial.interruptions).toHaveLength(1);
      expect(partial.state.toString()).toContain(
        'first partial approval secret',
      );
      expect(JSON.stringify(await session.getItems())).not.toContain(
        'first partial approval secret',
      );
      expect(JSON.stringify(await session.getItems())).not.toContain(
        'hosted partial approval secret',
      );
      partial.state.approve(partial.interruptions[0]);

      if (verdict === 'pass') {
        const completed = await runOnce(partial.state);
        expect(completed.finalOutput).toBe('second approval secret');
        expect(
          completed.state._toolOutputGuardrailResults[0]?.output.outputInfo,
        ).toBe('first approval tool guardrail secret');
        expect(
          completed.state._toolOutputGuardrailResults.at(-1)?.output,
        ).toEqual({
          behavior: { type: 'allow' },
          outputInfo: 'second approval tool guardrail secret',
        });
        const acceptedHistory = JSON.stringify(await session.getItems());
        expect(acceptedHistory).toContain('first partial approval secret');
        expect(acceptedHistory).toContain('second approval secret');
        expect(acceptedHistory).toContain('hosted partial approval secret');
        expect(acceptedHistory).not.toContain(
          'Output withheld by an output guardrail.',
        );
        return;
      }

      if (verdict === 'error') {
        await expect(runOnce(partial.state)).rejects.toThrow(
          'approval output guardrail failed',
        );
        expect(
          partial.state._toolOutputGuardrailResults[0]?.output.outputInfo,
        ).toBe('first approval tool guardrail secret');
        expect(
          partial.state._toolOutputGuardrailResults.at(-1)?.output,
        ).toEqual({
          behavior: { type: 'allow' },
          outputInfo: 'second approval tool guardrail secret',
        });
        const completedHistory = JSON.stringify(await session.getItems());
        expect(completedHistory).toContain('first partial approval secret');
        expect(completedHistory).toContain('second approval secret');
        expect(completedHistory).toContain('hosted partial approval secret');
        return;
      }

      let tripwireError: OutputGuardrailTripwireTriggered<any> | undefined;
      try {
        await runOnce(partial.state);
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwireError = error as OutputGuardrailTripwireTriggered<any>;
      }
      expect(tripwireError).toBeDefined();
      const serializedState = tripwireError?.state?.toString() ?? '';
      expect(serializedState).not.toContain('first partial approval secret');
      expect(serializedState).not.toContain('second approval secret');
      expect(serializedState).not.toContain('hosted partial approval secret');
      expect(serializedState).not.toContain(
        'first approval tool guardrail secret',
      );
      expect(serializedState).not.toContain(
        'second approval tool guardrail secret',
      );
      expect(serializedState).toContain(
        'Output withheld by an output guardrail.',
      );
      expect(
        tripwireError?.state?._toolOutputGuardrailResults.at(-1)?.output,
      ).toEqual({
        behavior: { type: 'allow' },
        outputInfo: undefined,
      });
      const postTripHistory = JSON.stringify(await session.getItems());
      expect(postTripHistory).not.toContain('first partial approval secret');
      expect(postTripHistory).not.toContain('second approval secret');
      expect(postTripHistory).not.toContain('hosted partial approval secret');

      const replayModel = new ScriptedModel([
        modelResponse({
          output: [assistantMessage('safe continuation')],
          usage: new Usage(),
        }),
      ]);
      const replayAgent = new Agent({
        name: 'Partial approval replay agent',
        model: replayModel,
      });
      let callbackHistory = '';
      await run(replayAgent, 'Continue', {
        session,
        sessionInputCallback: (history, newItems) => {
          callbackHistory = JSON.stringify(history);
          return [...history, ...newItems];
        },
      });
      expect(callbackHistory).not.toContain('first partial approval secret');
      expect(callbackHistory).not.toContain('second approval secret');
      expect(callbackHistory).not.toContain('hosted partial approval secret');
      const replayInput = JSON.stringify(replayModel.calls[0]?.request.input);
      expect(replayInput).not.toContain('first partial approval secret');
      expect(replayInput).not.toContain('second approval secret');
      expect(replayInput).not.toContain('hosted partial approval secret');
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      (
        [
          'pass',
          'trip',
          'ambiguous',
          'namespace_mismatch',
          'session',
          'prior_tool_guardrail',
        ] as const
      ).map((verdict) => ({ mode, verdict })),
    ),
  )(
    'handles a serialized $mode partial approval with a $verdict outcome',
    async ({ mode, verdict }) => {
      const firstExecute = vi.fn(async () => 'accepted first approval output');
      const secondExecute = vi.fn(
        async () => 'accepted second approval output',
      );
      const firstTool = tool({
        name: 'portable_first_approval_tool',
        description: 'Returns an output after the first approval.',
        parameters: z.object({}),
        needsApproval: true,
        outputGuardrails:
          verdict === 'prior_tool_guardrail'
            ? [
                defineToolOutputGuardrail({
                  name: 'pre-serialization approval tool verdict',
                  run: async () =>
                    ToolGuardrailFunctionOutputFactory.allow(
                      'pre-serialization approval guardrail secret',
                    ),
                }),
              ]
            : [],
        execute: firstExecute,
      });
      const secondTool = tool({
        name: 'portable_second_approval_tool',
        description: 'Returns an output after the second approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: secondExecute,
      });
      const [namespacedFirstTool, namespacedSecondTool] = toolNamespace({
        name: 'crm',
        description: 'Namespaced approval tools.',
        tools: [firstTool, secondTool],
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'portable_first_approval_tool',
              {},
              { callId: 'portable-first-call', namespace: 'crm' },
            ),
            functionCall(
              'portable_second_approval_tool',
              {},
              { callId: 'portable-second-call', namespace: 'crm' },
            ),
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Portable serialized approval agent',
        model,
        tools: [namespacedFirstTool, namespacedSecondTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'passing portable approval guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: verdict === 'trip',
            }),
          },
        ],
      });
      const session = new AppendOnlySession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
        resumeSession?: Session,
      ) => {
        const options = resumeSession ? { session: resumeSession } : {};
        if (mode === 'streamed') {
          const result = await run(agent, input, { ...options, stream: true });
          await result.completed;
          return result;
        }
        return run(agent, input, options);
      };

      const first = await runOnce('Approve both portable tools.', session);
      first.state.approve(first.interruptions[0]!);
      const partial = await runOnce(first.state, session);
      expect(partial.state._currentTurnPersistedItemCount).toBeGreaterThan(0);
      const historicalSessionItems = await session.getItems();
      const restored = await RunState.fromString(
        agent,
        partial.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]!);

      if (verdict === 'ambiguous') {
        restored._lastTurnResponse?.output.reverse();
      }
      if (verdict === 'namespace_mismatch') {
        const responseCall = restored._lastTurnResponse?.output[0];
        if (responseCall?.type === 'function_call') {
          responseCall.namespace = 'billing';
        }
      }
      if (
        verdict === 'ambiguous' ||
        verdict === 'namespace_mismatch' ||
        verdict === 'session' ||
        verdict === 'prior_tool_guardrail'
      ) {
        await expect(
          runOnce(restored, verdict === 'session' ? session : undefined),
        ).rejects.toThrow('current-response provenance was not preserved');
        expect(secondExecute).not.toHaveBeenCalled();
        expect(model.calls).toHaveLength(1);
        expect(await session.getItems()).toEqual(historicalSessionItems);
        if (verdict === 'prior_tool_guardrail') {
          expect(
            restored._toolOutputGuardrailResults[0]?.output.outputInfo,
          ).toBe('pre-serialization approval guardrail secret');
        }
        return;
      }

      if (verdict === 'trip') {
        let tripwire: OutputGuardrailTripwireTriggered<any> | undefined;
        try {
          await runOnce(restored);
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          tripwire = error as OutputGuardrailTripwireTriggered<any>;
        }
        expect(tripwire).toBeDefined();
        expect(tripwire?.state?.toString()).not.toContain(
          'accepted first approval output',
        );
        expect(tripwire?.state?.toString()).not.toContain(
          'accepted second approval output',
        );
        expect(
          tripwire?.state?._generatedItems
            .filter(
              (item) =>
                'rawItem' in item &&
                (item.rawItem.type === 'function_call' ||
                  item.rawItem.type === 'function_call_result'),
            )
            .every(
              (item) =>
                'rawItem' in item &&
                'namespace' in item.rawItem &&
                item.rawItem.namespace === 'crm',
            ),
        ).toBe(true);
        expect(firstExecute).toHaveBeenCalledTimes(1);
        expect(secondExecute).toHaveBeenCalledTimes(1);
        expect(model.calls).toHaveLength(1);
        expect(restored._currentTurnPersistedItemCount).toBe(0);
        expect(await session.getItems()).toEqual(historicalSessionItems);
        return;
      }

      const completed = await runOnce(restored);

      expect(completed.finalOutput).toBe('accepted second approval output');
      expect(firstExecute).toHaveBeenCalledTimes(1);
      expect(secondExecute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(restored._currentTurnPersistedItemCount).toBe(0);
      expect(await session.getItems()).toEqual(historicalSessionItems);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'starts no $mode Session write when the approval output guardrail is actually cancelled',
    async (mode) => {
      let notifyGuardrailStarted!: () => void;
      const guardrailStarted = new Promise<void>((resolve) => {
        notifyGuardrailStarted = resolve;
      });
      const controller = new AbortController();
      const approvedTool = tool({
        name: 'cancelled_guardrail_approval_tool',
        description: 'Returns a terminal result before guardrail cancellation.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'cancelled approval guardrail secret',
      });
      const agent = new Agent({
        name: 'Cancelled approval guardrail agent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              functionCall(
                'cancelled_guardrail_approval_tool',
                {},
                { callId: 'cancelled-approval-guardrail-call' },
              ),
            ],
            usage: new Usage(),
          }),
        ]),
        tools: [approvedTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'wait for actual approval guardrail cancellation',
            execute: async () => {
              notifyGuardrailStarted();
              await new Promise<void>((_resolve, reject) => {
                controller.signal.addEventListener(
                  'abort',
                  () => reject(controller.signal.reason),
                  { once: true },
                );
              });
              return { outputInfo: undefined, tripwireTriggered: false };
            },
          },
        ],
      });
      const session = new MemorySession();
      const first = await run(agent, 'Approve the cancellable tool.', {
        session,
      });
      first.state.approve(first.interruptions[0]!);
      const checkpoint = await session.getItems();
      const addItems = vi.spyOn(session, 'addItems');

      if (mode === 'streamed') {
        const resumed = await run(agent, first.state, {
          session,
          signal: controller.signal,
          stream: true,
        });
        const completion = resumed.completed.catch((error: unknown) => error);
        await guardrailStarted;
        controller.abort(new Error('cancel an active output guardrail'));
        await completion;
      } else {
        const resumed = run(agent, first.state, {
          session,
          signal: controller.signal,
        });
        const completion = resumed.catch((error: unknown) => error);
        await guardrailStarted;
        controller.abort(new Error('cancel an active output guardrail'));
        await completion;
      }

      expect(addItems).not.toHaveBeenCalled();
      expect(await session.getItems()).toEqual(checkpoint);
      expect(JSON.stringify(checkpoint)).not.toContain(
        'cancelled approval guardrail secret',
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'retains a run_llm_again tool output when a later model output trips in $mode mode',
    async (mode) => {
      const sensitiveTool = tool({
        name: 'sensitive_tool',
        description: 'Returns a value for a later model turn.',
        parameters: z.object({}),
        execute: async () => 'tool output retained for the model',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            functionCall('sensitive_tool', {}, { callId: 'sensitive-call' }),
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [assistantMessage('blocked model output secret')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'Later model trip Session agent',
        model,
        tools: [sensitiveTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'blocking output guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'input', { session, stream: true });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(run(agent, 'input', { session })).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      }

      const stored = JSON.stringify(await session.getItems());
      expect(stored).toContain('tool output retained for the model');
      expect(stored).not.toContain('blocked model output secret');
      expect(stored).not.toContain('Output withheld by an output guardrail.');
    },
  );
});
