import { access } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  Runner,
  type SessionOptions,
} from '../../src/runtime/public-agent';
import {
  NativeProvider,
  type ModelSettings,
  type ProviderLease,
} from '../../src/runtime/provider';
import { Environment } from '../../src/runtime/environment';
import { NativeAgents } from '../../src/runtime/native-agents';
import { CODEX_REVISION, parseSessionState } from '../../src/runtime/state';

type CloseOptions = {
  onClose?: () => Promise<void>;
  initialModelSettings?: ModelSettings;
};
const fixture = vi.hoisted(() => ({
  preflight: vi.fn<() => Promise<void>>(),
  start: vi.fn<(settings?: ModelSettings) => Promise<void>>(),
  sessionClose: vi.fn<(options: CloseOptions) => Promise<void>>(),
  threadClose: vi.fn<() => Promise<void>>(),
  engineClose: vi.fn<() => Promise<void>>(),
  createEngine: vi.fn(),
  bind: vi.fn<() => Promise<void>>(),
  carrierStart: vi.fn<() => Promise<void>>(),
  carrierClose: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/binding')>()),
  binding: async () => {
    await fixture.preflight();
    return {
      _packaged_runtime: () => ({}),
      _create_provider_http_transports: () => ({ close: () => undefined }),
      _validate_python_tool_declarations: () => undefined,
      _validate_application_instructions: () => undefined,
      create_engine: fixture.createEngine,
      create_checkpoint_engine: fixture.createEngine,
    };
  },
}));
vi.mock('../../src/runtime/http-model', () => ({
  NativeProviderRoutes: class {
    start = fixture.carrierStart;
    bindEngine = fixture.bind;
    close = fixture.carrierClose;
  },
}));
vi.mock('../../src/runtime/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/session')>()),
  InteractionRequired: class extends Error {},
  Session: class {
    constructor(
      _engine: unknown,
      _thread: unknown,
      _catalog: unknown,
      private options: CloseOptions,
    ) {}
    _start() {
      return fixture.start(this.options.initialModelSettings);
    }
    async _run() {}
    async wait() {
      return { finalOutput: 'synthetic answer' };
    }
    close() {
      return fixture.sessionClose(this.options);
    }
  },
}));

const leases: ProviderLease[] = [];
function provider() {
  const result = new NativeProvider({ apiKey: 'synthetic-test-key' });
  const acquire = result._acquire.bind(result);
  vi.spyOn(result, '_acquire').mockImplementation(() => {
    const lease = acquire();
    leases.push(lease);
    return lease;
  });
  return result;
}
function deferred() {
  return Promise.withResolvers<void>();
}
function opening(connection: NativeProvider) {
  return new Agent({
    instructions: 'Test cleanup',
    provider: connection,
  }).session();
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.preflight.mockResolvedValue();
  fixture.start.mockResolvedValue();
  fixture.sessionClose.mockImplementation(async (options) => {
    await options.onClose?.();
  });
  fixture.threadClose.mockResolvedValue();
  fixture.engineClose.mockResolvedValue();
  fixture.bind.mockResolvedValue();
  fixture.carrierStart.mockResolvedValue();
  fixture.carrierClose.mockResolvedValue();
  fixture.createEngine.mockResolvedValue({
    start_replaceable_thread: async () => ({
      close: fixture.threadClose,
      _close_report: async () => {
        await fixture.threadClose();
        return '';
      },
    }),
    restore_checkpoint: async () => ({
      close: fixture.threadClose,
      _close_report: async () => {
        await fixture.threadClose();
        return '';
      },
    }),
    close: fixture.engineClose,
    _close_report: async () => {
      await fixture.engineClose();
      return '';
    },
  });
});

describe('native opening options without loading native code', () => {
  it('keeps the default provider and sibling lease usable after a Session closes', async () => {
    const agent = new Agent({ instructions: 'Answer.' });
    const initial = agent.provider;
    const first = await agent.session();
    const second = await agent.session();
    const homes = fixture.createEngine.mock.calls.map(
      (args) => JSON.parse(args[1]).codex_home as string,
    );
    await first.close();
    await expect(access(homes[0])).rejects.toThrow();
    await expect(access(homes[1])).resolves.toBeUndefined();
    await expect(initial.close()).rejects.toThrow('open or opening sessions');
    await second.close();
    const next = await agent.session();
    await next.close();
    expect(agent.provider).toBe(initial);
    await initial.close();
  });

  it('overrides provider and model, merges defined settings, and leaves Agent defaults intact', async () => {
    const defaults = provider();
    const selected = provider();
    const defaultAcquire = vi.mocked(defaults._acquire);
    const selectedAcquire = vi.mocked(selected._acquire);
    const agent = new Agent({
      instructions: 'Answer.',
      provider: defaults,
      model: 'agent-model',
      modelSettings: {
        reasoningEffort: 'low',
        reasoningSummary: 'concise',
        serviceTier: 'flex',
      },
    });
    const patch: ModelSettings = {
      reasoningEffort: 'high',
      reasoningSummary: undefined,
      serviceTier: null,
    };
    const session = await agent.session({
      provider: selected,
      model: 'opening-model',
      modelSettings: patch,
    });
    const [config, runtime] = fixture.createEngine.mock.calls[0]
      .slice(0, 2)
      .map((value: string) => JSON.parse(value));
    expect(config).toMatchObject({
      model_reasoning_effort: 'high',
      model_reasoning_summary: 'concise',
    });
    expect(config).not.toHaveProperty('service_tier');
    expect(fixture.start).toHaveBeenCalledWith({
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
      serviceTier: null,
    });
    expect(runtime.model).toBe('opening-model');
    expect(defaultAcquire).not.toHaveBeenCalled();
    expect(selectedAcquire).toHaveBeenCalledTimes(1);
    expect(agent.provider).toBe(defaults);
    expect(agent.model).toBe('agent-model');
    expect(agent.modelSettings).toEqual({
      reasoningEffort: 'low',
      reasoningSummary: 'concise',
      serviceTier: 'flex',
    });
    expect(patch).toEqual({
      reasoningEffort: 'high',
      reasoningSummary: undefined,
      serviceTier: null,
    });
    await session.close();
    const inherited = await agent.session({ modelSettings: {} });
    expect(JSON.parse(fixture.createEngine.mock.calls[1][0])).toMatchObject({
      model_reasoning_effort: 'low',
      model_reasoning_summary: 'concise',
      service_tier: 'flex',
    });
    expect(JSON.parse(fixture.createEngine.mock.calls[1][1]).model).toBe(
      'agent-model',
    );
    await inherited.close();
    const reused = await agent.session({ provider: selected });
    await reused.close();
    await Promise.all([defaults.close(), selected.close()]);
  });

  it('captures concurrent opening overrides before awaiting declaration preflight', async () => {
    const entered = deferred();
    const release = deferred();
    fixture.preflight.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const agent = new Agent({ instructions: 'Answer.' });
    const selected = provider();
    const later = provider();
    const patch = { reasoningEffort: 'low' };
    const options: SessionOptions = {
      provider: selected,
      model: 'captured-model',
      modelSettings: patch,
    };
    const opening = agent.session(options);
    await entered.promise;
    options.provider = later;
    options.model = 'mutated-model';
    patch.reasoningEffort = 'high';
    agent.model = 'later-agent-model';
    agent.modelSettings = { reasoningSummary: 'detailed' };
    let first: Awaited<ReturnType<typeof agent.session>> | undefined;
    let second: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      second = await agent.session({ provider: later });
      const [secondConfig, secondRuntime] = fixture.createEngine.mock.calls[0]
        .slice(0, 2)
        .map((value: string) => JSON.parse(value));
      expect(secondRuntime.model).toBe('later-agent-model');
      expect(secondConfig.model_reasoning_summary).toBe('detailed');
      release.resolve();
      first = await opening;
      const [firstConfig, firstRuntime] = fixture.createEngine.mock.calls[1]
        .slice(0, 2)
        .map((value: string) => JSON.parse(value));
      expect(firstRuntime.model).toBe('captured-model');
      expect(firstConfig.model_reasoning_effort).toBe('low');
      expect(firstConfig.model_reasoning_summary).toBeUndefined();
      expect(selected._acquire).toHaveBeenCalledTimes(1);
      expect(later._acquire).toHaveBeenCalledTimes(1);
      expect(firstRuntime.codex_home).not.toBe(secondRuntime.codex_home);
    } finally {
      release.resolve();
      first ??= await opening;
      await Promise.all([first.close(), second?.close()]);
      await Promise.all([
        selected.close(),
        later.close(),
        agent.provider.close(),
      ]);
    }
  });

  it.each([{ model: 'override' }, { modelSettings: {} }])(
    'rejects portable state with %o before provider acquisition',
    async (override) => {
      const agent = new Agent({ instructions: 'Answer.' });
      const selected = provider();
      const acquire = vi.spyOn(agent.provider, '_acquire');
      await expect(
        agent.session({ state: {} as never, provider: selected, ...override }),
      ).rejects.toThrow('cannot be used with state');
      expect(fixture.preflight).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(selected._acquire).not.toHaveBeenCalled();
      await Promise.all([agent.provider.close(), selected.close()]);
    },
  );

  it('restores using the selected current provider without adding opening fields to checkpoint state', async () => {
    const state = parseSessionState(
      JSON.stringify({
        format_version: 2,
        codex_revision: CODEX_REVISION,
        source_session_id: 'saved-root',
        root_metadata: {},
        history: [],
        managed_tool_specs: [],
        agent_options: {},
      }),
    );
    const original = structuredClone(state);
    const selected = provider();
    const agent = new Agent({ instructions: 'Answer.' });
    const acquire = vi.spyOn(agent.provider, '_acquire');
    const session = await agent.session({
      state,
      provider: selected,
      model: undefined,
      modelSettings: undefined,
    });
    expect(selected._acquire).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
    expect(state).toEqual(original);
    expect(state.agent_options).toEqual({});
    await session.close();
    await Promise.all([selected.close(), agent.provider.close()]);
  });

  it.each([
    { provider: () => new NativeProvider() },
    { provider: null },
    { model: null },
    { modelSettings: null },
    { modelSettings: [] },
    { modelSettings: { unknown: undefined } },
    { modelSettings: { reasoningEffort: null } },
    { modelSettings: { reasoningSummary: 1 } },
  ])(
    'rejects unsupported opening options %o before acquisition',
    async (options) => {
      const agent = new Agent({ instructions: 'Answer.' });
      const acquire = vi.spyOn(agent.provider, '_acquire');
      await expect(agent.session(options as never)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(fixture.preflight).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      await agent.provider.close();
    },
  );

  it('merges non-enumerable own settings, including an explicit tier clear', async () => {
    const agent = new Agent({
      instructions: 'Answer.',
      modelSettings: { reasoningEffort: 'low', serviceTier: 'flex' },
    });
    const modelSettings: ModelSettings = {};
    Object.defineProperties(modelSettings, {
      reasoningEffort: { value: 'high' },
      serviceTier: { value: null },
    });
    const session = await agent.session({ modelSettings });
    try {
      const config = JSON.parse(fixture.createEngine.mock.calls[0][0]);
      expect(config).toMatchObject({ model_reasoning_effort: 'high' });
      expect(config).not.toHaveProperty('service_tier');
      expect(fixture.start).toHaveBeenCalledWith({
        reasoningEffort: 'high',
        serviceTier: null,
      });
      expect(agent.modelSettings).toEqual({
        reasoningEffort: 'low',
        serviceTier: 'flex',
      });
    } finally {
      await session.close();
      await agent.provider.close();
    }
  });

  it('rejects a non-enumerable unknown own setting even when undefined', async () => {
    const selected = provider();
    const agent = new Agent({ instructions: 'Answer.' });
    const modelSettings = Object.defineProperty({}, 'unknown', {
      value: undefined,
    });
    let opened: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      await expect(
        agent.session({ provider: selected, modelSettings }).then((session) => {
          opened = session;
          return session;
        }),
      ).rejects.toThrow('Unsupported model setting: unknown');
      expect(fixture.preflight).not.toHaveBeenCalled();
      expect(selected._acquire).not.toHaveBeenCalled();
    } finally {
      await opened?.close();
      await Promise.all([selected.close(), agent.provider.close()]);
    }
  });

  it('uses an opening model for existing NativeAgents admission', async () => {
    const agent = new Agent({
      instructions: 'Answer.',
      tools: [new NativeAgents()],
    });
    const session = await agent.session({
      model: 'compatible-model',
      environment: new Environment({
        url: 'wss://executor.invalid',
        cwd: '/workspace',
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect(JSON.parse(fixture.createEngine.mock.calls[0][1]).model).toBe(
      'compatible-model',
    );
    await session.close();
    await agent.provider.close();
  });

  it('forwards NativeAgents portable state to native model admission without requiring an Agent model', async () => {
    const state = parseSessionState(
      JSON.stringify({
        format_version: 2,
        codex_revision: CODEX_REVISION,
        source_session_id: 'saved-root',
        root_metadata: {},
        history: [],
        managed_tool_specs: [],
        agent_options: {},
      }),
    );
    const selected = provider();
    const agent = new Agent({
      instructions: 'Answer.',
      tools: [new NativeAgents()],
    });
    const environment = new Environment({
      url: 'wss://executor.invalid',
      cwd: '/workspace',
      // This markerless fixture tests native model admission through legacy restore.
      writePolicy: 'legacy',
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    await expect(agent.session({ environment })).rejects.toThrow(
      'requires an explicit compatible model',
    );
    await expect(agent.session({ state })).rejects.toThrow(
      'requires an Environment',
    );
    for (const conflict of [{ model: 'override' }, { modelSettings: {} }])
      await expect(
        agent.session({ state, environment, provider: selected, ...conflict }),
      ).rejects.toThrow('cannot be used with state');
    expect(fixture.preflight).not.toHaveBeenCalled();
    expect(selected._acquire).not.toHaveBeenCalled();
    const restored = await agent.session({
      state,
      environment,
      provider: selected,
    });
    try {
      expect(
        JSON.parse(fixture.createEngine.mock.calls[0][1]).model,
      ).toBeUndefined();
      expect(selected._acquire).toHaveBeenCalledTimes(1);
      expect(agent.model).toBeUndefined();
    } finally {
      await restored.close();
      await Promise.all([selected.close(), agent.provider.close()]);
    }
  });

  it('forwards one-shot overrides through the captured Session factory and releases their leases', async () => {
    const selected = provider();
    const agent = new Agent({ instructions: 'Answer.' });
    const factory = vi.spyOn(agent, 'session');
    const options = {
      provider: selected,
      model: 'one-shot-model',
      modelSettings: { serviceTier: null },
    };
    for (const run of [
      () => agent.run('Answer.', options),
      () => Runner.run(agent, 'Answer.', options),
    ])
      expect((await run()).finalOutput).toBe('synthetic answer');
    expect(factory).toHaveBeenCalledTimes(2);
    for (const [captured] of factory.mock.calls)
      expect(captured).toMatchObject(options);
    expect(fixture.sessionClose).toHaveBeenCalledTimes(2);
    expect(agent.provider).not.toBe(selected);
    await Promise.all([selected.close(), agent.provider.close()]);
  });

  it('retains failed opening cleanup on the selected provider and leaves the default reusable', async () => {
    const selected = provider();
    const agent = new Agent({ instructions: 'Answer.' });
    const original = new Error('selected startup failed');
    fixture.bind.mockRejectedValueOnce(original);
    fixture.engineClose.mockRejectedValueOnce(new Error('cleanup incomplete'));
    const failure = await agent
      .session({ provider: selected })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(original);
    const unaffected = await agent.session();
    await unaffected.close();
    await selected.close();
    expect(fixture.bind).toHaveBeenCalledTimes(2);
    expect(fixture.engineClose).toHaveBeenCalledTimes(2);
    await agent.provider.close();
  });
});
afterEach(async () => {
  // Fixture cleanup only: these tests never create a native engine or thread.
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
});

describe('retained opening cleanup without loading native code', () => {
  it('preserves successful opening and refuses to close a live provider', async () => {
    const connection = provider();
    const session = await opening(connection);
    await expect(connection.close()).rejects.toThrow(
      'open or opening sessions',
    );
    await session.close();
    await connection.close();
    expect(fixture.sessionClose).toHaveBeenCalledTimes(1);
  });

  it('throws the original opening error after successful partial cleanup', async () => {
    const connection = provider();
    const original = new Error('bind failed');
    fixture.bind.mockRejectedValueOnce(original);
    await expect(opening(connection)).rejects.toBe(original);
    expect(fixture.engineClose).toHaveBeenCalledTimes(1);
    expect(fixture.carrierClose).toHaveBeenCalledTimes(1);
    await connection.close();
    expect(fixture.engineClose).toHaveBeenCalledTimes(1);
  });

  it('retains partial opening and joins provider retries at the failed phase', async () => {
    const connection = provider();
    const original = new Error('bind failed');
    const incomplete = new Error('engine still running');
    const gate = deferred();
    fixture.bind.mockRejectedValueOnce(original);
    fixture.engineClose.mockRejectedValueOnce(incomplete);
    const failure = await opening(connection).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(original);
    expect((failure as AggregateError).errors).toEqual([original, incomplete]);
    const runtime = JSON.parse(fixture.createEngine.mock.calls[0][1]);
    await access(runtime.codex_home);
    expect(fixture.carrierClose).not.toHaveBeenCalled();
    fixture.engineClose.mockImplementationOnce(() => gate.promise);
    const first = connection.close();
    const joined = connection.close();
    await Promise.resolve();
    expect(fixture.engineClose).toHaveBeenCalledTimes(2);
    expect(() => connection._acquire()).toThrow('closed');
    gate.resolve();
    await Promise.all([first, joined]);
    expect(fixture.carrierClose).toHaveBeenCalledTimes(1);
    await expect(access(runtime.codex_home)).rejects.toThrow();
    await connection.close();
    expect(fixture.engineClose).toHaveBeenCalledTimes(2);
  });

  it('retains a carrier whose start rejected and retries only its cleanup', async () => {
    const connection = provider();
    const original = new Error('carrier start failed');
    const incomplete = new Error('carrier close failed');
    fixture.carrierStart.mockRejectedValueOnce(original);
    fixture.carrierClose.mockRejectedValueOnce(incomplete);
    const failure = await opening(connection).catch((error: unknown) => error);
    expect((failure as AggregateError).cause).toBe(original);
    await connection.close();
    expect(fixture.carrierStart).toHaveBeenCalledTimes(1);
    expect(fixture.carrierClose).toHaveBeenCalledTimes(2);
    expect(fixture.createEngine).not.toHaveBeenCalled();
  });

  it('retains the Session owner when initialization and its cleanup fail', async () => {
    const connection = provider();
    const original = new Error('initialization failed');
    const incomplete = new Error('session close incomplete');
    fixture.start.mockRejectedValueOnce(original);
    fixture.sessionClose.mockRejectedValueOnce(incomplete);
    const failure = await opening(connection).catch((error: unknown) => error);
    expect((failure as AggregateError).errors).toEqual([original, incomplete]);
    await connection.close();
    expect(fixture.sessionClose).toHaveBeenCalledTimes(2);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.createEngine).toHaveBeenCalledTimes(1);
  });

  it('does not retain a released lease after a completed cleanup diagnostic', async () => {
    const connection = provider();
    const original = new Error('initialization failed');
    const diagnostic = new Error('completed cleanup diagnostic');
    fixture.start.mockRejectedValueOnce(original);
    fixture.sessionClose.mockImplementationOnce(async (options) => {
      await options.onClose?.();
      throw diagnostic;
    });
    const failure = await opening(connection).catch((error: unknown) => error);
    expect((failure as AggregateError).errors).toEqual([original, diagnostic]);
    await connection.close();
    expect(fixture.sessionClose).toHaveBeenCalledTimes(1);
  });

  it('refuses provider close while another opening still owns a lease', async () => {
    const connection = provider();
    const failed = connection._acquire();
    const active = connection._acquire();
    let attempts = 0;
    failed.retainOpeningCleanup(async () => {
      if (++attempts === 1) throw new Error('incomplete');
      await failed.release();
    });
    await expect(
      failed.failOpening(new Error('opening')),
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(connection.close()).rejects.toThrow(
      'open or opening sessions',
    );
    expect(attempts).toBe(1);
    await active.release();
    await connection.close();
    expect(attempts).toBe(2);
  });

  it('preserves preparation errors and releases their allocated directory', async () => {
    const connection = provider();
    const acquire = NativeProvider.prototype._acquire.bind(connection);
    const original = new Error('preparation failed');
    let home: string | undefined;
    vi.mocked(connection._acquire).mockImplementation(() => {
      const lease = acquire();
      leases.push(lease);
      const open = lease.open;
      lease.open = async () => {
        const runtime = await open();
        home = runtime.codex_home;
        throw original;
      };
      return lease;
    });
    await expect(opening(connection)).rejects.toBe(original);
    expect(home).toBeDefined();
    await expect(access(home!)).rejects.toThrow();
    await connection.close();
    expect(fixture.createEngine).not.toHaveBeenCalled();
  });
});
