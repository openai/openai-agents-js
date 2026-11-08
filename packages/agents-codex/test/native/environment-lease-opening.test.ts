import { RunCleanupError } from '../../src';
import { Manifest } from '@openai/agents-core/sandbox';
import { sandboxEnvironment } from '../../src/runtime/sandbox-environment';
import { nativeEventBatch } from '../fixtures/native-event-batches';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  type Session as PublicSession,
} from '../../src/runtime/public-agent';
import { Session } from '../../src/runtime/session';
import { Environment } from '../../src/runtime/environment';
import { NativeProvider } from '../../src/runtime/provider';
import { CODEX_REVISION, parseSessionState } from '../../src/runtime/state';
import { tool } from '../../src/runtime/tools';
import { z } from 'zod';

// Native construction is scripted so these tests exercise the real public
// opening and Session cleanup owners without loading a binary or sending I/O.
const fixture = vi.hoisted(() => ({
  createEngine: vi.fn(),
  createCheckpointEngine: vi.fn(),
  retire: vi.fn(),
  engineClose: vi.fn(),
  carrierClose: vi.fn(),
}));
vi.mock('../../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/binding')>()),
  binding: async () => ({
    _packaged_runtime: () => ({}),
    _create_provider_http_transports: () => ({ close: () => undefined }),
    _validate_python_tool_declarations: () => undefined,
    _validate_application_instructions: () => undefined,
    create_engine: fixture.createEngine,
    create_checkpoint_engine: fixture.createCheckpointEngine,
  }),
}));
vi.mock('../../src/runtime/http-model', () => ({
  NativeProviderRoutes: class {
    async start() {}
    async bindEngine() {}
    close = fixture.carrierClose;
  },
}));

function environment() {
  return new Environment({ url: 'wss://executor.invalid', cwd: '/workspace' });
}

function scriptedEvents() {
  const queued: string[] = [];
  const readers: ((wire: string) => void)[] = [];
  const submitted = Promise.withResolvers<void>();
  const responded = Promise.withResolvers<void>();
  const push = (event: object) => {
    const wire = JSON.stringify(event);
    const reader = readers.shift();
    if (reader) reader(wire);
    else queued.push(wire);
  };
  const submit = vi.fn(async () => {
    queueMicrotask(() => submitted.resolve());
    return JSON.stringify({ status: 'started', turn_id: 'run-one' });
  });
  const close = async () => {
    push({ id: 'shutdown', msg: { type: 'shutdown_complete' } });
    return fixture.retire();
  };
  fixture.createEngine.mockResolvedValue({
    start_replaceable_thread: async () => ({
      id: 'source-test',
      _submit: submit,
      _next_session_events: async () =>
        nativeEventBatch([
          await (queued.length
            ? Promise.resolve(queued.shift()!)
            : new Promise<string>((resolve) => {
                readers.push(resolve);
              })),
        ]),
      _finish_child_event_reader: () => {},
      _check_python_tool: () => {},
      _respond_python_tool: async () => {
        responded.resolve();
        return true;
      },
      _stop_sampling_for_close: () => {},
      _close_report: close,
      _close_selected_environment: close,
    }),
    _close_report: fixture.engineClose,
  });
  vi.mocked(Session.prototype._start).mockRestore();
  return {
    push,
    submit,
    submitted: submitted.promise,
    responded: responded.promise,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  fixture.createEngine.mockReset();
  fixture.createCheckpointEngine.mockReset();
  fixture.retire.mockReset().mockResolvedValue('');
  fixture.engineClose.mockReset().mockResolvedValue('');
  fixture.carrierClose.mockReset().mockResolvedValue(undefined);
  fixture.createEngine.mockResolvedValue({
    start_replaceable_thread: async () => ({
      id: 'source-test',
      _stop_sampling_for_close: () => {},
      _close_report: fixture.retire,
      _close_selected_environment: fixture.retire,
    }),
    _close_report: fixture.engineClose,
  });
  vi.spyOn(Session.prototype, '_start').mockResolvedValue(undefined);
});

describe('Environment source public opening and actual Session cleanup', () => {
  it('keeps the adapter resource until public Session native retirement, then joins every owner', async () => {
    const entered = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const events: string[] = [];
    fixture.retire.mockImplementation(async () => {
      entered.resolve();
      await retired.promise;
      events.push('native-retired');
      return '';
    });
    const resource = {
      state: { manifest: new Manifest() },
      close: async () => {
        events.push('sandbox');
      },
    };
    const source = sandboxEnvironment({
      manifest: new Manifest(),
      client: {
        backendId: 'controlled',
        create: async () => resource,
        delete: async () => {
          events.push('delete');
        },
      },
      connect: async (actual) => {
        expect(actual).toBe(resource);
        return Environment.lease(environment(), () => {
          events.push('gateway');
        });
      },
    });
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const session = await new Agent({ instructions: 'Test', provider }).session(
      { environment: source },
    );
    const closing = session.close();
    await entered.promise;
    expect(events).toEqual([]);
    retired.resolve();
    await closing;
    expect(events).toEqual(['native-retired', 'gateway', 'sandbox', 'delete']);
  });
  it('retains earlier provider opening cleanup while disposing its acquired source once', async () => {
    const provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const acquire = provider._acquire.bind(provider);
    const openingFailure = new Error('injected provider opening failure');
    const cleanupFailure = new Error('injected retained cleanup failure');
    const dispose = vi.fn(async () => {});
    const release = vi.fn<() => Promise<void>>();
    let cleanups = 0;
    vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
      const lease = acquire(captured);
      release.mockImplementation(lease.release);
      lease.retainOpeningCleanup(async () => {
        expect(dispose).toHaveBeenCalledOnce();
        if (++cleanups === 1) throw cleanupFailure;
        await release();
      });
      vi.spyOn(lease, 'open').mockRejectedValue(openingFailure);
      return lease;
    });
    const failure = await new Agent({ instructions: 'Test', provider })
      .session({
        environment: async () => Environment.lease(environment(), dispose),
      })
      .catch((error: unknown) => error);
    try {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toHaveProperty('cause', openingFailure);
      expect((failure as AggregateError).errors).toEqual([
        openingFailure,
        cleanupFailure,
      ]);
      expect(cleanups).toBe(1);
      expect(release).not.toHaveBeenCalled();
      expect(fixture.createEngine).not.toHaveBeenCalled();
      await provider.close();
      expect(cleanups).toBe(2);
      expect(release).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      await provider.close();
      expect(cleanups).toBe(2);
    } finally {
      await provider.close();
    }
  });

  it.each([false, true])(
    'preserves a recorded native failure when its tool-signal listener later aborts the caller (disposal fails: %s)',
    async (disposalFails) => {
      await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
      const events = scriptedEvents();
      const caller = new AbortController();
      const applicationReason = new Error(
        'application reacted to terminal failure',
      );
      let nativeFailure: unknown;
      const watched = tool({
        name: 'watch',
        parameters: z.object({}),
        execute: (_args, { signal }) => {
          signal.addEventListener(
            'abort',
            () => {
              nativeFailure = signal.reason;
              caller.abort(applicationReason);
            },
            { once: true },
          );
          return 'watching';
        },
      });
      const cleanupFailure = new Error('independent source cleanup failure');
      const dispose = vi.fn(async () => {
        if (disposalFails) throw cleanupFailure;
      });
      const observed = new Agent({
        instructions: 'Test',
        provider,
        tools: [watched],
      })
        .run('Go', {
          environment: async () => Environment.lease(environment(), dispose),
          signal: caller.signal,
        })
        .catch((error) => error);
      await Promise.race([
        events.submitted,
        observed.then((error) => {
          throw error;
        }),
      ]);
      events.push({
        id: 'tool',
        msg: {
          type: 'dynamic_tool_call_request',
          turnId: 'run-one',
          callId: 'watch-one',
          tool: 'watch',
          arguments: {},
          _sdk_python_tool: { thread: 'source-test', generation: '0', slot: 0 },
          _sdk_code_origin: null,
        },
      });
      await Promise.race([
        events.responded,
        observed.then((error) => {
          throw error;
        }),
      ]);
      events.push({
        id: 'run-one',
        msg: { type: 'error', message: 'genuine model failure' },
      });
      events.push({
        id: 'run-one',
        msg: { type: 'task_complete', last_agent_message: '' },
      });
      const failure = await observed;
      expect(caller.signal.reason).toBe(applicationReason);
      expect(nativeFailure).toMatchObject({ message: 'genuine model failure' });
      if (disposalFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors[0]).toBe(nativeFailure);
        expect(failure.errors[1]).toMatchObject({ cause: cleanupFailure });
      } else {
        expect(failure).toBe(nativeFailure);
      }
      expect(dispose).toHaveBeenCalledTimes(1);
      await expect(provider.close()).resolves.toBeUndefined();
    },
  );
  it('pre-abort prevents public source acquisition and native opening', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const reason = new Error('caller cancelled before opening');
    const source = vi.fn(async () =>
      Environment.lease(environment(), () => {}),
    );
    await expect(
      new Agent({ instructions: 'Test', provider }).session({
        environment: source,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(source).not.toHaveBeenCalled();
    expect(fixture.createEngine).not.toHaveBeenCalled();
  });

  it('retires a late native opening before disposing after opening cancellation', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const acquiredEngine = Promise.withResolvers<void>();
    const finishEngine = Promise.withResolvers<void>();
    const order: string[] = [];
    fixture.createEngine.mockImplementation(async () => {
      acquiredEngine.resolve();
      await finishEngine.promise;
      return {
        _close_report: async () => {
          order.push('engine');
          return '';
        },
      };
    });
    fixture.carrierClose.mockImplementation(async () => {
      order.push('carrier');
    });
    const caller = new AbortController();
    const reason = new Error('cancelled while opening native resources');
    let acquisitionSignal: AbortSignal | undefined;
    const opening = new Agent({ instructions: 'Test', provider }).session({
      environment: async ({ signal }) => {
        acquisitionSignal = signal;
        return Environment.lease(environment(), () => {
          order.push('source');
        });
      },
      signal: caller.signal,
    });
    const observed = opening.catch((error) => error);
    await acquiredEngine.promise;
    caller.abort(reason);
    expect(acquisitionSignal?.aborted).toBe(false);
    expect(order).toEqual([]);
    finishEngine.resolve();
    expect(await observed).toBe(reason);
    expect(order).toEqual(['engine', 'carrier', 'source']);
    expect(acquisitionSignal?.aborted).toBe(false);
  });

  it('ends a Session opening signal at publication', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const caller = new AbortController();
    const dispose = vi.fn();
    const session = await new Agent({ instructions: 'Test', provider }).session(
      {
        environment: async () => Environment.lease(environment(), dispose),
        signal: caller.signal,
      },
    );
    caller.abort(new Error('opening already published'));
    await Promise.resolve();
    expect(fixture.retire).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await session.close();
  });

  it('keeps Agent.run cancellation active after publication and joins source exit', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const events = scriptedEvents();
    const exit = Promise.withResolvers<void>();
    const exitStarted = Promise.withResolvers<void>();
    const caller = new AbortController();
    const run = new Agent({ instructions: 'Test', provider }).run('Go', {
      environment: async () =>
        Environment.lease(environment(), async () => {
          exitStarted.resolve();
          await exit.promise;
        }),
      signal: caller.signal,
    });
    let settled = false;
    const observed = run.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.race([
      events.submitted,
      observed.then((error) => {
        throw error;
      }),
    ]);
    const reason = new Error('cancel active run');
    caller.abort(reason);
    await exitStarted.promise;
    expect(settled).toBe(false);
    await expect(provider.close()).rejects.toThrow('open or opening');
    exit.resolve();
    expect(await observed).toBe(reason);
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('joins source-owner interruption after publication before disposal', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const sourceOwner = new AbortController();
    const nativeRetired = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    fixture.retire.mockImplementation(async () => {
      entered.resolve();
      return nativeRetired.promise;
    });
    const dispose = vi.fn();
    const session = await new Agent({ instructions: 'Test', provider }).session(
      {
        environment: async () =>
          Environment.lease(environment(), dispose, sourceOwner.signal),
      },
    );
    sourceOwner.abort(new Error('resource owner timed out'));
    await entered.promise;
    expect(dispose).not.toHaveBeenCalled();
    nativeRetired.resolve('');
    await session.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('joins native retirement before scope disposal and provider release', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const nativeRetired = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    fixture.retire.mockImplementation(async () => {
      entered.resolve();
      return nativeRetired.promise;
    });
    const dispose = vi.fn();
    const session = await new Agent({ instructions: 'Test', provider }).session(
      {
        environment: async () => Environment.lease(environment(), dispose),
      },
    );
    const closing = session.close();
    await entered.promise;
    expect(dispose).not.toHaveBeenCalled();
    await expect(provider.close()).rejects.toThrow('open or opening');
    nativeRetired.resolve('');
    await closing;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fixture.engineClose).toHaveBeenCalledTimes(1);
    expect(fixture.carrierClose).toHaveBeenCalledTimes(1);
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('runs disposal under its captured scope and refuses self-close without deadlock', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const scope = new AsyncLocalStorage<string>();
    let observed: string | undefined;
    const session: PublicSession = await new Agent({
      instructions: 'Test',
      provider,
    }).session({
      environment: async () =>
        scope.run('resource', async () =>
          Environment.lease(environment(), async () => {
            observed = scope.getStore();
            await expect(async () => session.close()).rejects.toThrow(
              'own session',
            );
          }),
        ),
    });
    await session.close();
    expect(observed).toBe('resource');
  });

  it('preserves gateway scope and rejects self-close before cleaning up the sandbox', async () => {
    const provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const scope = new AsyncLocalStorage<string>();
    const events: string[] = [];
    let observed: string | undefined;
    const session: PublicSession = await new Agent({
      instructions: 'Test',
      provider,
    }).session({
      environment: sandboxEnvironment({
        manifest: new Manifest(),
        client: {
          backendId: 'controlled',
          create: async () => ({
            state: { manifest: new Manifest() },
            close: async () => {
              events.push('sandbox');
            },
          }),
          delete: async () => {
            events.push('delete');
          },
        },
        connect: async () =>
          scope.run('gateway', async () =>
            Environment.lease(environment(), async (...args: unknown[]) => {
              expect(args).toEqual([]);
              observed = scope.getStore();
              events.push('gateway');
              await session.close();
            }),
          ),
      }),
    });
    await expect(session.close()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('own session'),
      }),
    });
    expect(observed).toBe('gateway');
    expect(events).toEqual(['gateway', 'sandbox', 'delete']);
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('releases provider resources after a completed rejected disposer', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const failure = new Error('application release failed');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    const session = await new Agent({ instructions: 'Test', provider }).session(
      {
        environment: async () => Environment.lease(environment(), dispose),
      },
    );
    await expect(session.close()).rejects.toMatchObject({ cause: failure });
    await expect(session.close()).rejects.toMatchObject({ cause: failure });
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('retains an idle source-abort disposal failure after automatic retirement finishes', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const sourceOwner = new AbortController();
    const failure = new Error('idle source disposal failed');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    const session = await new Agent({ instructions: 'Test', provider }).session(
      {
        environment: async () =>
          Environment.lease(environment(), dispose, sourceOwner.signal),
      },
    );
    // The terminal observation proves automatic close has completed before the
    // caller joins cleanup, rather than joining an in-progress close by chance.
    const terminal = Array.fromAsync(session.events());
    sourceOwner.abort(new Error('idle owner interrupted'));
    expect(await terminal).toContainEqual(
      expect.objectContaining({ type: 'session_ended' }),
    );
    await expect(provider.close()).resolves.toBeUndefined();
    const retirement = session.close();
    await expect(retirement).rejects.toMatchObject({ cause: failure });
    expect(session.close()).toBe(retirement);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fixture.retire).toHaveBeenCalledTimes(1);
    expect(fixture.engineClose).toHaveBeenCalledTimes(1);
    expect(fixture.carrierClose).toHaveBeenCalledTimes(1);
  });

  it('disposes a source after validation fails before native construction', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const dispose = vi.fn();
    await expect(
      new Agent({ instructions: 'Test', provider }).session({
        state: {} as never,
        environment: async () => Environment.lease(environment(), dispose),
      }),
    ).rejects.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fixture.createEngine).not.toHaveBeenCalled();
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('joins a failed native opening before releasing the source', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const error = new Error('native opening failed');
    const order: string[] = [];
    fixture.createEngine.mockResolvedValue({
      start_replaceable_thread: async () => {
        throw error;
      },
      _close_report: async () => {
        order.push('engine');
        return '';
      },
    });
    fixture.carrierClose.mockImplementation(async () => {
      order.push('carrier');
    });
    await expect(
      new Agent({ instructions: 'Test', provider }).session({
        environment: async () =>
          Environment.lease(environment(), () => {
            order.push('source');
          }),
      }),
    ).rejects.toBe(error);
    expect(order).toEqual(['engine', 'carrier', 'source']);
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('joins checkpoint restore mismatch cleanup before disposing its acquired source', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const state = parseSessionState(
      JSON.stringify({
        format_version: 2,
        codex_revision: CODEX_REVISION,
        source_session_id: 'saved-root',
        executor_policy_digest: 'a'.repeat(64),
        root_metadata: {},
        history: [],
        managed_tool_specs: [],
        agent_options: {},
      }),
    );
    const original = new Error('checkpoint restore mismatch');
    const restoring = Promise.withResolvers<void>();
    const failRestore = Promise.withResolvers<void>();
    const closingEngine = Promise.withResolvers<void>();
    const finishEngine = Promise.withResolvers<void>();
    const closingCarrier = Promise.withResolvers<void>();
    const finishCarrier = Promise.withResolvers<void>();
    const disposing = Promise.withResolvers<void>();
    const finishDispose = Promise.withResolvers<void>();
    const order: string[] = [];
    const restore = vi.fn(async (checkpoint: string) => {
      expect(JSON.parse(checkpoint)).toMatchObject({
        format_version: 2,
        codex_revision: CODEX_REVISION,
        source_session_id: 'saved-root',
      });
      restoring.resolve();
      await failRestore.promise;
      throw original;
    });
    fixture.createCheckpointEngine.mockResolvedValue({
      restore_checkpoint: restore,
      _close_report: fixture.engineClose,
    });
    fixture.engineClose.mockImplementation(async () => {
      closingEngine.resolve();
      await finishEngine.promise;
      order.push('engine');
      return '';
    });
    fixture.carrierClose.mockImplementation(async () => {
      closingCarrier.resolve();
      await finishCarrier.promise;
      order.push('carrier');
    });
    const dispose = vi.fn(async () => {
      order.push('source');
      disposing.resolve();
      await finishDispose.promise;
    });
    const source = vi.fn(async () => Environment.lease(environment(), dispose));
    let settled = false;
    const observed = new Agent({ instructions: 'Test', provider })
      .session({ state, environment: source })
      .catch((error) => {
        settled = true;
        return error;
      });
    try {
      await Promise.race([
        restoring.promise,
        observed.then((error) => {
          throw error;
        }),
      ]);
      expect(source).toHaveBeenCalledTimes(1);
      expect(fixture.createCheckpointEngine).toHaveBeenCalledTimes(1);
      expect(fixture.createEngine).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
      failRestore.resolve();
      await closingEngine.promise;
      expect(dispose).not.toHaveBeenCalled();
      expect(fixture.carrierClose).not.toHaveBeenCalled();
      finishEngine.resolve();
      await closingCarrier.promise;
      expect(order).toEqual(['engine']);
      expect(dispose).not.toHaveBeenCalled();
      finishCarrier.resolve();
      await disposing.promise;
      expect(order).toEqual(['engine', 'carrier', 'source']);
      expect(settled).toBe(false);
      finishDispose.resolve();
      expect(await observed).toBe(original);
      await provider.close();
      await provider.close();
      expect(source).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(fixture.engineClose).toHaveBeenCalledTimes(1);
      expect(fixture.carrierClose).toHaveBeenCalledTimes(1);
      // Restore rejected before it returned a thread to retire.
      expect(fixture.retire).not.toHaveBeenCalled();
    } finally {
      failRestore.resolve();
      finishEngine.resolve();
      finishCarrier.resolve();
      finishDispose.resolve();
      await observed;
    }
  });

  it.each([false, true])(
    'retains cleanup after one-shot work (failed: %s) without replaying it',
    async (workFails) => {
      const provider = new NativeProvider({ apiKey: 'synthetic-key' });
      const events = scriptedEvents();
      const cleanupFailure = new Error('native retirement temporarily failed');
      fixture.retire.mockRejectedValue(cleanupFailure);
      const dispose = vi.fn();
      const effect = vi.fn(async () => 'effect recorded');
      const record = tool({
        name: 'record',
        parameters: z.object({}),
        execute: effect,
      });
      const observed = new Agent({
        instructions: 'Test',
        provider,
        tools: [record],
      })
        .run('Go', {
          environment: async () => Environment.lease(environment(), dispose),
        })
        .catch((error) => error);
      await events.submitted;
      events.push({
        id: 'tool',
        msg: {
          type: 'dynamic_tool_call_request',
          turnId: 'run-one',
          callId: 'record-one',
          tool: 'record',
          arguments: {},
          _sdk_python_tool: { thread: 'source-test', generation: '0', slot: 0 },
          _sdk_code_origin: null,
        },
      });
      await events.responded;
      if (workFails)
        events.push({
          id: 'run-one',
          msg: { type: 'error', message: 'original model failure' },
        });
      events.push({
        id: 'run-one',
        msg: { type: 'task_complete', last_agent_message: 'completed once' },
      });
      const failure = await observed;
      expect(failure).toBeInstanceOf(RunCleanupError);
      expect(failure.cause).toBe(failure.errors[0]);
      if (workFails)
        expect(failure.cause).toMatchObject({
          message: 'original model failure',
        });
      else expect(failure.cause).toBe(cleanupFailure);
      expect(failure.errors[1]).toBe(cleanupFailure);
      expect(dispose).not.toHaveBeenCalled();
      await expect(provider.close()).rejects.toThrow('open or opening');
      expect(failure.cleanup).toBeDefined();
      await expect(failure.cleanup.close()).rejects.toBe(cleanupFailure);

      const retirement = Promise.withResolvers<string>();
      fixture.retire.mockReturnValue(retirement.promise);
      const beforeRetry = fixture.retire.mock.calls.length;
      const first = failure.cleanup.close();
      const concurrent = failure.cleanup.close();
      expect(first).toBe(concurrent);
      expect(dispose).not.toHaveBeenCalled();
      retirement.resolve('');
      await first;
      expect(fixture.retire).toHaveBeenCalledTimes(beforeRetry + 1);
      expect(dispose).toHaveBeenCalledTimes(1);
      await failure.cleanup.close();
      expect(fixture.retire).toHaveBeenCalledTimes(beforeRetry + 1);
      expect(events.submit).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledTimes(1);
      await provider.close();
    },
  );

  it('retains a source after incomplete native cleanup until close can retry', async () => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const failure = new Error('native cleanup incomplete');
    fixture.retire.mockRejectedValueOnce(failure).mockResolvedValue('');
    const dispose = vi.fn();
    const session = await new Agent({ instructions: 'Test', provider }).session(
      {
        environment: async () => Environment.lease(environment(), dispose),
      },
    );
    await expect(session.close()).rejects.toBe(failure);
    expect(dispose).not.toHaveBeenCalled();
    await expect(provider.close()).rejects.toThrow('open or opening');
    await session.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

it.each([
  'legacy-to-default',
  'legacy-to-explicit-strict',
  'strict-to-legacy',
  'strict-to-none',
] as const)(
  'rejects checkpoint write mode mismatch before native acquisition: %s',
  async (mode) => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const state = parseSessionState(
      JSON.stringify({
        format_version: 2,
        codex_revision: CODEX_REVISION,
        source_session_id: 'saved-root',
        root_metadata: {},
        history: [],
        managed_tool_specs: [],
        agent_options: {},
        ...(mode.startsWith('strict-to-')
          ? { executor_policy_digest: 'a'.repeat(64) }
          : {}),
      }),
    );
    const selected = new Environment({
      url: 'wss://executor.invalid',
      cwd: '/workspace',
      ...(mode === 'strict-to-legacy'
        ? { writePolicy: 'legacy' as const }
        : {}),
      ...(mode === 'legacy-to-explicit-strict' ? { writableRoots: [] } : {}),
    });
    await expect(
      new Agent({ instructions: 'Test', provider }).session({
        state,
        environment: mode === 'strict-to-none' ? undefined : selected,
      }),
    ).rejects.toThrow(
      'Restore requires the recorded executor write and network policy',
    );
    expect(fixture.createEngine).not.toHaveBeenCalled();
    expect(fixture.createCheckpointEngine).not.toHaveBeenCalled();
  },
);
