import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RunState, CURRENT_SCHEMA_VERSION } from '../src/runState';
import { RunContext } from '../src/runContext';
import { Agent } from '../src/agent';
import { handoff } from '../src/handoff';
import { Usage } from '../src/usage';
import {
  RunToolApprovalItem as ToolApprovalItem,
  RunCompactionItem,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../src/items';
import { hostedMcpTool, tool, toolNamespace } from '../src/tool';
import * as protocol from '../src/types/protocol';
import { TEST_MODEL_MESSAGE } from './stubs';
import { RunResult } from '../src/result';
import { prepareModelInputItems } from '../src/runner/items';
import { processModelResponse } from '../src/runner/modelOutputs';
import { MemorySession } from '../src/memory/memorySession';
import {
  prepareInputItemsWithSession,
  saveToSession,
} from '../src/runner/sessionPersistence';

export function registerRunStateCompactionTests(): void {
  describe('RunState', () => {
    describe('compaction items', () => {
      const compactionItem: protocol.CompactionItem = {
        type: 'compaction',
        id: 'cmp_1',
        encrypted_content: 'ciphertext',
        created_by: 'compaction_endpoint',
        providerData: {
          created_by: 'third-party-provider',
          extra: 'value',
        },
      };
      const replayedCompactionItem: protocol.CompactionItem = {
        type: 'compaction',
        id: 'cmp_1',
        encrypted_content: 'ciphertext',
        providerData: {
          created_by: 'third-party-provider',
          extra: 'value',
        },
      };

      function stateWithCompaction(agent: Agent<any, any>) {
        const state = new RunState(new RunContext(), 'input', agent, 1);
        state._generatedItems.push(
          new RunCompactionItem(compactionItem, agent),
        );
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

      it('round-trips filtered current-schema history without the raw compaction wrapper', async () => {
        const agent = new Agent({ name: 'FilteredCompactionStateAgent' });
        const serialized = stateWithCompaction(agent).toJSON() as any;
        serialized.generatedItems = [];

        const restored = await RunState.fromString(
          agent,
          JSON.stringify(serialized),
        );

        expect(restored._generatedItems).toEqual([]);
        expect(restored._modelResponses[0]?.output[0]).toEqual(compactionItem);
      });

      it('round-trips a filtered replacement compaction as authoritative history', async () => {
        const agent = new Agent({ name: 'ReplacedCompactionStateAgent' });
        const replacementCompaction = {
          ...compactionItem,
          id: 'cmp_replacement',
          encrypted_content: 'replacement-ciphertext',
        };
        const serialized = stateWithCompaction(agent).toJSON() as any;
        serialized.generatedItems = [
          new RunCompactionItem(replacementCompaction, agent).toJSON(),
        ];

        const restored = await RunState.fromString(
          agent,
          JSON.stringify(serialized),
        );

        expect(restored._generatedItems).toHaveLength(1);
        expect(restored._generatedItems[0]?.rawItem).toEqual(
          replacementCompaction,
        );
        expect(restored._modelResponses[0]?.output[0]).toEqual(compactionItem);
      });

      it('resumes an approval after a handoff filter removes compaction history', async () => {
        const approvalTool = tool({
          name: 'filtered_compaction_approval',
          description: 'Requires approval after a filtered handoff.',
          parameters: z.object({}),
          needsApproval: true,
          execute: async () => 'approved',
        });
        const targetAgent = new Agent({
          name: 'FilteredCompactionTarget',
          tools: [approvalTool],
        });
        const transfer = handoff(targetAgent, {
          inputFilter: (data) => ({
            ...data,
            newItems: data.newItems.filter(
              (item) => !(item instanceof RunCompactionItem),
            ),
          }),
        });
        const sourceAgent = new Agent({
          name: 'FilteredCompactionSource',
          handoffs: [transfer],
        });
        const handoffCall: protocol.FunctionCallItem = {
          type: 'function_call',
          name: transfer.toolName,
          callId: 'call_filtered_compaction_handoff',
          arguments: '{}',
          status: 'completed',
        };
        const approvalCall: protocol.FunctionCallItem = {
          type: 'function_call',
          name: approvalTool.name,
          callId: 'call_after_filtered_compaction',
          arguments: '{}',
          status: 'completed',
        };
        const handoffResponse = {
          usage: new Usage(),
          output: [compactionItem, handoffCall],
          responseId: 'response-filtered-compaction-handoff',
        };
        const approvalResponse = {
          usage: new Usage(),
          output: [approvalCall],
          responseId: 'response-after-filtered-compaction',
        };
        const latestProcessed = processModelResponse(
          approvalResponse,
          targetAgent,
          [approvalTool],
          [],
        );
        const approvalItem = new ToolApprovalItem(approvalCall, targetAgent);
        const state = new RunState(new RunContext(), 'input', sourceAgent, 2);
        state._currentAgent = targetAgent;
        state._modelResponses = [handoffResponse, approvalResponse];
        state._lastTurnResponse = approvalResponse;
        state._generatedItems = [...latestProcessed.newItems, approvalItem];
        state._lastProcessedResponse = latestProcessed;
        state._currentStep = {
          type: 'next_step_interruption',
          data: { interruptions: [approvalItem] },
        };

        const restored = await RunState.fromString(
          sourceAgent,
          state.toString(),
        );

        expect(
          restored._generatedItems.some(
            (item) => item instanceof RunCompactionItem,
          ),
        ).toBe(false);
        expect(restored._modelResponses[0]?.output[0]).toEqual(compactionItem);
        expect(restored.getInterruptions()).toHaveLength(1);
        expect(restored._currentAgent).toBe(targetAgent);
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
          expect(restored._modelResponses[0]?.output[0]).toEqual(
            compactionItem,
          );
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
        const laterProcessed = processModelResponse(
          laterResponse,
          agent,
          [],
          [],
        );
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
        const secondTarget = new Agent({
          name: 'SecondHistoricalHandoffTarget',
        });
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
        const laterProcessed = processModelResponse(
          laterResponse,
          agent,
          [],
          [],
        );
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
          const agent = new Agent({
            name: `MissingFunctionWrapper-${position}`,
          });
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
            state._modelResponses = [
              responseWithMissingWrapper,
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
          restored._pendingLegacyCompactionSessionItems?.map(
            (item) => item.type,
          ),
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
        const prepared = await prepareInputItemsWithSession(
          'continue',
          session,
        );
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
        expect(
          (restored._generatedItems[1] as RunMessageOutputItem).agent,
        ).toBe(sourceAgent);
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
        expect(restored.history[0]).toEqual(replayedCompactionItem);
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
        expect(restored.history[0]).toEqual(replayedCompactionItem);
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
        expect(restored.history[0]).toEqual(replayedCompactionItem);
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
        const laterProcessed = processModelResponse(
          laterResponse,
          agent,
          [],
          [],
        );
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
          const laterMessageItem = new RunMessageOutputItem(
            laterMessage,
            agent,
          );
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
          const serializedLocalResult = serialized.generatedItems.at(-1);
          if (typeof serializedLocalResult.output !== 'string') {
            serializedLocalResult.output = JSON.stringify(
              serializedLocalResult.output,
            );
          }

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
        const duplicatedItem = new RunMessageOutputItem(
          duplicatedMessage,
          agent,
        );
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
        const callItem = new RunToolSearchCallItem(
          toolSearchCall as any,
          agent,
        );
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
        const agent = new Agent({
          name: 'HistoricalToolSearchCompactionAgent',
        });
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
        const callItem = new RunToolSearchCallItem(
          toolSearchCall as any,
          agent,
        );
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
  });
}
