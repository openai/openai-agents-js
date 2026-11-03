import { inspect } from 'node:util';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  allowExecutorCall,
  readExecutorPolicyDecision,
  replaceExecutorArguments,
  stopExecutorTurn,
  type ExecutorPolicyDecision,
} from '../../src/runtime/executor-decisions';
import {
  Environment,
  type EnvironmentOptions,
} from '../../src/runtime/environment';
import { applyExecutorPolicy } from '../../src/runtime/executor-policy';
import type { JsonObject, JsonValue } from '../../src/runtime/binding';
import type { Session } from '../../src/runtime/session';
import type { Agent } from '../../src/runtime/public-agent';

describe('executor decision authority', () => {
  it('recognizes only issued decisions', () => {
    const allow = allowExecutorCall();
    const stop = stopExecutorTurn();
    expect(readExecutorPolicyDecision(allow)).toEqual({ kind: 'allow' });
    expect(readExecutorPolicyDecision(stop)).toEqual({ kind: 'stop' });
    for (const value of [
      { action: 'stop' },
      { action: 'allow' },
      { action: 'replace', value: {} },
      { kind: 'stop' },
      { ...stop },
      JSON.parse(JSON.stringify(stop)),
      Object.create(stop),
      null,
      undefined,
      1,
      'stop',
    ]) {
      expect(readExecutorPolicyDecision(value)).toBeUndefined();
    }
  });

  it('does not inspect arbitrary objects to recognize authority', () => {
    const uninspectable = new Proxy(
      {},
      {
        get() {
          throw new Error('Property inspected');
        },
        getPrototypeOf() {
          throw new Error('Prototype inspected');
        },
        ownKeys() {
          throw new Error('Keys inspected');
        },
      },
    );
    expect(readExecutorPolicyDecision(uninspectable)).toBeUndefined();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(readExecutorPolicyDecision(proxy)).toBeUndefined();
  });

  it('keeps raw top-level and nested action fields as replacement data', () => {
    const value = { action: 'stop', nested: { action: 'allow' } };
    expect(readExecutorPolicyDecision(value)).toBeUndefined();
    expect(readExecutorPolicyDecision(replaceExecutorArguments(value))).toEqual(
      {
        kind: 'replace',
        value,
      },
    );
  });

  it('copies replacement arguments at issuance and on each read', () => {
    const value = { cmd: 'original', nested: { action: 'stop' } };
    const decision = replaceExecutorArguments(value);
    value.cmd = 'changed';
    value.nested.action = 'changed';
    const first = readExecutorPolicyDecision(decision);
    expect(first).toEqual({
      kind: 'replace',
      value: {
        cmd: 'original',
        nested: { action: 'stop' },
      },
    });
    if (first?.kind !== 'replace') throw new Error('Missing replacement');
    (first.value as { cmd: string }).cmd = 'changed again';
    expect(readExecutorPolicyDecision(decision)).toEqual({
      kind: 'replace',
      value: {
        cmd: 'original',
        nested: { action: 'stop' },
      },
    });
  });

  it('retains patch strings without interpreting their contents', () => {
    const patch = '*** Begin Patch\n*** End Patch';
    expect(readExecutorPolicyDecision(replaceExecutorArguments(patch))).toEqual(
      {
        kind: 'replace',
        value: patch,
      },
    );
  });

  it('does not place a private stop reason on an issued value or a read result', () => {
    const sentinel = 'private-executor-reason-sentinel';
    const decision = stopExecutorTurn(sentinel);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Reflect.ownKeys(decision)).toEqual([]);
    expect(JSON.stringify(decision)).toBe('{}');
    expect(inspect(decision, { showHidden: true })).not.toContain(sentinel);
    expect(JSON.stringify(readExecutorPolicyDecision(decision))).not.toContain(
      sentinel,
    );
    expect(structuredClone(decision)).toEqual({});
  });

  it('limits approval authority to stop and leaves result transforms data-only', () => {
    type Approval = NonNullable<EnvironmentOptions['approval']>;
    type Arguments = NonNullable<EnvironmentOptions['transformArguments']>;
    type Result = NonNullable<EnvironmentOptions['transformResult']>;
    expectTypeOf(stopExecutorTurn).returns.toExtend<ExecutorPolicyDecision>();
    expectTypeOf<ReturnType<typeof stopExecutorTurn>>().toExtend<
      Awaited<ReturnType<Approval>>
    >();
    expectTypeOf<ExecutorPolicyDecision>().toExtend<
      Awaited<ReturnType<Arguments>>
    >();
    expectTypeOf<ReturnType<typeof allowExecutorCall>>().not.toExtend<
      Awaited<ReturnType<Approval>>
    >();
    expectTypeOf<ExecutorPolicyDecision>().not.toExtend<
      Awaited<ReturnType<Result>>
    >();
  });
});

// These cases prove only the TS adapter contract, not native stop admission or joins.
describe('executor policy adapter', () => {
  function fixture(
    options: Partial<EnvironmentOptions> = {},
    changes: JsonObject = {},
    requestStop?: () => boolean,
  ) {
    const request: JsonObject = {
      phase: 'before',
      route: 'direct',
      boundary: 'pre_dispatch',
      tool_name: { namespace: 'functions', name: 'exec_command' },
      tool_kind: 'function_json',
      input: '{"cmd":"original"}',
      thread_id: 'root',
      turn_id: 'turn',
      call_id: 'call',
      ...changes,
    };
    const controller = new AbortController();
    const fail = vi.fn();
    const environment = new Environment({
      url: 'wss://executor.invalid',
      cwd: '/work',
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
      ...options,
    });
    const run = () =>
      applyExecutorPolicy(
        environment,
        {} as Session,
        {} as Agent,
        undefined,
        { sessionId: 'session', childId: null } as unknown as Parameters<
          typeof applyExecutorPolicy
        >[4],
        request,
        controller.signal,
        fail,
        requestStop,
      );
    return { run, controller, fail };
  }

  it('preserves approval order and original input for branded replacements', async () => {
    const order: string[] = [];
    const f = fixture({
      approval(_context, args) {
        order.push('approval');
        expect(args).toEqual({ cmd: 'original' });
        (args as { cmd: string }).cmd = 'approval mutation';
        return true;
      },
      transformArguments(_context, args) {
        order.push('transform');
        expect(args).toEqual({ cmd: 'original' });
        return replaceExecutorArguments({ cmd: 'replacement' });
      },
    });
    expect(await f.run()).toEqual({
      action: 'replace',
      value: { cmd: 'replacement' },
    });
    expect(order).toEqual(['approval', 'transform']);
  });

  it('treats raw action fields and serialized decisions as data', async () => {
    for (const value of [
      { action: 'stop', nested: { action: 'stop' } },
      JSON.parse(JSON.stringify(stopExecutorTurn('private'))),
    ]) {
      expect(await fixture({ transformArguments: () => value }).run()).toEqual({
        action: 'replace',
        value,
      });
    }
  });

  it('allows the original call without replacing its arguments', async () => {
    expect(
      await fixture({ transformArguments: allowExecutorCall }).run(),
    ).toEqual({ action: 'continue' });
  });

  it('keeps direct false local and never invokes the transform or stop seam', async () => {
    const transform = vi.fn();
    const stop = vi.fn(() => true);
    expect(
      await fixture(
        { approval: () => false, transformArguments: transform },
        {},
        stop,
      ).run(),
    ).toEqual({ action: 'deny' });
    expect(transform).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(['approval', 'arguments', 'generated false'])(
    'requests the captured stop for %s',
    async (source) => {
      const stop = vi.fn(() => true);
      const transform = vi.fn(() => allowExecutorCall());
      const options: Partial<EnvironmentOptions> =
        source === 'arguments'
          ? { transformArguments: () => stopExecutorTurn('private') }
          : {
              approval: () =>
                source === 'approval' ? stopExecutorTurn('private') : false,
              transformArguments: transform,
            };
      expect(
        await fixture(
          options,
          { route: source === 'generated false' ? 'code_mode' : 'direct' },
          stop,
        ).run(),
      ).toEqual({ action: 'deny' });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls[0]).toEqual([]);
      expect(transform).not.toHaveBeenCalled();
    },
  );

  it.each(['absent', 'refused'])(
    'fails instead of falling back to ordinary deny when stop is %s',
    async (mode) => {
      for (const options of [
        { approval: () => stopExecutorTurn('private') },
        { transformArguments: () => stopExecutorTurn('private') },
        { approval: () => false },
      ]) {
        await expect(
          fixture(
            options,
            { route: 'code_mode' },
            mode === 'refused' ? () => false : undefined,
          ).run(),
        ).rejects.toThrow('Executor owner stop was not accepted');
      }
    },
  );

  it('rejects stop in an ineligible before boundary', async () => {
    const stop = vi.fn(() => true);
    await expect(
      fixture(
        { approval: () => stopExecutorTurn() },
        { boundary: 'binding' },
        stop,
      ).run(),
    ).rejects.toThrow('Executor owner stop was not accepted');
    expect(stop).not.toHaveBeenCalled();
  });

  it('preserves a genuine stop-seam failure object', async () => {
    const failure = new Error('reservation failure');
    await expect(
      fixture({ approval: () => stopExecutorTurn('private') }, {}, () => {
        throw failure;
      }).run(),
    ).rejects.toBe(failure);
  });

  it.each(['exec_command', 'write_stdin', 'apply_patch'] as const)(
    'validates raw and branded replacement kind for %s',
    async (tool) => {
      const changes: JsonObject = {
        tool_name: { namespace: 'functions', name: tool },
        ...(tool === 'apply_patch'
          ? { tool_kind: 'freeform', input: 'original patch' }
          : {}),
      };
      const valid =
        tool === 'apply_patch' ? 'replacement patch' : { action: 'stop' };
      const invalid =
        tool === 'apply_patch' ? [null, {}, []] : [null, 'wrong kind', []];
      for (const brand of [false, true]) {
        const make = (value: JsonValue) =>
          brand ? replaceExecutorArguments(value) : value;
        expect(
          await fixture(
            { transformArguments: () => make(valid) },
            changes,
          ).run(),
        ).toEqual({ action: 'replace', value: valid });
        for (const value of invalid)
          await expect(
            fixture({ transformArguments: () => make(value) }, changes).run(),
          ).rejects.toThrow('Executor arguments must be');
      }
    },
  );

  it('keeps result transforms data-only without stop authority', async () => {
    const stop = vi.fn(() => true);
    const result = { action: 'stop', nested: { action: 'replace' } };
    expect(
      await fixture(
        { transformResult: () => result },
        { phase: 'after', result },
        stop,
      ).run(),
    ).toEqual({ action: 'replace', value: result });
    await expect(
      fixture(
        {
          // JavaScript can return a value outside the declared data-only result type.
          // @ts-expect-error Stop authority is excluded from result transforms.
          transformResult: () => stopExecutorTurn('private'),
        },
        { phase: 'after', result: {} },
        stop,
      ).run(),
    ).rejects.toThrow('Executor result transforms must return JSON data');
    expect(stop).not.toHaveBeenCalled();
  });

  it('preserves callback and supplied cancellation identities', async () => {
    const failure = new Error('callback failure');
    await expect(
      fixture({
        transformArguments: () => {
          throw failure;
        },
      }).run(),
    ).rejects.toBe(failure);
    const reason = new Error('supplied cancellation');
    const stop = vi.fn(() => true);
    const f = fixture(
      {
        approval: () => {
          f.controller.abort(reason);
          return stopExecutorTurn('private');
        },
      },
      {},
      stop,
    );
    await expect(f.run()).rejects.toBe(reason);
    expect(stop).not.toHaveBeenCalled();
  });
});
