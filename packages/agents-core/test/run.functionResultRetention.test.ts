import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InvalidToolOutputError,
  ToolCallError,
  defineToolOutputGuardrail,
  ToolGuardrailFunctionOutputFactory,
  RunState,
  Runner,
  tool,
  toolNamespace,
} from '../src';
import logger from '../src/logger';
import { MemorySession } from '../src/memory/memorySession';
import type * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import { fakeModelMessage } from './stubs';
import { ScriptedModel, functionCall } from '../src/testing';
import { createResumableState } from './fixtures/runState';

describe('function result retention and publication after failure', () => {
  it.each(['extractor', 'end hook'] as const)(
    'recovers an approved result after a failing %s',
    async (failure) => {
      const receipt = { ticket: 'T-1' };
      const execute = vi.fn(async () => receipt);
      const callbackError = new Error('ticket callback failed');
      const customDataExtractor = vi.fn(() => {
        if (failure === 'extractor') {
          receipt.ticket = 'mutated';
          throw callbackError;
        }
        return { label: 'ticket' };
      });
      const ticket = tool({
        name: 'ticket',
        description: 'Creates a ticket.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
        customDataExtractor,
      });
      const followup = tool({
        name: 'followup',
        description: 'Records a separately approved follow-up.',
        parameters: z.object({}),
        needsApproval: true,
        execute: vi.fn(async () => 'follow-up recorded'),
      });
      const reasoning: protocol.ReasoningItem = {
        type: 'reasoning',
        content: [],
        providerData: { encrypted_content: 'approval-reasoning' },
      };
      const model = new ScriptedModel([
        {
          output: [
            reasoning,
            functionCall('followup', {}, { callId: 'followup-call' }),
            functionCall('ticket', {}, { callId: 'ticket-call' }),
          ],
          usage: new Usage(),
        },
        { output: [fakeModelMessage('done')], usage: new Usage() },
      ]);
      const agent = new Agent({
        name: 'tickets',
        model,
        tools: [ticket, followup],
      });
      const runner = new Runner({ tracingDisabled: true });
      const session = new MemorySession();
      const parked = await runner.run(agent, 'open a ticket', { session });
      parked.state.approve(parked.interruptions[1]);
      const end = vi.fn((_ctx, _agent, endedTool) => {
        if (endedTool.name === 'ticket' && failure === 'end hook')
          throw callbackError;
      });
      runner.on('agent_tool_end', end);
      await expect(
        runner.run(agent, parked.state, { session }),
      ).rejects.toMatchObject({
        error: callbackError,
      });

      const restored = await RunState.fromString(
        agent,
        parked.state.toString(),
      );
      expect(
        restored.history.filter((item) => item.type === 'reasoning'),
      ).toEqual([reasoning]);
      const pending = await runner.run(agent, restored, { session });
      expect(pending.interruptions.map((approval) => approval.name)).toEqual([
        'followup',
      ]);
      pending.state.approve(pending.interruptions[0]);
      const resumed = await runner.run(agent, pending.state, { session });
      expect(resumed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        end.mock.calls.filter(([, , endedTool]) => endedTool.name === 'ticket'),
      ).toHaveLength(1);
      expect(customDataExtractor).toHaveBeenCalledTimes(1);
      const outputs = resumed.newItems
        .filter((item) => item.type === 'tool_call_output_item')
        .filter((item) => item.rawItem.callId === 'ticket-call');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({
        output: { ticket: 'T-1' },
        executionStatus: 'executed',
      });
      expect(outputs[0].customData).toEqual(
        failure === 'extractor' ? undefined : { label: 'ticket' },
      );
      for (const history of [
        model.calls[1].request.input,
        await session.getItems(),
      ]) {
        expect(
          Array.isArray(history) &&
            history.filter((item) => item.type === 'reasoning'),
        ).toEqual([reasoning]);
        expect(history).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'ticket-call',
          }),
        );
        expect(
          Array.isArray(history) &&
            history
              .filter((item) => item.type === 'function_call_result')
              .map((item) => item.callId),
        ).toEqual(['ticket-call', 'followup-call']);
      }
    },
  );

  it('withholds a validated fallback derived from invalid output when a callback enables redaction', async () => {
    const sentinel = 'private failure detail';
    const policy = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(false);
    onTestFinished(() => policy.mockRestore());
    const execute = vi.fn(
      async () => sentinel as unknown as { message: string },
    );
    const service = tool({
      name: 'service',
      description: 'Returns a structured reply.',
      parameters: z.object({}),
      needsApproval: true,
      outputSchema: z.object({ message: z.string() }),
      execute,
      errorFunction: (_context, error) => {
        if (!(error instanceof InvalidToolOutputError)) throw error;
        return { message: String(error.toolOutput?.output) };
      },
      customDataExtractor: () => {
        policy.mockReturnValue(true);
        throw new Error('callback failed');
      },
    });
    const model = new ScriptedModel([
      {
        output: [functionCall(service.name, {}, { callId: 'service' })],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({ name: 'fallback', model, tools: [service] });
    const runner = new Runner({ tracingDisabled: true });
    const session = new MemorySession();
    const parked = await runner.run(agent, 'go', { session });
    parked.state.approve(parked.interruptions[0]);
    await expect(
      runner.run(agent, parked.state, { session }),
    ).rejects.toMatchObject({
      state: undefined,
      error: { message: 'callback failed' },
    });
    const saved = parked.state.toString();
    expect(saved).not.toContain(sentinel);
    expect(JSON.stringify(await session.getItems())).not.toContain(sentinel);
    await expect(
      runner.run(agent, await RunState.fromString(agent, saved), { session }),
    ).rejects.toThrow(/cannot be executed safely/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retains an approved receipt after a previously compacted approval', async () => {
    const execute = vi.fn(async () => 'second receipt');
    const receipt = (
      name: string,
      getReceipt: () => Promise<string>,
      fail: boolean,
    ) =>
      tool({
        name,
        description: 'Returns a receipt.',
        parameters: z.object({}),
        needsApproval: true,
        execute: getReceipt,
        customDataExtractor: () => {
          if (fail) throw new Error('second callback failed');
          return undefined;
        },
      });
    const first = receipt('first', async () => 'first receipt', false);
    const second = receipt('second', execute, true);
    const model = new ScriptedModel([
      {
        output: [
          functionCall('first', {}, { callId: 'first' }),
          functionCall('second', {}, { callId: 'second' }),
        ],
        usage: new Usage(),
      },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'sequential',
      model,
      tools: [first, second],
      toolUseBehavior: { stopAtToolNames: ['finish'] },
    });
    const runner = new Runner({ tracingDisabled: true });
    const session = new MemorySession();
    const parked = await runner.run(agent, 'go', { session });
    parked.state.approve(parked.interruptions[0]);
    const partial = await runner.run(agent, parked.state, { session });
    expect(
      (await session.getItems()).filter(
        (item) => item.type === 'function_call_result',
      ),
    ).toHaveLength(1);
    partial.state.approve(partial.interruptions[0]);
    await expect(runner.run(agent, partial.state, { session })).rejects.toThrow(
      'second callback failed',
    );
    const restored = await RunState.fromString(agent, partial.state.toString());
    expect((await runner.run(agent, restored, { session })).finalOutput).toBe(
      'done',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (await session.getItems())
        .filter((item) => item.type === 'function_call_result')
        .map((item) => item.callId),
    ).toEqual(['first', 'second']);
  });

  it('uses the original Session cursor after a tool result selector fails', async () => {
    const tools = ['approved', 'automatic'].map((name) =>
      tool({
        name,
        description: 'Returns a receipt.',
        parameters: z.object({}),
        needsApproval: name === 'approved',
        execute: async () => name,
      }),
    );
    const model = new ScriptedModel([
      {
        output: tools.map(({ name }) =>
          functionCall(name, {}, { callId: name }),
        ),
        usage: new Usage(),
      },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'selector',
      model,
      tools,
      toolUseBehavior: async () => {
        throw new Error('selector failed');
      },
    });
    const runner = new Runner({ tracingDisabled: true });
    const session = new MemorySession();
    const parked = await runner.run(agent, 'go', { session });
    parked.state.approve(parked.interruptions[0]);
    await expect(runner.run(agent, parked.state, { session })).rejects.toThrow(
      'selector failed',
    );
    const restored = await RunState.fromString(agent, parked.state.toString());
    agent.toolUseBehavior = 'run_llm_again';
    await runner.run(agent, restored, { session });
    expect(
      (await session.getItems())
        .filter((item) => item.type === 'function_call_result')
        .map((item) => item.callId),
    ).toEqual(['automatic', 'approved']);
  });

  it.each(['before acceptance', 'after acceptance'] as const)(
    'retains only accepted results when a sibling fails %s',
    async (order) => {
      let reachedBoundary!: () => void;
      const boundary = new Promise<void>((resolve) => {
        reachedBoundary = resolve;
      });
      let release!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        release = resolve;
      });
      const effects: string[] = [];
      const safe = tool({
        name: 'safe',
        description: 'Completes with a guarded receipt.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async (_args, _context, details) => {
          effects.push('safe');
          details?.signal?.addEventListener('abort', release, { once: true });
          return 'private unguarded receipt';
        },
        outputGuardrails: [
          defineToolOutputGuardrail({
            name: 'replace receipt',
            run: async () => {
              if (order === 'before acceptance') {
                reachedBoundary();
                await cancelled;
              }
              return ToolGuardrailFunctionOutputFactory.rejectContent(
                'accepted receipt',
              );
            },
          }),
        ],
        customDataExtractor: async () => {
          reachedBoundary();
          await cancelled;
          return { label: 'safe' };
        },
      });
      const primary = new Error('sibling failed after dispatch');
      const failing = tool({
        name: 'failing',
        description: 'Fails after dispatch.',
        parameters: z.object({}),
        needsApproval: true,
        errorFunction: null,
        execute: async () => {
          await boundary;
          effects.push('failing');
          throw primary;
        },
      });
      const queued = tool({
        name: 'queued',
        description: 'Remains queued.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => {
          effects.push('queued');
          return 'unexpected';
        },
      });
      const tools = [safe, failing, queued];
      const model = new ScriptedModel([
        {
          output: tools.map((entry) =>
            functionCall(entry.name, {}, { callId: entry.name }),
          ),
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({ name: 'batch', model, tools });
      const runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 2 },
      });
      const parked = await runner.run(agent, 'go');
      for (const approval of parked.interruptions)
        parked.state.approve(approval);
      const streamed = await runner.run(agent, parked.state, { stream: true });
      await expect(streamed.completed).rejects.toMatchObject({
        error: primary,
      });
      const saved = parked.state.toString();
      expect(JSON.parse(saved).$schemaVersion).toBe('1.23');
      expect(saved).not.toContain('private unguarded receipt');
      const restored = await RunState.fromString(agent, saved);
      const outputs = restored.history.filter(
        (item) => item.type === 'function_call_result',
      );
      expect(outputs.map((item) => item.callId)).toEqual(
        order === 'after acceptance' ? ['safe'] : [],
      );
      if (order === 'after acceptance')
        expect(outputs[0]).toMatchObject({
          output: { text: 'accepted receipt' },
        });
      await expect(runner.run(agent, parked.state)).rejects.toThrow(
        /cannot be executed safely/,
      );
      await expect(runner.run(agent, restored)).rejects.toThrow(
        /cannot be executed safely/,
      );
      expect(effects).toEqual(['safe', 'failing']);
      expect(model.calls).toHaveLength(1);
    },
  );

  it('replays encrypted reasoning with the accepted call after a metadata failure', async () => {
    const execute = vi.fn(async () => 'ticket opened');
    const failure = new Error('metadata unavailable');
    const ticket = tool({
      name: 'ticket',
      description: 'Opens a ticket.',
      parameters: z.object({}),
      execute,
      customDataExtractor: () => {
        throw failure;
      },
    });
    const pending = tool({
      name: 'pending',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: vi.fn(),
    });
    const reasoning: protocol.ReasoningItem = {
      type: 'reasoning',
      id: 'rs_ticket',
      content: [],
      providerData: { encrypted_content: 'opaque-ticket-reasoning' },
    };
    const call = functionCall(ticket.name, {}, { callId: 'open-ticket' });
    const model = new ScriptedModel([
      {
        output: [
          { ...reasoning, id: 'rs_commentary', providerData: {} },
          fakeModelMessage('uncommitted commentary'),
          reasoning,
          functionCall(pending.name, {}, { callId: 'pending-call' }),
          call,
          { ...reasoning, id: 'rs_later', providerData: {} },
          fakeModelMessage('uncommitted message'),
        ],
        usage: new Usage(),
      },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'tickets',
      model,
      tools: [pending, ticket],
    });
    const runner = new Runner({ tracingDisabled: true });
    const error = await runner
      .run(agent, 'open a ticket')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ error: failure });
    if (!(error instanceof ToolCallError) || !error.state)
      throw new Error('Expected a failed tool run with state.');

    const restored = await RunState.fromString(agent, error.state.toString());
    expect((await runner.run(agent, restored)).finalOutput).toBe('done');
    expect(model.calls[1].request.input).toEqual([
      expect.objectContaining({ role: 'user' }),
      reasoning,
      expect.objectContaining({
        type: 'function_call',
        callId: 'open-ticket',
        name: ticket.name,
      }),
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'open-ticket',
        output: { type: 'text', text: 'ticket opened' },
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retains the program and its completed function pair when a later worker fails', async () => {
    const execute = vi.fn(async () => 'first receipt');
    const first = tool({
      name: 'first',
      allowedCallers: ['programmatic'],
      description: 'Returns a receipt.',
      parameters: z.object({}),
      execute,
    });
    const failure = new Error('second worker failed');
    const second = tool({
      name: 'second',
      description: 'Fails.',
      parameters: z.object({}),
      errorFunction: null,
      execute: async () => {
        throw failure;
      },
    });
    const model = new ScriptedModel([
      {
        output: [
          {
            type: 'program',
            callId: 'program-1',
            code: 'await tools.first({})',
            fingerprint: 'program-fingerprint',
          },
          {
            ...functionCall('first', {}, { callId: 'first' }),
            caller: { type: 'program' as const, callerId: 'program-1' },
          },
          functionCall('second', {}, { callId: 'second' }),
        ],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'fresh',
      model,
      tools: [
        first,
        second,
        {
          type: 'hosted_tool',
          name: 'programmatic_tool_calling',
          providerData: { type: 'programmatic_tool_calling' },
        },
      ],
    });
    const runner = new Runner({
      tracingDisabled: true,
      toolExecution: { maxFunctionToolConcurrency: 1 },
    });
    const error = await runner
      .run(agent, 'go')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ error: failure });
    if (!(error instanceof ToolCallError) || !error.state)
      throw new Error('Expected a tool failure with run state.');
    const restored = await RunState.fromString(agent, error.state.toString());
    expect(restored.history.map((item) => item.type)).toEqual([
      'message',
      'program',
      'function_call',
      'function_call_result',
    ]);
    const outputs = restored.history.filter(
      (item) => item.type === 'function_call_result',
    );
    expect(outputs.map((item) => item.callId)).toEqual(['first']);
    expect(outputs[0]).toMatchObject({
      output: { type: 'text', text: 'first receipt' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['ticket', 'another_tool'])(
    'publishes a failed turn receipt only if the guarded named stop %s cannot select it',
    async (stopName) => {
      const execute = vi.fn(async () => 'unchecked ticket receipt');
      const ticket = tool({
        name: 'ticket',
        description: 'Creates a ticket.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
        customDataExtractor: () => {
          throw new Error('metadata unavailable');
        },
      });
      const model = new ScriptedModel([
        {
          output: [functionCall(ticket.name, {}, { callId: 'ticket' })],
          usage: new Usage(),
        },
        { output: [fakeModelMessage('done')], usage: new Usage() },
      ]);
      const agent = new Agent({
        name: 'guarded',
        model,
        tools: [ticket],
        toolUseBehavior: { stopAtToolNames: [stopName] },
      });
      const check = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: 'blocked',
      }));
      const runner = new Runner({
        tracingDisabled: true,
        outputGuardrails: [{ name: 'review receipt', execute: check }],
      });
      const session = stopName === 'ticket' ? new MemorySession() : undefined;
      const parked = await runner.run(agent, 'open ticket', { session });
      parked.state.approve(parked.interruptions[0]);
      await expect(
        runner.run(agent, parked.state, { session }),
      ).rejects.toThrow('metadata unavailable');
      const saved = parked.state.toString();
      const restored = await RunState.fromString(agent, saved);
      if (stopName === 'ticket') {
        expect(saved).not.toContain('unchecked ticket receipt');
        expect(JSON.stringify(await session?.getItems())).not.toContain(
          'unchecked ticket receipt',
        );
        await expect(runner.run(agent, restored, { session })).rejects.toThrow(
          /cannot be executed safely/,
        );
        expect(check).not.toHaveBeenCalled();
      } else {
        expect((await runner.run(agent, restored)).finalOutput).toBe('done');
        expect(
          restored.history.filter(
            (item) => item.type === 'function_call_result',
          ),
        ).toHaveLength(1);
      }
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'executed',
    'input guardrail replacement',
    'schema fallback',
  ] as const)(
    'retains a server-accepted %s result before a failing end hook',
    async (kind) => {
      if (kind === 'schema fallback') {
        const policy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(false);
        onTestFinished(() => policy.mockRestore());
      }
      const execute = vi.fn(async () => 'side effect completed');
      const sideEffectTool = tool({
        name: 'side_effect_tool',
        description: 'Runs once.',
        parameters: z.object({ count: z.number().optional() }).strict(),
        inputGuardrails:
          kind === 'input guardrail replacement'
            ? [
                {
                  name: 'deny action',
                  run: async () =>
                    ToolGuardrailFunctionOutputFactory.rejectContent(
                      'action denied',
                    ),
                },
              ]
            : [],
        errorFunction: () => 'action denied',
        execute,
      });
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: kind === 'executed' ? 'crm.side_effect_tool' : 'side_effect_tool',
        callId: 'side-effect-call',
        status: 'completed',
        arguments: kind === 'schema fallback' ? '{"count":"bad"}' : '{}',
      };
      const reasoning: protocol.ReasoningItem = {
        type: 'reasoning',
        content: [],
        providerData: { encrypted_content: 'server-reasoning' },
      };
      const commentary = {
        ...fakeModelMessage('Starting the action'),
        id: 'msg_before_action',
        phase: 'commentary' as const,
      };
      const compaction: protocol.CompactionItem = {
        type: 'compaction',
        id: 'compaction-before-action',
        encrypted_content: 'opaque-compaction',
      };
      const afterCall = {
        ...fakeModelMessage('Action requested'),
        id: 'msg_after_action',
      };
      const model = new ScriptedModel([
        {
          output: [compaction, commentary, reasoning, functionCall, afterCall],
          usage: new Usage(),
          responseId: 'accepted-2',
        },
        { output: [fakeModelMessage('done')], usage: new Usage() },
      ]);
      const agent = new Agent({
        name: 'tool-end-failure',
        model,
        tools:
          kind === 'executed'
            ? toolNamespace({
                name: 'crm',
                description: 'CRM tools.',
                tools: [sideEffectTool],
              })
            : [sideEffectTool],
      });
      const state = createResumableState(agent);
      state.setConversationContext('tool-end-conversation');
      state.addInput('accepted once');
      const runner = new Runner();
      let failEndHook = true;
      runner.on('agent_tool_end', () => {
        if (failEndHook) {
          failEndHook = false;
          throw new Error('tool end hook failed');
        }
      });

      await expect(
        runner.run(agent, state, {
          conversationId: 'tool-end-conversation',
        }),
      ).rejects.toThrow('tool end hook failed');
      expect(execute).toHaveBeenCalledTimes(kind === 'executed' ? 1 : 0);
      expect(
        state._generatedItems.filter(
          (item) =>
            item.type === 'tool_call_output_item' &&
            item.rawItem.callId === 'side-effect-call',
        ),
      ).toHaveLength(1);

      const restored = await RunState.fromString(agent, state.toString());
      expect(restored.history).not.toContainEqual(commentary);
      expect(restored.history).not.toContainEqual(compaction);
      expect(restored.history).not.toContainEqual(afterCall);
      const completed = await runner.run(agent, restored, {
        conversationId: 'tool-end-conversation',
      });
      expect(completed.finalOutput).toBe('done');
      expect(
        completed.history.filter(
          (item) =>
            item.type === 'compaction' ||
            (item.type === 'message' &&
              (item.id === commentary.id || item.id === afterCall.id)) ||
            ['reasoning', 'function_call', 'function_call_result'].includes(
              item.type ?? '',
            ),
        ),
      ).toEqual([
        compaction,
        commentary,
        reasoning,
        expect.objectContaining({
          type: 'function_call',
          callId: 'side-effect-call',
        }),
        afterCall,
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'side-effect-call',
        }),
      ]);
      expect(execute).toHaveBeenCalledTimes(kind === 'executed' ? 1 : 0);
      expect(model.calls).toHaveLength(2);
      expect(model.calls[1].request.input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          output: {
            type: 'text',
            text:
              kind === 'executed' ? 'side effect completed' : 'action denied',
          },
        }),
      ]);
    },
  );
});
