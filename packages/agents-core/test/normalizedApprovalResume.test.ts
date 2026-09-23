import type { StandardSchemaWithJSON } from '../src';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Runner, RunState, ToolCallError, tool } from '../src';
import { ScriptedModel, modelResponse } from '../src/testing';

const call = (name: string, callId: string, args = '{}') => ({
  type: 'function_call' as const,
  name,
  callId,
  arguments: args,
});
const done = () =>
  modelResponse([
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'done' }],
    },
  ]);

describe('normalized approval resume ownership', () => {
  it('rejects a mutable instance nested in plain normalized input before approval', async () => {
    class Record {
      amount = 1;
    }
    const source = { record: new Record() };
    const needsApproval = vi.fn(async () => true);
    const execute = vi.fn(async () => 'executed');
    const agent = new Agent({
      name: 'Uncopyable',
      tools: [
        tool({
          name: 'uncopyable',
          description: 'Reject shared application objects.',
          parameters: z.object({}).transform(() => source),
          needsApproval,
          execute,
        }),
      ],
      model: new ScriptedModel([
        modelResponse([call('uncopyable', 'uncopyable-call')]),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const error = await runner
      .run(agent, 'start')
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).message).toContain(
      'requires copyable plain normalized input',
    );
    expect((error as ToolCallError).state?.getInterruptions()).toEqual([]);
    source.record.amount = 999;
    expect(needsApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['non-extensible', 'sealed', 'frozen'] as const)(
    'preserves %s normalized graphs through policy and approved execution',
    async (integrity) => {
      const protect = (value: object) => {
        if (integrity === 'frozen') Object.freeze(value);
        else if (integrity === 'sealed') Object.seal(value);
        else Object.preventExtensions(value);
      };
      const source = { values: [1], nested: { amount: 1 } };
      protect(source.values);
      protect(source.nested);
      protect(source);
      const inspect = (input: typeof source) => {
        expect(input).not.toBe(source);
        expect(input.values).not.toBe(source.values);
        for (const value of [input, input.values, input.nested]) {
          expect(Object.isExtensible(value)).toBe(false);
          expect(Object.isSealed(value)).toBe(integrity !== 'non-extensible');
          expect(Object.isFrozen(value)).toBe(integrity === 'frozen');
          expect(Reflect.defineProperty(value, 'extra', { value: 999 })).toBe(
            false,
          );
        }
      };
      const needsApproval = vi.fn(async (_context, input: typeof source) => {
        inspect(input);
        return true;
      });
      const execute = vi.fn(async (input: typeof source) => {
        inspect(input);
        return 'executed';
      });
      const agent = new Agent({
        name: 'Protected',
        tools: [
          tool({
            name: 'protected',
            description: 'Preserve normalized integrity.',
            parameters: z.object({}).transform(() => source),
            needsApproval,
            execute,
          }),
        ],
        model: new ScriptedModel([
          modelResponse([call('protected', 'protected-call')]),
          done(),
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      const pending = await runner.run(agent, 'start');
      pending.state.approve(pending.interruptions[0]);
      const result = await runner.run(agent, pending.state);
      expect(result.finalOutput).toBe('done');
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).not.toBe(needsApproval.mock.calls[0][1]);
    },
  );

  it('re-evaluates changed extensibility when the owning state rebuilds a tool', async () => {
    const execute = vi.fn(async (_input: { amount: number }) => 'executed');
    const needsApproval = vi.fn(
      async (_ctx, _input: { amount: number }) => true,
    );
    const makeTool = (extensible: boolean) =>
      tool({
        name: 'rebound',
        description: 'Compare normalized integrity.',
        parameters: z
          .object({})
          .transform(() =>
            extensible
              ? { amount: 1 }
              : Object.preventExtensions({ amount: 1 }),
          ),
        needsApproval,
        execute,
      });
    const approvedTool = makeTool(false);
    const agent = new Agent({
      name: 'Rebound',
      tools: [approvedTool],
      model: new ScriptedModel([
        modelResponse([call('rebound', 'rebound-call')]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const pending = await runner.run(agent, 'start');
    pending.state.approve(pending.interruptions[0]);
    approvedTool.invoke = makeTool(true).invoke;
    expect((await runner.run(agent, pending.state)).finalOutput).toBe('done');
    expect(needsApproval).toHaveBeenCalledTimes(2);
    expect(Object.isExtensible(needsApproval.mock.calls[0][1])).toBe(false);
    expect(Object.isExtensible(needsApproval.mock.calls[1][1])).toBe(true);
    expect(Object.isExtensible(execute.mock.calls[0][0])).toBe(true);
  });

  it.each(['automatic', 'manual'] as const)(
    'snapshots application-owned transform output before an async %s policy',
    async (decision) => {
      const source = { amount: 1 };
      let entered!: () => void;
      let release!: () => void;
      const policyEntered = new Promise<void>((resolve) => (entered = resolve));
      const policyGate = new Promise<void>((resolve) => (release = resolve));
      const needsApproval = vi.fn(
        async (_context, input: { amount: number }) => {
          expect(input.amount).toBe(1);
          entered();
          await policyGate;
          expect(input.amount).toBe(1);
          return decision === 'manual';
        },
      );
      const execute = vi.fn(async (input: { amount: number }) => input.amount);
      const approvedTool = tool({
        name: 'owned',
        description: 'Use application-owned normalized input.',
        parameters: z.object({}).transform(() => source),
        needsApproval,
        execute,
      });
      const agent = new Agent({
        name: 'Owned',
        tools: [approvedTool],
        model: new ScriptedModel([
          modelResponse([call('owned', 'owned-call')]),
          done(),
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      const running = runner.run(agent, 'start');
      await policyEntered;
      source.amount = 999;
      release();
      let result = await running;
      if (decision === 'manual') {
        result.state.approve(result.interruptions[0]);
        result = await runner.run(agent, result.state);
      }
      expect(result.finalOutput).toBe('done');
      expect(execute.mock.calls[0][0]).toEqual({ amount: 1 });
      expect(execute.mock.calls[0][0]).not.toBe(source);
      expect(needsApproval).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['required', 'automatic', 'throw', 'reject'] as const)(
    're-evaluates and binds restored input before honoring approval (%s)',
    async (decision) => {
      let source = { amount: 1 };
      let entered!: () => void;
      let release!: () => void;
      const policyEntered = new Promise<void>((resolve) => (entered = resolve));
      const policyGate = new Promise<void>((resolve) => (release = resolve));
      let evaluations = 0;
      const needsApproval = vi.fn(
        async (_context, input: { amount: number }) => {
          evaluations += 1;
          if (evaluations === 1) return true;
          expect(input.amount).toBe(2);
          entered();
          await policyGate;
          expect(input.amount).toBe(2);
          if (decision === 'throw') throw new Error('Current policy failed');
          return decision !== 'automatic';
        },
      );
      const execute = vi.fn(async (input: { amount: number }) => input.amount);
      const agent = new Agent({
        name: 'Durable',
        tools: [
          tool({
            name: 'durable',
            description: 'Bind restored normalized input.',
            parameters: z.object({}).transform(() => source),
            needsApproval,
            execute,
          }),
        ],
        model: new ScriptedModel([
          modelResponse([call('durable', 'durable-call')]),
          done(),
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      const pending = await runner.run(agent, 'start');
      const state = await RunState.fromString(agent, pending.state.toString());
      expect(needsApproval).toHaveBeenCalledTimes(1);
      // The documented long-wait flow approves the original interruption item.
      state.approve(pending.interruptions[0]);
      source = { amount: 2 };
      const running = runner.run(agent, state);
      await policyEntered;
      source.amount = 999;
      if (decision === 'reject') state.reject(pending.interruptions[0]);
      release();
      if (decision === 'throw') {
        await expect(running).rejects.toThrow('Current policy failed');
        expect(execute).not.toHaveBeenCalled();
      } else {
        const result = await running;
        expect(result.finalOutput).toBe('done');
        if (decision === 'reject') expect(execute).not.toHaveBeenCalled();
        else {
          expect(execute).toHaveBeenCalledTimes(1);
          expect(execute.mock.calls[0][0]).toEqual({ amount: 2 });
          expect(execute.mock.calls[0][0]).not.toBe(
            needsApproval.mock.calls[1][1],
          );
        }
      }
      expect(needsApproval).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['memory', 'serialized'] as const)(
    'preserves malformed JSON approval outcomes through %s resume',
    async (mode) => {
      for (const decision of ['approve', 'reject'] as const) {
        const needsApproval = vi.fn(async () => false);
        const execute = vi.fn(async () => 'must not execute');
        const malformed = tool({
          name: 'malformed',
          description: 'Handle invalid JSON.',
          parameters: z.object({}),
          needsApproval,
          execute,
        });
        const agent = new Agent({
          name: 'Malformed',
          tools: [malformed],
          model: new ScriptedModel([
            modelResponse([call('malformed', 'bad-json', '{')]),
            done(),
          ]),
        });
        const runner = new Runner({ tracingDisabled: true });
        const pending = await runner.run(agent, 'start');
        expect(pending.interruptions).toHaveLength(1);
        const state =
          mode === 'memory'
            ? pending.state
            : await RunState.fromString<undefined, typeof agent>(
                agent,
                pending.state.toString(),
              );
        state[decision](state.getInterruptions()[0]);
        const result = await runner.run(agent, state);
        expect(result.finalOutput).toBe('done');
        expect(JSON.stringify(result.history)).toContain(
          decision === 'approve' ? 'valid JSON' : 'not approved',
        );
        expect(needsApproval).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(state._pendingFunctionToolApprovals.size).toBe(0);
      }
    },
  );

  it.each(['zod', 'standard'] as const)(
    'persists no %s normalized data or verifier without Web Crypto',
    async (schema) => {
      const secret = '0420';
      const normalize = () => ({
        secret,
        expanded: 'private-record-'.repeat(20000),
      });
      const standard: StandardSchemaWithJSON<
        object,
        ReturnType<typeof normalize>
      > = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({ value: normalize() }),
          jsonSchema: {
            input: () => ({
              type: 'object',
              properties: {},
              additionalProperties: false,
            }),
            output: () => ({ type: 'object' }),
          },
        },
      };
      const execute = vi.fn(
        async (_input: ReturnType<typeof normalize>) => 'executed',
      );
      const enriched = tool({
        name: 'enriched',
        description: 'Resolve application-only data.',
        parameters:
          schema === 'zod' ? z.object({}).transform(normalize) : standard,
        needsApproval: async () => true,
        execute,
      });
      const agent = new Agent({
        name: 'Enriched',
        tools: [enriched],
        model: new ScriptedModel([
          modelResponse([call('enriched', 'enriched-call')]),
          done(),
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      vi.stubGlobal('crypto', undefined);
      let pending;
      try {
        pending = await runner.run(agent, 'start');
      } finally {
        vi.unstubAllGlobals();
      }
      const serialized = pending.state.toString();
      expect(serialized).not.toContain('sha256:');
      expect(serialized).not.toContain('private-record-');
      expect(serialized.length).toBeLessThan(20000);
      expect(pending.state.toJSON()).not.toHaveProperty(
        'pendingFunctionToolApprovals',
      );
      expect(pending.state.toJSON()).not.toHaveProperty('toolInput');
      const restored = await RunState.fromString(agent, serialized);
      restored.approve(restored.getInterruptions()[0]);
      expect((await runner.run(agent, restored)).finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toEqual(normalize());
    },
  );

  it('refuses restored manual approval for normalized arrays', async () => {
    let value = 1;
    const execute = vi.fn(async (_input: number[]) => 'executed');
    const needsApproval = vi.fn(async () => false);
    const arrayTool = tool({
      name: 'array',
      description: 'Normalize to an array.',
      parameters: z.object({}).transform(() => [value]),
      needsApproval,
      execute,
    });
    const agent = new Agent({
      name: 'Array',
      tools: [arrayTool],
      model: new ScriptedModel([
        modelResponse([call('array', 'array-call')]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const pending = await runner.run(agent, 'start');
    const restored = await RunState.fromString<undefined, typeof agent>(
      agent,
      pending.state.toString(),
    );
    restored.approve(restored.getInterruptions()[0]);
    value = 2;
    await expect(runner.run(agent, restored)).rejects.toThrow(
      'Cannot re-evaluate conditional approval',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(needsApproval).not.toHaveBeenCalled();
  });

  it('isolates nested inputBuilder mutation for plain normalized input', async () => {
    const seen: number[] = [];
    const normalize = vi.fn(() => ({ value: 1 }));
    const execute = vi.fn(async (_input, context) => context?.toolInput);
    const child = new Agent({
      name: 'Child',
      tools: [
        tool({
          name: 'secure',
          description: 'Request approval.',
          parameters: z.object({}),
          needsApproval: true,
          execute,
        }),
      ],
      model: new ScriptedModel([
        modelResponse([call('secure', 'inner')]),
        done(),
      ]),
    });
    const parent = new Agent({
      name: 'Parent',
      tools: [
        child.asTool({
          toolName: 'nested',
          toolDescription: 'Build child input.',
          parameters: z.object({}).transform(normalize),
          needsApproval: async () => true,
          inputBuilder: ({ params }) => {
            seen.push(params.value);
            params.value += 1;
            return 'start';
          },
        }),
      ],
      model: new ScriptedModel([
        modelResponse([call('nested', 'outer')]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    let pending = await runner.run(parent, 'start');
    pending.state.approve(pending.interruptions[0]);
    pending = await runner.run(parent, pending.state);
    pending.state.approve(pending.interruptions[0]);
    const result = await runner.run(parent, pending.state);
    expect(result.finalOutput).toBe('done');
    expect(seen).toEqual([1, 1]);
    expect(execute.mock.calls[0][1]?.toolInput).toEqual({ value: 2 });
    expect(normalize).toHaveBeenCalledTimes(1);
  });

  it('retains concurrent approvals in the owning state', async () => {
    let count = 0;
    const release: Array<() => void> = [];
    const gates = [0, 1].map(
      () => new Promise<void>((resolve) => release.push(resolve)),
    );
    const needsApproval = vi.fn(
      async (_context, input: { id: number; value: number }) => {
        await gates[input.id - 1];
        return true;
      },
    );
    const execute = vi.fn(
      async (input: { id: number; value: number }) => input.value,
    );
    const pendingTool = tool({
      name: 'parallel',
      description: 'Normalize independent calls.',
      parameters: z.object({ id: z.number() }).transform(({ id }) => {
        count += 1;
        return { id, value: count };
      }),
      needsApproval,
      execute,
    });
    const agent = new Agent({
      name: 'Concurrent',
      tools: [pendingTool],
      model: new ScriptedModel([
        modelResponse([
          call('parallel', 'first', '{"id":1}'),
          call('parallel', 'second', '{"id":2}'),
        ]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const running = runner.run(agent, 'start');
    await vi.waitFor(() => expect(needsApproval).toHaveBeenCalledTimes(2));
    release[0]();
    await setImmediate();
    release[1]();
    const pending = await running;
    expect(pending.interruptions).toHaveLength(2);
    expect(pending.state.toJSON()).not.toHaveProperty(
      'pendingFunctionToolApprovals',
    );
    const state = pending.state;
    for (const interruption of state.getInterruptions())
      state.approve(interruption);
    const resumed = await runner.run(agent, state);
    expect(resumed.finalOutput).toBe('done');
    expect(execute.mock.calls.map(([input]) => input)).toEqual([
      { id: 1, value: 1 },
      { id: 2, value: 2 },
    ]);
    expect(needsApproval).toHaveBeenCalledTimes(2);
    expect(count).toBe(2);
    expect(state._pendingFunctionToolApprovals.size).toBe(0);
  });

  it.each(['memory', 'serialized'] as const)(
    'retains parent approval during nested %s resume',
    async (mode) => {
      let count = 0;
      const execute = vi.fn(async (_input, context) => context?.toolInput);
      const childPolicy = vi.fn(async () => true);
      const childTool = tool({
        name: 'secure',
        description: 'Request child approval.',
        parameters: z.object({}),
        needsApproval: childPolicy,
        execute,
      });
      const child = new Agent({
        name: 'Child',
        tools: [childTool],
        model: new ScriptedModel([
          modelResponse([call('secure', 'inner')]),
          done(),
        ]),
      });
      const needsApproval = vi.fn(
        async (_context, input: { value: number }) => {
          expect(input.value).toBe(1);
          return true;
        },
      );
      const nested = child.asTool({
        toolName: 'nested',
        toolDescription: 'Run the child with normalized input.',
        parameters: z.object({}).transform(() => {
          count += 1;
          return { value: mode === 'serialized' ? 1 : count };
        }),
        needsApproval,
        inputBuilder: () => 'start',
      });
      const agent = new Agent({
        name: 'Parent',
        tools: [nested],
        model: new ScriptedModel([
          modelResponse([call('nested', 'outer')]),
          done(),
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      let pending = await runner.run(agent, 'start');
      pending.state.approve(pending.interruptions[0]);
      pending = await runner.run(agent, pending.state);
      expect(pending.interruptions).toHaveLength(1);
      expect(pending.interruptions[0].agent.name).toBe('Child');
      const state =
        mode === 'memory'
          ? pending.state
          : await RunState.fromString<undefined, typeof agent>(
              agent,
              pending.state.toString(),
            );
      state.approve(state.getInterruptions()[0]);
      const result = await runner.run(agent, state);
      expect(result.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]?.toolInput).toEqual({ value: 1 });
      expect(state._pendingFunctionToolApprovals.size).toBe(0);
      expect(needsApproval).toHaveBeenCalledTimes(mode === 'memory' ? 1 : 2);
      expect(childPolicy).toHaveBeenCalledTimes(2);
      expect(count).toBe(mode === 'memory' ? 1 : 2);
    },
  );

  it('keeps thrown-tool error states serializable without orphaned approval records', async () => {
    const failing = tool({
      name: 'failing',
      description: 'Fail without recovery.',
      parameters: z.object({}),
      needsApproval: async () => false,
      errorFunction: null,
      execute: async () => {
        throw new Error('transient failure');
      },
    });
    const agent = new Agent({
      name: 'Failure',
      tools: [failing],
      model: new ScriptedModel([modelResponse([call('failing', 'failed')])]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const error = await runner
      .run(agent, 'start')
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolCallError);
    const state = (error as ToolCallError).state!;
    expect(state._pendingFunctionToolApprovals.size).toBe(0);
    await expect(
      RunState.fromString<undefined, typeof agent>(agent, state.toString()),
    ).resolves.toBeInstanceOf(RunState);
  });

  it('retains symbol-keyed approval input only in memory', async () => {
    const key = Symbol('local');
    const execute = vi.fn(async () => 'executed');
    const symbolic = tool({
      name: 'symbolic',
      description: 'Use process-local normalized data.',
      parameters: z.object({}).transform(() => ({ [key]: 1 })),
      needsApproval: async () => true,
      execute,
    });
    const agent = new Agent({
      name: 'Symbolic',
      tools: [symbolic],
      model: new ScriptedModel([
        modelResponse([call('symbolic', 'symbol')]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const pending = await runner.run(agent, 'start');
    expect(pending.state.toJSON()).not.toHaveProperty(
      'pendingFunctionToolApprovals',
    );
    pending.state.approve(pending.interruptions[0]);
    await runner.run(agent, pending.state);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('resumes nested approval with retained symbol-keyed input', async () => {
    const key = Symbol('local');
    const normalize = vi.fn(() => ({ [key]: 1 }));
    const execute = vi.fn(async () => 'executed');
    const child = new Agent({
      name: 'Child',
      tools: [
        tool({
          name: 'secure',
          description: 'Request child approval.',
          parameters: z.object({}),
          needsApproval: true,
          execute,
        }),
      ],
      model: new ScriptedModel([
        modelResponse([call('secure', 'inner')]),
        done(),
      ]),
    });
    const needsApproval = vi.fn(async (_context, input) => {
      expect(input[key]).toBe(1);
      return true;
    });
    const parent = new Agent({
      name: 'Parent',
      tools: [
        child.asTool({
          toolName: 'nested',
          toolDescription: 'Use process-local normalized input.',
          parameters: z.object({}).transform(normalize),
          needsApproval,
          inputBuilder: () => 'start',
        }),
      ],
      model: new ScriptedModel([
        modelResponse([call('nested', 'outer')]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    let pending = await runner.run(parent, 'start');
    pending.state.approve(pending.interruptions[0]);
    pending = await runner.run(parent, pending.state);
    expect(pending.interruptions[0].agent).toBe(child);
    pending.state.approve(pending.interruptions[0]);
    const resumed = await runner.run(parent, pending.state);
    expect(resumed.finalOutput).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(needsApproval).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates current normalized input on legacy approval resume', async () => {
    let normalizedValue = 1;
    const execute = vi.fn(async () => 'executed');
    const needsApproval = vi.fn(async (_context, input: { value: number }) => {
      expect(input.value).toBe(normalizedValue);
      return true;
    });
    const parameters: StandardSchemaWithJSON<
      { value: number },
      { value: number }
    > = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => ({ value: { value: normalizedValue } }),
        jsonSchema: {
          input: () => ({
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
            additionalProperties: false,
          }),
          output: () => ({ type: 'object' }),
        },
      },
    };
    const legacy = tool({
      name: 'legacy',
      description: 'Normalize independently of raw input.',
      parameters,
      needsApproval,
      execute,
    });
    const agent = new Agent({
      name: 'Legacy',
      tools: [legacy],
      model: new ScriptedModel([
        modelResponse([call('legacy', 'legacy-call', '{"value":2}')]),
        done(),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const pending = await runner.run(agent, 'start');
    const json = JSON.parse(pending.state.toString());
    json.$schemaVersion = '1.19';
    delete json.currentResponseGeneratedItemOwnership;
    const state = await RunState.fromString<undefined, typeof agent>(
      agent,
      JSON.stringify(json),
    );
    state.approve(state.getInterruptions()[0]);
    normalizedValue = 2;
    expect((await runner.run(agent, state)).finalOutput).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(needsApproval).toHaveBeenCalledTimes(2);
    expect(needsApproval.mock.calls[1][1]).toEqual({ value: 2 });
  });
});
