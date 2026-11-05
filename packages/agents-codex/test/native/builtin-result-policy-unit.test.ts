import { afterEach, expect, it, vi } from 'vitest';
import { Agent, Environment, NativeError } from '../../src';
import type { Engine, NativeThread } from '../../src/runtime/binding';
import { Session, issueTurn } from '../../src/runtime/session';
import type { JsonObject } from '../../src/runtime/binding';
import { applyExecutorPolicy } from '../../src/runtime/executor-policy';
import { captureTools } from '../../src/runtime/tools';

// Controlled reader tests exercise JS ownership only, without a native grant.
it.each([
  { throwsDuringCleanup: false, ackFails: false, lateEntry: false },
  { throwsDuringCleanup: true, ackFails: false, lateEntry: false },
  { throwsDuringCleanup: true, ackFails: true, lateEntry: false },
  { throwsDuringCleanup: false, ackFails: false, lateEntry: true },
  { throwsDuringCleanup: true, ackFails: false, lateEntry: true },
  { throwsDuringCleanup: true, ackFails: true, lateEntry: true },
])(
  'keeps an idle root stop fenced through policy cleanup and preserves errors (%s)',
  async ({ throwsDuringCleanup, ackFails, lateEntry }) => {
    const queued: Array<string | null> = [];
    let wake: ((value: string | null) => void) | undefined;
    const send = (value: object | null) => {
      const wire = value === null ? null : JSON.stringify(value);
      if (wake) {
        const deliver = wake;
        wake = undefined;
        deliver(wire);
      } else queued.push(wire);
    };
    const decisions = new Map<string, string>();
    const released = new Set<string>();
    const settlement = Promise.withResolvers<void>();
    let settled = false;
    const acknowledgmentError = new Error('native stop acknowledgment failed');
    const settle = vi.fn(async () => {
      if (lateEntry) {
        await settlement.promise;
        send({ cancel: '2' });
      }
      settled = true;
      if (ackFails) throw acknowledgmentError;
    });
    const nativeRelease = vi.fn();
    let nextTurn = 0;
    const native = {
      id: 'root',
      _submit: async () =>
        JSON.stringify({ status: 'started', turn_id: `turn-${++nextTurn}` }),
      _next_native_interception: () =>
        queued.length
          ? Promise.resolve(queued.shift()!)
          : new Promise<string | null>((resolve) => {
              wake = resolve;
            }),
      _handoff_native_interception: () => true,
      _check_native_interception: () => true,
      _resolve_native_interception: (nonce: string, reply: string) => {
        if (decisions.has(nonce)) return false;
        decisions.set(nonce, reply);
        return true;
      },
      _release_native_interception: (nonce: string) => {
        released.add(nonce);
        return true;
      },
      _finish_native_interception_reader: vi.fn(),
      _request_graph_stop: () => ({ settle, release: nativeRelease }),
    } as unknown as NativeThread;
    const release = Promise.withResolvers<void>();
    const cleanupError = new Error('distinct callback cleanup failure');
    let entered = false;
    let heldEntries = 0;
    let holdResult = true;
    const acceptedInputs: unknown[] = [];
    const agent = new Agent({ instructions: 'Controlled reader fixture.' });
    const environment = new Environment({
      url: 'wss://executor.invalid',
      cwd: '/tmp',
      tools: ['exec_command'],
      async transformResult(_info, value) {
        if (!holdResult) {
          acceptedInputs.push(value);
          return value;
        }
        entered = true;
        heldEntries++;
        await release.promise;
        if (throwsDuringCleanup) throw cleanupError;
        return { output: 'late-value' };
      },
    });
    const session = new Session(
      {} as Engine,
      native,
      captureTools([]),
      { applicationAgent: agent },
      {},
      null,
      undefined,
      environment,
    );
    const controlled = session as unknown as {
      lastRun: unknown;
      finish(run: unknown, error: unknown, output: string): void;
      readInterceptions(): Promise<void>;
      graphStops: Set<{ completion: Promise<void> }>;
    };
    const reader = controlled
      .readInterceptions()
      .catch((error: unknown) => error);
    const identity = {
      thread_id: 'root',
      incarnation: 'original-incarnation',
      turn_id: 'turn-1',
      outer_call_id: 'outer',
      cell_id: 'cell',
    };
    let stopping: Promise<void> | undefined;
    try {
      const original = await session.submit('original');
      send({ nonce: '1', cell_owner: { owner_id: '17', ...identity } });
      await vi.waitFor(() => expect(released.has('1')).toBe(true));
      expect(decisions.get('1')).toBe('{"action":"continue"}');
      if (!throwsDuringCleanup && !ackFails) {
        holdResult = false;
        const whole = JSON.parse(
          '{"structuredContent":{"__proto__":{"ownKeyRetained":true},"constructor":{"prototype":"data"}}}',
        );
        send({
          nonce: '4',
          request: {
            ...identity,
            phase: 'after',
            route: 'code_mode',
            boundary: 'executor_return',
            tool_name: { name: 'exec_command', namespace: 'functions' },
            tool_kind: 'function_json',
            input: '{}',
            runtime_tool_call_id: 'json-result',
            call_id: null,
            model: 'issuing-model',
            result: whole,
          },
        });
        await vi.waitFor(() => expect(released.has('4')).toBe(true));
        expect(acceptedInputs).toEqual([whole]);
        const result = JSON.parse(decisions.get('4')!);
        expect(result.action).toBe('replace');
        expect(Object.hasOwn(result.value.structuredContent, '__proto__')).toBe(
          true,
        );
        expect(result.value).toEqual(whole);
        expect(Object.getPrototypeOf(result.value.structuredContent)).toBe(
          Object.prototype,
        );
        expect(Object.prototype).not.toHaveProperty('ownKeyRetained');
        holdResult = true;
      }
      controlled.finish(controlled.lastRun, undefined, 'original complete');
      expect((await original.wait()).finalOutput).toBe('original complete');
      const resultNotice = (nonce: string) => ({
        nonce,
        request: {
          ...identity,
          phase: 'after',
          route: 'code_mode',
          boundary: 'executor_return',
          tool_name: { name: 'exec_command', namespace: 'functions' },
          tool_kind: 'function_json',
          input: '{}',
          runtime_tool_call_id: 'nested',
          call_id: null,
          model: 'issuing-model',
          result: { output: 'private' },
        },
      });
      if (!lateEntry) {
        send(resultNotice('2'));
        await vi.waitFor(() => expect(entered).toBe(true));
      }
      let joined = false;
      // interrupt acknowledges acceptance; the Session separately owns cleanup.
      await session.interrupt({
        scope: 'all',
        mode: lateEntry ? 'graceful' : 'force',
      });
      stopping = [...controlled.graphStops][0]!.completion;
      void stopping.then(
        () => {
          joined = true;
        },
        () => {
          joined = true;
        },
      );
      await vi.waitFor(() => expect(settle).toHaveBeenCalled());
      if (lateEntry) {
        // This callback enters after the graceful stop's initial snapshot.
        send(resultNotice('2'));
        await vi.waitFor(() => expect(entered).toBe(true));
        settlement.resolve();
        await vi.waitFor(() => expect(settled).toBe(true));
      }
      expect(joined).toBe(false);
      expect(nativeRelease).not.toHaveBeenCalled();
      if (lateEntry && !ackFails) {
        // Native settlement fences subsequent entry, even through an old lease.
        send(resultNotice('5'));
        await vi.waitFor(() => expect(released.has('5')).toBe(true));
        expect(decisions.get('5')).toBe('{"action":"deny"}');
        expect(heldEntries).toBe(1);
      }
      await expect(session.submit('while stopping')).rejects.toBeInstanceOf(
        Error,
      );
      expect(nextTurn).toBe(1);
      release.resolve();
      if (throwsDuringCleanup || ackFails) {
        const failure = await stopping.catch((error: unknown) => error);
        const leaves = (error: unknown): unknown[] =>
          error instanceof AggregateError
            ? error.errors.flatMap(leaves)
            : [error];
        if (throwsDuringCleanup)
          expect(leaves(failure)).toContain(cleanupError);
        if (ackFails) expect(leaves(failure)).toContain(acknowledgmentError);
        expect(nativeRelease).toHaveBeenCalledWith(false);
      } else {
        await stopping;
        expect(nativeRelease).toHaveBeenCalledWith(true);
        const successor = await session.submit('successor');
        send({
          nonce: '3',
          cell_owner: {
            owner_id: '18',
            ...identity,
            turn_id: 'turn-2',
            cell_id: 'new-cell',
          },
        });
        await vi.waitFor(() => expect(released.has('3')).toBe(true));
        expect(decisions.get('3')).toBe('{"action":"continue"}');
        controlled.finish(controlled.lastRun, undefined, 'successor complete');
        expect((await successor.wait()).finalOutput).toBe('successor complete');
      }
      expect(decisions.get('2')).toBe('{"action":"deny"}');
      expect(released.has('2')).toBe(true);
    } finally {
      settlement.resolve();
      release.resolve();
      await stopping?.catch(() => {});
      send(null);
      await reader;
    }
  },
);

// The deadline adapter must preserve cancellation identity after physical work joins.
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  'joins expired executor work and preserves an actual cleanup error: %s',
  async (throwsAfterAbort) => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const primary = new NativeError('Executor policy failed');
    const cleanup = new Error('application cleanup failed');
    const agent = new Agent({ instructions: 'Controlled policy test.' });
    // The pure policy adapter retains this identity but calls no Session API.
    const session = {} as Session;
    const submission = issueTurn(
      'root',
      'turn',
      'submission',
      async () => {
        throw new Error('Pure policy fixture has no native completion');
      },
      async function* () {},
      async () => {},
      async () => {},
    );
    const environment = new Environment({
      url: 'wss://example.invalid/executor',
      cwd: '/work',
      tools: ['exec_command'],
      policyTimeout: 0.01,
      async transformArguments() {
        entered.resolve();
        await release.promise;
        if (throwsAfterAbort) throw cleanup;
        return { cmd: 'late command' };
      },
    });
    const fail = vi.fn(() => controller.abort(primary));
    const request: JsonObject = {
      phase: 'before',
      route: 'direct',
      boundary: 'pre_dispatch',
      thread_id: 'root',
      turn_id: 'turn',
      call_id: 'call',
      tool_kind: 'function_json',
      tool_name: { namespace: 'functions', name: 'exec_command' },
      input: '{"cmd":"original command"}',
    };
    let settled = false;
    const outcome = applyExecutorPolicy(
      environment,
      session,
      agent,
      undefined,
      submission,
      request,
      controller.signal,
      fail,
    )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      release.resolve();
      const result = await outcome;
      expect('error' in result && result.error).toBe(
        throwsAfterAbort ? cleanup : primary,
      );
    } finally {
      release.resolve();
      await outcome;
    }
  },
);
