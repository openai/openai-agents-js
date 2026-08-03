import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunState,
  Usage,
  run,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type OpenAIResponsesCompactionResult,
  type StreamEvent,
} from '../src';
import * as protocol from '../src/types/protocol';
import { fakeModelMessage } from './stubs';

type RunMode = 'non_streamed' | 'streamed';

class CompactionTrackingSession extends MemorySession {
  readonly compactionSnapshots: AgentInputItem[][] = [];

  async runCompaction(): Promise<OpenAIResponsesCompactionResult | null> {
    this.compactionSnapshots.push(await this.getItems());
    return null;
  }
}

class ApprovalSessionModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response found.');
    }
    return response;
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request);
    yield {
      type: 'response_done',
      response: {
        id: response.responseId ?? 'stream-response',
        output: response.output,
        usage: response.usage,
      },
    } as StreamEvent;
  }
}

function approvedToolCall(): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    id: 'approval-tool-call',
    callId: 'call-approved',
    name: 'approval_tool',
    status: 'completed',
    arguments: '{}',
    providerData: {},
  };
}

function getPersistedToolItems(items: AgentInputItem[]) {
  return items.filter(
    (
      item,
    ): item is protocol.FunctionCallItem | protocol.FunctionCallResultItem =>
      item.type === 'function_call' || item.type === 'function_call_result',
  );
}

describe('approved tool output guardrail session persistence', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it.each<{
    mode: RunMode;
    tripwire: boolean;
  }>([
    { mode: 'non_streamed', tripwire: false },
    { mode: 'non_streamed', tripwire: true },
    { mode: 'streamed', tripwire: false },
    { mode: 'streamed', tripwire: true },
  ])(
    'persists an approved tool result once when $mode guardrails trip=$tripwire',
    async ({ mode, tripwire }) => {
      let guardrailShouldTrip = tripwire;
      const approvalTool = tool({
        name: 'approval_tool',
        description: 'Returns a result after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [approvedToolCall()],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Approval session agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'approval output guardrail',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: guardrailShouldTrip,
            }),
          },
        ],
      });
      const session = new CompactionTrackingSession();

      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return await run(agent, input, { session });
      };

      const first = await runOnce('Use approval_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      if (tripwire) {
        await expect(runOnce(first.state)).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        const resumed = await runOnce(first.state);
        expect(resumed.finalOutput).toBe('approved-result');
      }

      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);
      const persistedToolItems = getPersistedToolItems(persistedItems);
      expect(
        persistedToolItems.map((item) => [item.type, item.callId]),
      ).toEqual([
        ['function_call', 'call-approved'],
        ['function_call_result', 'call-approved'],
      ]);
      expect(persistedToolItems[1]).toMatchObject({
        type: 'function_call_result',
        output: { type: 'text', text: 'approved-result' },
      });
      expect(session.compactionSnapshots).toHaveLength(tripwire ? 1 : 2);
      if (!tripwire) {
        expect(
          getPersistedToolItems(session.compactionSnapshots[1]).map((item) => [
            item.type,
            item.callId,
          ]),
        ).toEqual([
          ['function_call', 'call-approved'],
          ['function_call_result', 'call-approved'],
        ]);
      }

      if (tripwire) {
        guardrailShouldTrip = false;
        const next = await runOnce('Continue');
        expect(next.finalOutput).toBe('done');

        const replayedInput = model.requests.at(-1)?.input;
        expect(Array.isArray(replayedInput)).toBe(true);
        const replayedToolItems = getPersistedToolItems(
          replayedInput as AgentInputItem[],
        );
        expect(
          replayedToolItems.map((item) => [item.type, item.callId]),
        ).toEqual([
          ['function_call', 'call-approved'],
          ['function_call_result', 'call-approved'],
        ]);
        expect(replayedToolItems[1]).toMatchObject({
          type: 'function_call_result',
          output: { type: 'text', text: 'approved-result' },
        });
      }
    },
  );
});
