import { beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  Agent,
  handoff,
  MemorySession,
  Runner,
  RunState,
  setTracingDisabled,
  tool,
  UserError,
  type HandoffInputData,
} from '@openai/agents-core';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';
import { toolSearchTool } from '../src/tools';

const continuationCases = [
  { conversationId: 'conv_synthetic' },
  { previousResponseId: 'resp_synthetic_previous' },
];

function setup(options: {
  stream: boolean;
  filterScope?: 'handoff' | 'runner';
  identityFilter?: boolean;
  needsApproval?: boolean;
  customToolSearch?: boolean;
}) {
  const requests: Record<string, unknown>[] = [];
  const onHandoff = vi.fn();
  const execute = vi.fn(() => 'tool result');
  const searchExecute = vi.fn(async () => []);
  const inputFilter = vi.fn((input: HandoffInputData): HandoffInputData =>
    options.identityFilter
      ? input
      : { ...input, inputHistory: 'safe input', preHandoffItems: [] },
  );
  const client = new OpenAI({
    apiKey: 'test-key',
    // Intercept every request from the real Responses client; no network is used.
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      const output =
        requests.length === 1
          ? [
              ...(options.customToolSearch
                ? [
                    {
                      type: 'tool_search_call',
                      id: 'ts_search',
                      call_id: 'call_search',
                      execution: 'client',
                      status: 'completed',
                      arguments: { paths: [] },
                    },
                  ]
                : []),
              {
                type: 'function_call',
                id: 'fc_tool',
                call_id: 'call_tool',
                name: 'local_action',
                arguments: '{}',
                status: 'completed',
              },
              {
                type: 'function_call',
                id: 'fc_handoff',
                call_id: 'call_handoff',
                name: 'transfer_to_receiver',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'msg_done',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: 'done', annotations: [] },
                ],
              },
            ];
      const response = {
        id: `resp_synthetic_${requests.length}`,
        object: 'response',
        status: 'completed',
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const body = options.stream
        ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`
        : JSON.stringify(response);
      return new Response(body, {
        headers: {
          'content-type': options.stream
            ? 'text/event-stream'
            : 'application/json',
        },
      });
    },
  });
  const model = new OpenAIResponsesModel(client, 'gpt-test');
  const receiver = new Agent({
    name: 'receiver',
    instructions: 'Receiving agent',
    model,
  });
  const transfer = handoff(receiver, {
    onHandoff,
    ...(options.filterScope === 'handoff' ? { inputFilter } : {}),
  });
  const source = new Agent({
    name: 'source',
    instructions: 'Source agent',
    model,
    handoffs: [transfer],
    tools: [
      ...(options.customToolSearch
        ? [toolSearchTool({ execution: 'client', execute: searchExecute })]
        : []),
      tool({
        name: 'local_action',
        description: 'Perform a local action.',
        parameters: z.object({}),
        needsApproval: options.needsApproval,
        execute,
      }),
    ],
  });
  const runner = new Runner({
    tracingDisabled: true,
    ...(options.filterScope === 'runner'
      ? { handoffInputFilter: inputFilter }
      : {}),
  });
  return {
    source,
    receiver,
    transfer,
    runner,
    requests,
    onHandoff,
    inputFilter,
    execute,
    searchExecute,
  };
}

describe.each([false, true])(
  'handoff filter continuation (stream=%s)',
  (stream) => {
    beforeEach(() => setTracingDisabled(true));

    async function complete(
      runner: Runner,
      source: Agent,
      input: string | RunState<any, any>,
      options = {},
    ) {
      if (stream) {
        const result = await runner.run(source, input, {
          ...options,
          stream: true,
        });
        await result.completed;
        if (result.error) throw result.error;
        return result;
      }
      return runner.run(source, input, options);
    }

    for (const continuation of continuationCases) {
      const mode = Object.keys(continuation)[0];
      it.each(['handoff', 'runner'] as const)(
        `rejects ${mode} with a %s filter before side effects`,
        async (filterScope) => {
          const f = setup({ stream, filterScope });
          await expect(
            complete(
              f.runner,
              f.source,
              'synthetic private context',
              continuation,
            ),
          ).rejects.toThrow(UserError);
          expect(f.requests).toHaveLength(1);
          expect(f.requests[0]).toMatchObject(
            'conversationId' in continuation
              ? { conversation: continuation.conversationId }
              : { previous_response_id: continuation.previousResponseId },
          );
          expect(f.onHandoff).not.toHaveBeenCalled();
          expect(f.inputFilter).not.toHaveBeenCalled();
          expect(f.execute).not.toHaveBeenCalled();
        },
      );

      it.each(['handoff', 'runner'] as const)(
        `rejects ${mode} with a %s filter before custom tool search`,
        async (filterScope) => {
          const f = setup({ stream, filterScope, customToolSearch: true });
          await expect(
            complete(f.runner, f.source, 'context', continuation),
          ).rejects.toThrow(UserError);
          expect(f.searchExecute).not.toHaveBeenCalled();
          expect(f.execute).not.toHaveBeenCalled();
          expect(f.onHandoff).not.toHaveBeenCalled();
          expect(f.inputFilter).not.toHaveBeenCalled();
          expect(f.requests).toHaveLength(1);
        },
      );

      it(`preserves unfiltered handoffs with ${mode}`, async () => {
        const f = setup({ stream, customToolSearch: true });
        // An available but unselected filtered handoff must not block the selected handoff.
        f.source.handoffs.push(
          handoff(new Agent({ name: 'unused', model: f.receiver.model }), {
            inputFilter: f.inputFilter,
          }),
        );
        const result = await complete(
          f.runner,
          f.source,
          'context',
          continuation,
        );
        expect(result.finalOutput).toBe('done');
        expect(f.requests).toHaveLength(2);
        expect(f.requests[1]).toMatchObject({
          instructions: 'Receiving agent',
          ...('conversationId' in continuation
            ? { conversation: continuation.conversationId }
            : { previous_response_id: 'resp_synthetic_1' }),
        });
        expect(f.onHandoff).toHaveBeenCalledOnce();
        expect(f.inputFilter).not.toHaveBeenCalled();
        expect(f.searchExecute).toHaveBeenCalledOnce();
      });

      it(`rejects ${mode} after a real serialized approval interruption`, async () => {
        const f = setup({ stream, needsApproval: true });
        const paused = await complete(
          f.runner,
          f.source,
          'synthetic private context',
          continuation,
        );
        expect(paused.interruptions).toHaveLength(1);
        expect(f.onHandoff).not.toHaveBeenCalled();
        const restored = await RunState.fromString(
          f.source,
          paused.state.toString(),
        );
        restored.approve(restored.getInterruptions()[0]);
        // Runtime filters are rebound from current configuration, not serialized state.
        const runner = new Runner({
          tracingDisabled: true,
          handoffInputFilter: f.inputFilter,
        });
        await expect(complete(runner, f.source, restored)).rejects.toThrow(
          /client-managed history or a Session/,
        );
        expect(f.requests).toHaveLength(1);
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.onHandoff).not.toHaveBeenCalled();
        expect(f.inputFilter).not.toHaveBeenCalled();
      });
    }

    it('rejects identity filters without invoking them', async () => {
      const f = setup({ stream, filterScope: 'handoff', identityFilter: true });
      await expect(
        complete(f.runner, f.source, 'context', continuationCases[0]),
      ).rejects.toThrow(UserError);
      expect(f.inputFilter).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(1);
    });

    it.each(['handoff', 'runner'] as const)(
      'preserves client-managed session history with a %s filter',
      async (filterScope) => {
        const f = setup({ stream, filterScope, customToolSearch: true });
        const session = new MemorySession();
        const result = await complete(
          f.runner,
          f.source,
          'synthetic private context',
          { session },
        );
        expect(result.finalOutput).toBe('done');
        expect(f.requests).toHaveLength(2);
        const receiving = f.requests[1];
        expect(receiving.instructions).toBe('Receiving agent');
        expect(receiving.conversation).toBeUndefined();
        expect(receiving.previous_response_id).toBeUndefined();
        expect(JSON.stringify(receiving.input)).toContain('safe input');
        expect(JSON.stringify(receiving.input)).not.toContain(
          'synthetic private context',
        );
        expect(f.inputFilter).toHaveBeenCalledOnce();
        expect(f.onHandoff).toHaveBeenCalledOnce();
        expect(f.searchExecute).toHaveBeenCalledOnce();
      },
    );
  },
);
