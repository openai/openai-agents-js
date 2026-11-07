import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  handoff,
  InputGuardrailTripwireTriggered,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunAgentUpdatedStreamEvent,
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunHooks,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  Runner,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type RunContext,
  type RunItem,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelError,
  modelResponse,
} from '@openai/agents-core/testing';
import { MigrationCleanupError, SDKRunner } from '../../src/migration';
import { Session } from '../../src/runtime/session';
import {
  NativeHandoffState,
  type AcceptedNativeHandoff,
} from '../../src/migration/handoff';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

type Context = { allowed: boolean };
const text = (value: string) => modelResponse([assistantMessage(value)]);
const call = (name: string, callId: string, args = '{}') =>
  modelResponse([functionCall(name, args, { callId })]);
const ordinaryTool = (name: string, execute: () => string) =>
  tool({
    name,
    description: `Execute ${name}.`,
    parameters: z.object({}),
    execute,
  });
function pair(model: ScriptedModel) {
  const source = new Agent<Context>({
    name: 'Root',
    instructions: 'Root instructions.',
    model,
  });
  const target = new Agent<Context>({
    name: 'Target',
    instructions: 'Target instructions.',
    model,
  });
  return { source, target };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('native active Agent handoff', () => {
  it('refuses another Model attempt after retry policy revokes captured tools', async () => {
    const failure = new Error('Retryable selected Model failure');
    const model = new ScriptedModel([
      modelError(failure, { replaySafety: 'safe' }),
      text('Must not dispatch after revocation.'),
    ]);
    const { source, target } = pair(model);
    const execute = vi.fn(() => 'must not execute');
    const onHandoff = vi.fn();
    source.tools = [ordinaryTool('root_action', execute)];
    source.handoffs = [handoff(target, { onHandoff })];
    const policy = vi.fn(() => {
      source.tools = [];
      return { retry: true, delayMs: 0 };
    });
    const outcome = await SDKRunner.run(source, 'Transfer.', {
      context: { allowed: true },
      modelSettings: { retry: { maxRetries: 1, policy } },
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    expect(model.calls).toHaveLength(1);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toContain(
      'captured handoff Agent configuration changed',
    );
    expect(outcome.value).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it.each(['Root', 'Target'] as const)(
    'refuses registered Agent tools on %s before native or handoff effects',
    async (owner) => {
      const model = new ScriptedModel([]);
      const { source, target } = pair(model);
      const nested = new Agent<Context>({
        name: 'Nested',
        instructions: 'Return a result.',
        model,
      });
      (owner === 'Root' ? source : target).tools = [
        nested.asTool({
          toolName: 'nested_agent',
          toolDescription: 'Ask the nested Agent.',
        }),
      ];
      const onHandoff = vi.fn();
      source.handoffs = [handoff(target, { onHandoff })];
      const nativeRun = vi.spyOn(Session.prototype, 'submit');
      await expect(
        SDKRunner.run(source, 'Transfer.', { context: { allowed: true } }),
      ).rejects.toThrow('handoffs with Agent tools are not yet supported');
      expect(nativeRun).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(0);
      expect(onHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(['Root', 'Target'] as const)(
    'refuses held approvals on %s before native work or handoff effects',
    async (owner) => {
      const model = new ScriptedModel([]);
      const { source, target } = pair(model);
      const execute = vi.fn(() => 'must not execute');
      const onHandoff = vi.fn();
      for (const agent of [source, target])
        agent.tools = [
          tool({
            name: `${agent.name.toLowerCase()}_action`,
            description: `Act for ${agent.name}.`,
            parameters: z.object({}),
            needsApproval: agent.name === owner,
            execute,
          }),
        ];
      source.handoffs = [handoff(target, { onHandoff })];
      const nativeRun = vi.spyOn(Session.prototype, 'submit');
      await expect(
        SDKRunner.run(source, 'Transfer.', {
          context: { allowed: true },
          approvals: 'manual',
        }),
      ).rejects.toThrow('handoffs with held approvals are not yet supported');
      expect(nativeRun).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      expect(onHandoff).not.toHaveBeenCalled();
    },
  );

  it('refuses unqualified Session storage before loading history or native work', async () => {
    const model = new ScriptedModel([]);
    const { source, target } = pair(model);
    const onHandoff = vi.fn();
    source.handoffs = [handoff(target, { onHandoff })];
    const store = new MemorySession();
    const read = vi.spyOn(store, 'getItems');
    const append = vi.spyOn(store, 'addItems');
    const nativeRun = vi.spyOn(Session.prototype, 'submit');
    await expect(
      SDKRunner.run(source, 'Transfer.', {
        context: { allowed: true },
        session: store,
      }),
    ).rejects.toThrow('handoffs with Session storage are not yet supported');
    expect(read).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(nativeRun).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it('refuses incomplete caller history before native or Model work', async () => {
    const input: AgentInputItem[] = [
      { type: 'message', role: 'user', content: 'Previous request.' },
      functionCall('unfinished_lookup', '{}', {
        callId: 'pending-history-call',
      }),
      { type: 'message', role: 'user', content: 'Transfer this request.' },
    ];
    const model = new ScriptedModel([]);
    const { source, target } = pair(model);
    const onHandoff = vi.fn();
    source.handoffs = [handoff(target, { onHandoff })];
    const nativeRun = vi.spyOn(Session.prototype, 'submit');
    await expect(
      SDKRunner.run(source, input, { context: { allowed: true } }),
    ).rejects.toThrow(
      'Migration requires completed text or inline-image history and complete function pairs',
    );
    expect(nativeRun).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it('snapshots filter-owned input for completed history exports', async () => {
    const message = {
      type: 'message' as const,
      role: 'user' as const,
      content: 'Filtered user request.',
    };
    const filtered: AgentInputItem[] = [message];
    const model = new ScriptedModel([
      call('transfer_to_Target', 'snapshot-filtered-input'),
      modelResponder(({ request }) => {
        expect(request.input).toContainEqual(message);
        return [assistantMessage('Target finished.')];
      }),
    ]);
    const { source, target } = pair(model);
    source.handoffs = [
      handoff(target, {
        inputFilter: (data) => ({ ...data, inputHistory: filtered }),
      }),
    ];
    const result = await SDKRunner.run(source, 'Original request.', {
      context: { allowed: true },
    });
    const expectedInput = structuredClone(filtered);
    const expectedHistory = result.history;
    message.content = 'Application changed its retained message.';
    filtered.push({ type: 'message', role: 'user', content: 'Later input.' });
    expect(result.input).toEqual(expectedInput);
    expect(result.history).toEqual(expectedHistory);
    expect(result.toInputList()).toEqual(expectedHistory);
    expect(result.lastAgent).toBe(target);
  });

  it.each(['held input guardrail', 'source tool-start hook'] as const)(
    'rechecks the active tool grant after a %s revokes it',
    async (boundary) => {
      const entered = deferred();
      const release = deferred();
      const execute = vi.fn(() => 'Revoked effect must not run.');
      const model = new ScriptedModel([
        call('root_work', `revoke-${boundary}`),
        text('Root fallback completion.'),
      ]);
      const { source, target } = pair(model);
      const parameters = z.object({});
      const guard = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return guardOutput.allow();
      });
      const rootTool = tool<typeof parameters, Context, string>({
        name: 'root_work',
        description: 'Execute only while granted.',
        parameters,
        execute,
        inputGuardrails:
          boundary === 'held input guardrail'
            ? [{ name: 'Held tool admission', run: guard }]
            : [],
      });
      source.tools = [rootTool];
      const onHandoff = vi.fn();
      source.handoffs = [handoff(target, { onHandoff })];
      const start = vi.fn(() => {
        source.tools = [];
      });
      if (boundary === 'source tool-start hook')
        source.on('agent_tool_start', start);
      const running = SDKRunner.run(source, 'Run the Root tool.', {
        context: { allowed: true },
      }).catch((error: unknown) => error);
      try {
        if (boundary === 'held input guardrail') {
          await entered.promise;
          source.tools = [];
          release.resolve();
        }
        const outcome = await running;
        expect(outcome).toBeInstanceOf(Error);
        expect(execute).not.toHaveBeenCalled();
        expect(onHandoff).not.toHaveBeenCalled();
        if (boundary === 'held input guardrail')
          expect(guard).toHaveBeenCalledOnce();
        else expect(start).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await running;
      }
    },
  );

  it.each(['distinct predicate error', 'same caller reason'] as const)(
    'joins cancelled enablement and preserves the %s in the public failure',
    async (failureKind) => {
      const entered = deferred();
      const release = deferred();
      const controller = new AbortController();
      const reason = new Error('Caller cancelled held enablement.');
      const predicateError =
        failureKind === 'same caller reason'
          ? reason
          : new Error('Independent enablement callback failure.');
      const model = new ScriptedModel([]);
      const { source, target } = pair(model);
      const completed = vi.fn();
      const predicate = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        completed();
        throw predicateError;
      });
      const onHandoff = vi.fn();
      source.handoffs = [handoff(target, { isEnabled: predicate, onHandoff })];
      let settled = false;
      const running = SDKRunner.run(source, 'Wait for enablement.', {
        context: { allowed: true },
        signal: controller.signal,
      }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await entered.promise;
        controller.abort(reason);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(completed).not.toHaveBeenCalled();
        expect(model.calls).toHaveLength(0);
        release.resolve();
        const outcome = await running;
        if (failureKind === 'same caller reason') {
          expect(outcome).toBe(reason);
        } else {
          expect(outcome).toBeInstanceOf(MigrationCleanupError);
          if (!(outcome instanceof MigrationCleanupError))
            throw new Error('Missing public cleanup failure.');
          expect(outcome.cause).toBe(reason);
          const errors = new Set<unknown>();
          const visit = (error: unknown) => {
            if (errors.has(error)) return;
            errors.add(error);
            if (error instanceof AggregateError)
              for (const nested of error.errors) visit(nested);
            if (error instanceof Error && error.cause !== undefined)
              visit(error.cause);
          };
          visit(outcome);
          expect(errors.has(predicateError)).toBe(true);
          expect(errors.has(reason)).toBe(true);
        }
        expect(predicate).toHaveBeenCalledOnce();
        expect(completed).toHaveBeenCalledOnce();
        expect(model.calls).toHaveLength(0);
        expect(onHandoff).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await running;
      }
    },
  );

  it('refuses the unqualified live-stream handoff family before native work', async () => {
    const model = new ScriptedModel([]);
    const { source, target } = pair(model);
    const onHandoff = vi.fn();
    source.handoffs = [handoff(target, { onHandoff })];
    const nativeRun = vi.spyOn(Session.prototype, 'submit');
    const streamed = await SDKRunner.stream(source, 'Transfer.', {
      context: { allowed: true },
    });
    await expect(streamed.completed).rejects.toThrow(
      'handoffs require the same explicit Model and response invocation',
    );
    expect(nativeRun).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it('keeps the acknowledged transition when the filter removes its presentation', async () => {
    const model = new ScriptedModel([
      call('transfer_to_Target', 'filtered-transfer'),
      modelResponder(({ request }) => {
        expect(JSON.stringify(request.input)).not.toContain(
          'filtered-transfer',
        );
        return [assistantMessage('Target finished.')];
      }),
    ]);
    const { source, target } = pair(model);
    let originalItems: RunItem[] = [];
    source.handoffs = [
      handoff(target, {
        inputFilter(data) {
          originalItems = [...data.newItems];
          return {
            ...data,
            inputHistory: 'Filtered request.',
            preHandoffItems: [],
            newItems: [],
          };
        },
      }),
    ];
    const transitions: {
      before: AcceptedNativeHandoff | undefined;
      after: AcceptedNativeHandoff | undefined;
      repeated: AcceptedNativeHandoff | undefined;
    }[] = [];
    const accept = NativeHandoffState.prototype.accepted;
    vi.spyOn(NativeHandoffState.prototype, 'accepted').mockImplementation(
      function (this: NativeHandoffState<Context>, ...args) {
        const before = this.acceptedTransition;
        accept.apply(this, args);
        transitions.push({
          before,
          after: this.acceptedTransition,
          repeated: this.acceptedTransition,
        });
      },
    );
    const result = await SDKRunner.run(source, 'Original request.', {
      context: { allowed: true },
    });
    expect(transitions).toHaveLength(1);
    const { before, after, repeated } = transitions[0]!;
    expect(before).toBeUndefined();
    expect(after).toBeDefined();
    expect(repeated).toBe(after);
    expect(after!.callId).toBe('filtered-transfer');
    expect(after!.responseIndex).toBe(0);
    expect(after!.prepared.outputItem).toBeInstanceOf(RunHandoffOutputItem);
    expect(after!.prepared.outputItem.sourceAgent).toBe(source);
    expect(after!.prepared.outputItem.targetAgent).toBe(target);
    expect(after!.prepared.commitItems).toHaveLength(2);
    after!.prepared.commitItems.forEach((item, index) => {
      expect(item).toBe(originalItems[index]);
    });
    expect(after!.prepared.outputItem).toBe(originalItems[1]);
    expect(result.newItems.map((item) => item.type)).toEqual([
      'message_output_item',
    ]);
    expect(result.lastAgent).toBe(target);
    expect(result.finalOutput).toBe('Target finished.');
    const events = await Array.fromAsync(result.replayEvents());
    expect(events.map((event) => event.type)).toEqual([
      'agent_updated_stream_event',
      'run_item_stream_event',
    ]);
    const [update, message] = events;
    expect(update).toBeInstanceOf(RunAgentUpdatedStreamEvent);
    if (
      update?.type !== 'agent_updated_stream_event' ||
      message?.type !== 'run_item_stream_event'
    )
      throw new Error('Missing filtered handoff replay.');
    expect(update.agent).toBe(target);
    expect(message.name).toBe('message_output_created');
    expect(message.item).toBe(result.newItems[0]);
  });

  it('transfers one real session through parsed handoff, filtered history and actual Target tools', async () => {
    const context = { allowed: true };
    const order: string[] = [];
    const parser = vi.fn();
    const rootEffect = vi.fn(() => 'ROOT_SECRET');
    const targetEffect = vi.fn(() => 'Target result.');
    const hooks = new RunHooks<Context>();
    let originalRunContext: RunContext<Context> | undefined;
    const model = new ScriptedModel([
      call('root_secret', 'root-secret'),
      call('transfer_to_Target', 'root-transfer', '{"reason":"billing"}'),
      modelResponder(({ request }) => {
        expect(request.systemInstructions).toBe('Target instructions.');
        expect(request.modelSettings.temperature).toBe(0.2);
        expect(request.tools.map((item) => item.name)).toEqual(['target_work']);
        expect(request.handoffs).toEqual([]);
        expect(JSON.stringify(request.input)).toContain(
          'Filtered user request.',
        );
        expect(JSON.stringify(request.input)).not.toContain('ROOT_SECRET');
        expect(JSON.stringify(request.input)).not.toContain('root-secret');
        expect(request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call',
            callId: 'root-transfer',
          }),
        );
        expect(request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'root-transfer',
          }),
        );
        return [functionCall('target_work', '{}', { callId: 'target-work' })];
      }),
      text('Target completed.'),
    ]);
    const source = new Agent<Context>({
      name: 'Root',
      instructions: 'Root instructions.',
      model,
      modelSettings: { temperature: 0.1 },
    });
    const target = new Agent<Context>({
      name: 'Target',
      instructions: 'Target instructions.',
      model,
      modelSettings: { temperature: 0.2 },
    });
    source.tools = [ordinaryTool('root_secret', rootEffect)];
    target.tools = [ordinaryTool('target_work', targetEffect)];
    source.on('agent_start', (current, agent) => {
      expect(agent).toBe(source);
      expect(current.context).toBe(context);
      originalRunContext = current;
      order.push('root-start');
    });
    target.on('agent_start', (current, agent) => {
      expect(current).toBe(originalRunContext);
      expect(agent).toBe(target);
      order.push('target-start');
    });
    hooks.on('agent_handoff', (current, from, to) => {
      expect(current).toBe(originalRunContext);
      expect(from).toBe(source);
      expect(to).toBe(target);
      order.push('runner-handoff');
    });
    source.on('agent_handoff', (current, to) => {
      expect(current).toBe(originalRunContext);
      expect(to).toBe(target);
      order.push('source-handoff');
    });
    source.handoffs = [
      handoff(target, {
        inputType: z.object({ reason: z.string() }).superRefine((value) => {
          parser(value.reason);
        }),
        onHandoff: (current, value) => {
          expect(current).toBe(originalRunContext);
          expect(value).toEqual({ reason: 'billing' });
          order.push('callback');
        },
        inputFilter: (input) => {
          expect(input.runContext).toBe(originalRunContext);
          order.push('filter');
          return {
            ...input,
            inputHistory: 'Filtered user request.',
            preHandoffItems: input.preHandoffItems.filter(
              (item) =>
                !(
                  'callId' in item.rawItem &&
                  item.rawItem.callId === 'root-secret'
                ),
            ),
          };
        },
      }),
    ];
    const run = vi.spyOn(Session.prototype, 'submit');
    const classic = vi.spyOn(Runner.prototype, 'run').mockImplementation(() => {
      throw new Error('Classic fallback must not execute.');
    });
    const result = await SDKRunner.run(source, 'Original user request.', {
      context,
      hooks,
      modelInvocation: 'response',
    });
    expect(run).toHaveBeenCalledOnce();
    const nativeOwner = run.mock.contexts[0];
    expect(nativeOwner).toBeInstanceOf(Session);
    if (!(nativeOwner instanceof Session))
      throw new Error('Missing real native Session owner.');
    expect(result.native.sessionId).toBe(nativeOwner.id);
    expect(result.native.turnId.length).toBeGreaterThan(0);
    expect(classic).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(4);
    expect(model.calls.every((entry) => !entry.streamed)).toBe(true);
    expect(rootEffect).toHaveBeenCalledOnce();
    expect(targetEffect).toHaveBeenCalledOnce();
    expect(parser).toHaveBeenCalledExactlyOnceWith('billing');
    expect(order).toEqual([
      'root-start',
      'callback',
      'runner-handoff',
      'source-handoff',
      'filter',
      'target-start',
    ]);
    expect(result.runContext).toBe(originalRunContext);
    expect(result.finalOutput).toBe('Target completed.');
    expect(result.lastAgent).toBe(target);
    expect(JSON.stringify(result.history)).not.toContain('ROOT_SECRET');
    expect(JSON.stringify(result.history)).not.toContain('root-secret');
    expect(JSON.stringify(result.rawResponses)).toContain('root-secret');
    const requested = result.newItems.find(
      (item) => item instanceof RunHandoffCallItem,
    );
    const accepted = result.newItems.find(
      (item) => item instanceof RunHandoffOutputItem,
    );
    expect(requested).toBeInstanceOf(RunHandoffCallItem);
    expect(accepted).toBeInstanceOf(RunHandoffOutputItem);
    if (
      !(requested instanceof RunHandoffCallItem) ||
      !(accepted instanceof RunHandoffOutputItem)
    )
      throw new Error('Missing genuine handoff items.');
    expect(requested.agent).toBe(source);
    expect(accepted.sourceAgent).toBe(source);
    expect(accepted.targetAgent).toBe(target);
    expect(accepted.rawItem.callId).toBe(requested.rawItem.callId);
    for (const item of result.newItems) {
      if (
        item instanceof RunToolCallItem ||
        item instanceof RunToolCallOutputItem ||
        item instanceof RunMessageOutputItem
      )
        expect(item.agent).toBe(target);
    }
    const events = await Array.fromAsync(result.replayEvents());
    expect(
      events.map((event) =>
        event.type === 'run_item_stream_event' ? event.name : event.type,
      ),
    ).toEqual([
      'handoff_requested',
      'handoff_occurred',
      'agent_updated_stream_event',
      'tool_called',
      'tool_output',
      'message_output_created',
    ]);
    const update = events[2];
    expect(update).toBeInstanceOf(RunAgentUpdatedStreamEvent);
    if (update?.type !== 'agent_updated_stream_event')
      throw new Error('Missing acknowledged target Agent update.');
    expect(update.agent).toBe(target);
    const itemEvents = events.filter(
      (event) => event.type === 'run_item_stream_event',
    );
    expect(itemEvents).toHaveLength(result.newItems.length);
    itemEvents.forEach((event, index) => {
      expect(event.item).toBe(result.newItems[index]);
    });
    expect(requested.rawItem.callId).toBe('root-transfer');
    const reader = result.replayEvents().getReader();
    for (const event of events) {
      expect(await reader.read()).toEqual({ done: false, value: event });
    }
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(rootEffect).toHaveBeenCalledOnce();
    expect(targetEffect).toHaveBeenCalledOnce();
  });

  it('refuses a Target-only tool while Root is active despite the captured union', async () => {
    const effect = vi.fn(() => 'unauthorized');
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.tools.map((item) => item.name)).toEqual(['root_work']);
        expect(request.handoffs.map((item) => item.toolName)).toEqual([
          'transfer_to_Target',
        ]);
        return [functionCall('target_work', '{}', { callId: 'wrong-agent' })];
      }),
    ]);
    const { source, target } = pair(model);
    source.tools = [ordinaryTool('root_work', () => 'root')];
    target.tools = [ordinaryTool('target_work', effect)];
    source.handoffs = [handoff(target)];
    await expect(
      SDKRunner.run(source, 'Try target tool.', { context: { allowed: true } }),
    ).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });

  it('refuses undeclared returns and callback authority changes without replaying earlier Root effects', async () => {
    for (const mode of ['undeclared', 'model'] as const) {
      const rootEffect = vi.fn(() => 'Root accepted.');
      const targetEffect = vi.fn(() => 'unauthorized');
      const model = new ScriptedModel([
        call('root_work', `${mode}-root`),
        call('transfer_to_Target', `${mode}-transfer`),
      ]);
      const { source, target } = pair(model);
      source.tools = [ordinaryTool('root_work', rootEffect)];
      target.tools = [ordinaryTool('target_work', targetEffect)];
      const other = new Agent<Context>({ name: target.name, model });
      const callback = vi.fn(() => {
        if (mode === 'model') target.model = new ScriptedModel([]);
        return mode === 'undeclared' ? other : target;
      });
      source.handoffs = [new Handoff(target, callback)];
      await expect(
        SDKRunner.run(source, 'Transfer.', { context: { allowed: true } }),
      ).rejects.toThrow();
      expect(rootEffect).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledOnce();
      expect(targetEffect).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(2);
    }
  });

  it('preserves a real filter failure after callback without starting Target work', async () => {
    const failure = new Error('application filter failed');
    const callback = vi.fn();
    const effect = vi.fn(() => 'unauthorized');
    const model = new ScriptedModel([
      call('transfer_to_Target', 'filter-transfer'),
    ]);
    const { source, target } = pair(model);
    target.tools = [ordinaryTool('target_work', effect)];
    source.handoffs = [
      handoff(target, {
        onHandoff: callback,
        inputFilter: () => {
          throw failure;
        },
      }),
    ];
    await expect(
      SDKRunner.run(source, 'Transfer.', { context: { allowed: true } }),
    ).rejects.toBe(failure);
    expect(callback).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });

  it('joins an entered callback on cancellation and never replays accepted source work', async () => {
    const entered = deferred();
    const release = deferred();
    const rootEffect = vi.fn(() => 'Root accepted.');
    const completed = vi.fn();
    const effect = vi.fn(() => 'unauthorized');
    const model = new ScriptedModel([
      call('root_work', 'cancel-root'),
      call('transfer_to_Target', 'cancel-transfer'),
    ]);
    const { source, target } = pair(model);
    source.tools = [ordinaryTool('root_work', rootEffect)];
    target.tools = [ordinaryTool('target_work', effect)];
    const callback = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      completed();
    });
    source.handoffs = [handoff(target, { onHandoff: callback })];
    const controller = new AbortController();
    const reason = new Error('caller cancelled handoff');
    let settled = false;
    const running = SDKRunner.run(source, 'Transfer.', {
      context: { allowed: true },
      signal: controller.signal,
    });
    const outcome = running.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    controller.abort(reason);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(completed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await outcome).toBe(reason);
    expect(callback).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
    expect(rootEffect).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(2);
  });

  it('runs Target output guards with actual identity and withholds unsafe output without rerunning input guards', async () => {
    const context = { allowed: true };
    const model = new ScriptedModel([
      call('transfer_to_Target', 'guard-transfer'),
      text('UNSAFE_TARGET_OUTPUT'),
    ]);
    const { source, target } = pair(model);
    const input = vi.fn(async () => ({
      tripwireTriggered: true,
      outputInfo: 'must not run',
    }));
    const output = vi.fn(
      async ({
        agent,
        context: current,
      }: {
        agent: Agent<Context>;
        context: RunContext<Context>;
      }) => {
        expect(agent).toBe(target);
        expect(current.context).toBe(context);
        return { tripwireTriggered: true, outputInfo: 'blocked' };
      },
    );
    target.inputGuardrails = [{ name: 'Target input', execute: input }];
    target.outputGuardrails = [{ name: 'Target output', execute: output }];
    source.handoffs = [handoff(target)];
    const outcome = await SDKRunner.run(source, 'Transfer.', { context }).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(OutputGuardrailTripwireTriggered);
    expect(outcome).not.toBeInstanceOf(InputGuardrailTripwireTriggered);
    expect(output).toHaveBeenCalledOnce();
    expect(input).not.toHaveBeenCalled();
    expect(outcome).not.toHaveProperty('finalOutput');
    expect(outcome).not.toHaveProperty('toStream');
  });

  it('reevaluates genuine enablement for each Root request after context revocation', async () => {
    const context = { allowed: true };
    let seenContext: RunContext<Context> | undefined;
    const callback = vi.fn();
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(request.handoffs.map((item) => item.toolName)).toEqual([
          'transfer_to_Target',
        ]);
        return [functionCall('revoke', '{}', { callId: 'revoke-root' })];
      }),
      modelResponder(({ request }) => {
        expect(request.handoffs).toEqual([]);
        expect(request.tools.map((item) => item.name)).toEqual(['revoke']);
        return [assistantMessage('Root completed after revocation.')];
      }),
    ]);
    const { source, target } = pair(model);
    const predicate = vi.fn(
      ({
        runContext,
        agent,
      }: {
        runContext: RunContext<Context>;
        agent: Agent<Context>;
      }) => {
        expect(agent).toBe(source);
        expect(runContext.context).toBe(context);
        if (seenContext) expect(runContext).toBe(seenContext);
        seenContext = runContext;
        return context.allowed;
      },
    );
    source.handoffs = [
      handoff(target, { isEnabled: predicate, onHandoff: callback }),
    ];
    source.tools = [
      tool({
        name: 'revoke',
        description: 'Revoke transfer.',
        parameters: z.object({}),
        execute: (_args, current) => {
          expect(current).toBe(seenContext);
          context.allowed = false;
          return 'Revoked.';
        },
      }),
    ];
    const result = await SDKRunner.run(source, 'Revoke transfer.', { context });
    expect(result.lastAgent).toBe(source);
    expect(result.finalOutput).toBe('Root completed after revocation.');
    expect(predicate).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(2);
  });

  it('refuses a mixed ordinary function and transfer batch before either callback effect', async () => {
    const rootEffect = vi.fn(() => 'must not execute');
    const callback = vi.fn();
    const model = new ScriptedModel([
      modelResponse([
        functionCall('root_work', '{}', { callId: 'mixed-root' }),
        functionCall('transfer_to_Target', '{}', { callId: 'mixed-transfer' }),
      ]),
    ]);
    const { source, target } = pair(model);
    source.tools = [ordinaryTool('root_work', rootEffect)];
    source.handoffs = [handoff(target, { onHandoff: callback })];
    await expect(
      SDKRunner.run(source, 'Mixed transfer.', { context: { allowed: true } }),
    ).rejects.toThrow();
    expect(rootEffect).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });
});
