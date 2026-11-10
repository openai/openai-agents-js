import {
  attachPrivateRuntime,
  privateRuntime,
  finishPrivateRuntime,
} from './private-engine-reuse';
import { RunCleanupError } from './native-error';
import { captureInitialMessages } from './initial-messages';
import { projectProfileCatalog } from './agent-profiles';
import { captureTraceContext } from './trace-context';
import { networkPolicyDigest } from './network-policy';
import { localRecoveryRequired } from './local-recovery';
import { assertCheckpointNetworkPolicy } from './state';
import {
  assertCheckpointSelections,
  checkpointResourceServers,
} from './selection-state';
import { readCheckpointSelections } from './state';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  binding,
  decode,
  encode,
  encodeReceipt,
  losslessJsonObjectSchema as jsonObject,
  losslessJsonValueSchema as jsonValue,
  type JsonValue,
} from './binding';
import type { NativeConfig } from './config';
import type { RuntimeOptions, ThreadOptions } from './options';
import { captureTools, type SessionTool, type ToolCatalog } from './tools';
import { manualResultSchema, supportsManualCheckpoint } from './manual';
import {
  Session,
  InteractionRequired,
  NativeError,
  type SessionOptions,
  type OneShotOptions,
  type Completed,
} from './session';
import {
  sessionStateSchema,
  isManualSessionState,
  nativeCheckpoint,
} from './state';
import { environmentConfig, projectSearchRuntime } from './environment';
import { NativeProviderRoutes } from './http-model';
import type { ProviderLease } from './provider';
import { AsyncResource } from 'node:async_hooks';
import { releaseEnvironmentBeforeProvider } from './environment-source';

/** @internal Captured application declarations and SDK-owned native configuration. */
export interface SessionSetup {
  name: string;
  instructions: string;
  model?: string;
  tools: readonly SessionTool[];
  config: NativeConfig;
  runtime: RuntimeOptions;
  threadOptions: ThreadOptions;
  apiKey?: string;
  /** Live application capability, excluded from persisted config/runtime. */
  applicationAppsJson?: string;
}

/** @internal Open one native Session from the public Agent's captured declaration. */
export async function openSession(
  setup: SessionSetup,
  options: SessionOptions,
  lease: ProviderLease,
  oneShot?: OneShotOptions,
  catalog: ToolCatalog = captureTools(setup.tools),
): Promise<Session> {
  const { initialMessages, ...liveOptions } = options;
  const capturedInitialMessages = captureInitialMessages(
    initialMessages,
    options.state,
    setup.threadOptions._sdk_resume_thread_id,
  );
  options = liveOptions;
  const { model, config, apiKey } = setup;
  let instructions = setup.instructions;
  // Keep the full declaration for profile checks, updates and checkpoints.
  // Only native construction defers MCP until the Session owns its reader.
  const initialConfig: NativeConfig = { ...config, mcp_servers: {} };
  const environment = options.environment;
  const saved =
    options.state == null ? null : sessionStateSchema.parse(options.state);
  if (oneShot) {
    if (isManualSessionState(saved)) {
      if (oneShot.input != null)
        throw new TypeError(
          'Use null input to resume a pending manual checkpoint',
        );
      if (!options.onInteraction) throw new InteractionRequired(saved);
    } else if (oneShot.input == null) {
      throw new TypeError(
        'Input is required unless resuming a pending manual checkpoint',
      );
    }
  }
  assertCheckpointNetworkPolicy(
    saved,
    networkPolicyDigest(environment?.network),
  );
  if (
    saved !== null &&
    (saved.executor_policy_digest !== undefined) !==
      (environment != null && environment.writePolicy !== 'legacy')
  ) {
    throw new TypeError(
      'Restore requires the recorded executor write and network policy',
    );
  }
  if (
    saved !== null &&
    (saved.executor_read_only ?? false) !== (environment?.readOnly ?? false)
  )
    throw new TypeError(
      'Checkpoint and Environment must agree on read-only execution',
    );
  const native = await binding();
  const restoredSource = saved && options.agentGraph?.restoredSource;
  if (restoredSource) {
    // The pure preflight verified this graph and the exact accepted envelope.
    // Validate fresh tool/manual schemas against its producing Agent, preserving
    // accepted instruction overrides rather than comparing root defaults.
    const profile = options.agentGraph!.profiles.get(
      restoredSource.profile_id,
    )!;
    catalog = projectProfileCatalog(profile.catalog, saved.managed_tool_specs);
    instructions = native._read_session_instructions(encode(saved.history));
  }
  const restoredMcp = restoredSource
    ? options.agentGraph!.profiles.get(restoredSource.profile_id)!.mcp
    : (options.mcpTools ?? []);
  const { _sdk_project_search: _previousSearch, ...baseRuntime } =
    setup.runtime;
  let runtime: RuntimeOptions = {
    ...native._packaged_runtime(),
    ...baseRuntime,
    ...(model === undefined ? {} : { model }),
    ...(environment ? { environment: environmentConfig(environment) } : {}),
    ...projectSearchRuntime(environment),
  };
  const parentTrace = captureTraceContext(options.parentTrace);
  const { _sdk_reconciled_calls, ...capturedThreadOptions } =
    setup.threadOptions;
  let threadOptions: ThreadOptions = {
    ...(parentTrace ? { parent_trace: { ...parentTrace.toHeaders() } } : {}),
    ...capturedThreadOptions,
    ...(options.localStorage
      ? {}
      : {
          client_mcp_extensions: {
            'openai/form': {},
            'openai/elicitation': {
              form: {},
              ...(setup.applicationAppsJson === undefined
                ? {}
                : { userVerification: {} }),
            },
            'openai/sdk-root-prompts': {},
            ...(options.nativeAgents?.interactions
              ? { 'openai/sdk-child-prompts': {} }
              : {}),
          },
        }),
    _managed_instructions: true,
    config,
    runtime,
    instructions,
  };
  if (saved) {
    checkpointResourceServers(
      readCheckpointSelections(saved).default_resource_servers,
      restoredMcp,
    );
    const policy = threadOptions.tool_policy;
    assertCheckpointSelections(
      readCheckpointSelections(saved),
      catalog,
      policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy.allowed_tools
        : undefined,
      isManualSessionState(saved)
        ? saved.manual_continuation.pending_manual
        : [],
    );
  }
  if (saved && !restoredSource)
    native._validate_application_instructions(
      encode(saved.history),
      instructions,
    );
  const manualTools = catalog.tools.filter((tool) => tool.kind === 'manual');
  if (isManualSessionState(saved)) {
    if (
      saved.format_version === 3 &&
      (options.restoredOutput?.output ?? options.output)?.schema != null
    )
      throw new TypeError(
        'Cannot resume a pending manual checkpoint with a structured output schema',
      );
    const pending = saved.manual_continuation.pending_manual;
    const schemas = pending.map((call) => {
      const tool = manualTools.find(
        (tool) =>
          tool.name === call.name &&
          (call.namespace === undefined || call.namespace === 'functions'),
      );
      return tool
        ? { name: tool.name, schema: manualResultSchema(tool) }
        : undefined;
    });
    const expected = pending.map((call) =>
      saved.manual_context.result_schemas.find(
        (tool) =>
          tool.name === call.name &&
          (tool.namespace ?? 'functions') === (call.namespace ?? 'functions'),
      ),
    );
    if (
      (!restoredSource && saved.manual_context.instructions !== instructions) ||
      schemas.some((tool) => tool === undefined) ||
      expected.some((tool) => tool === undefined) ||
      !isDeepStrictEqual(expected, schemas)
    )
      throw new TypeError(
        'Manual checkpoint requires matching current instructions and manual result declarations',
      );
    const prior = z.array(jsonObject).parse(saved.managed_tool_specs);
    const current = decode(z.array(jsonObject), catalog.specsJson);
    for (const call of pending) {
      const select = (specs: typeof prior) =>
        specs.find(
          (spec) => spec.type === 'function' && spec.name === call.name,
        );
      const oldSpec = select(prior);
      const currentSpec = select(current);
      if (!oldSpec || !currentSpec || !isDeepStrictEqual(oldSpec, currentSpec))
        throw new TypeError(
          'Manual checkpoint requires matching pending tools',
        );
    }
  } else if (
    saved &&
    !isDeepStrictEqual(
      saved.managed_tool_specs,
      decode(jsonValue, catalog.specsJson),
    )
  ) {
    throw new TypeError(
      'Checkpoint requires currently supplied matching managed tools',
    );
  }
  if (
    oneShot &&
    manualTools.length &&
    !options.onInteraction &&
    (!supportsManualCheckpoint(threadOptions, !!environment) ||
      options.output?.schema != null)
  )
    throw new InteractionRequired();

  const checkpointJson = saved
    ? encodeReceipt(nativeCheckpoint(saved))
    : undefined;
  const freshManual = isManualSessionState(saved);
  const borrow = lease.privateRuntime;
  const idle = borrow?.peek();
  let carrier = idle?.carrier ?? new NativeProviderRoutes();
  let engine: import('./binding').Engine | undefined = idle?.engine;
  let thread: import('./binding').NativeThread | undefined;
  let phase: 'native' | 'engine' | 'carrier' | 'provider' = 'native';
  let completedFailure: NativeError | undefined;
  lease.retainOpeningCleanup(async () => {
    if (phase === 'native') {
      const message = await thread?._close_report();
      if (message) completedFailure ??= new NativeError(message);
      phase = 'engine';
    }
    if (phase === 'engine') {
      if (borrow?.peek()) {
        await borrow.finish(false);
        phase = 'provider';
      } else {
        const message = await engine?._close_report();
        if (message) completedFailure ??= new NativeError(message);
        phase = 'carrier';
      }
    }
    if (phase === 'carrier') {
      await carrier.close();
      phase = 'provider';
    }
    await releaseEnvironmentBeforeProvider(
      options.environmentOwner,
      lease.release,
    );
    if (completedFailure) throw completedFailure;
  });
  if (idle) {
    const holder = lease.httpTransports(
      native._create_provider_http_transports,
      idle.engine,
    );
    const binding = idle.carrier.reuseBinding(idle.engine);
    thread =
      holder === idle.transports && apiKey === idle.apiKey && binding
        ? ((await idle.engine._private_start_thread(
            encode(initialConfig),
            encode(runtime),
            binding.origin,
            binding.grant,
            encode({ ...threadOptions, config: initialConfig }),
            catalog.specsJson,
          )) ?? undefined)
        : undefined;
    if (!thread) {
      const home = await borrow!.reset();
      runtime = { ...runtime, ...home };
      carrier = new NativeProviderRoutes();
      engine = undefined;
    }
    threadOptions = { ...threadOptions, runtime };
  }
  if (!engine) {
    await carrier.start(config, runtime, apiKey);
    options.environmentOwner?.signal.throwIfAborted();
    engine = saved
      ? await native.create_checkpoint_engine(
          encode(initialConfig),
          encode(runtime),
          apiKey ?? null,
          checkpointJson,
          catalog.specsJson,
          freshManual,
          setup.applicationAppsJson ?? null,
        )
      : options.customStore
        ? await native.create_store_engine(
            encode(initialConfig),
            encode(runtime),
            apiKey ?? null,
            options.customStore,
            setup.applicationAppsJson ?? null,
          )
        : await native.create_engine(
            encode(initialConfig),
            encode(runtime),
            apiKey ?? null,
            setup.applicationAppsJson ?? null,
          );
    options.environmentOwner?.signal.throwIfAborted();
    const transports = lease.httpTransports(
      native._create_provider_http_transports,
      engine,
    );
    await carrier.bindEngine(engine, transports);
    if (borrow && transports && engine._private_reuse_ready)
      borrow.bind(engine, carrier, transports);
  }
  options.environmentOwner?.signal.throwIfAborted();
  if (!thread) {
    if (saved) {
      thread = await engine.restore_checkpoint(
        checkpointJson!,
        encode({ ...threadOptions, config: initialConfig }),
        catalog.specsJson,
        freshManual,
      );
    } else if (threadOptions._sdk_resume_thread_id !== undefined) {
      const opened = await engine._start_local_resume(
        encode({
          ...threadOptions,
          config: initialConfig,
          ...(_sdk_reconciled_calls === undefined
            ? {}
            : { _sdk_reconciled_calls }),
        }),
        catalog.specsJson,
      );
      if (typeof opened === 'string')
        throw localRecoveryRequired(
          opened,
          threadOptions._sdk_resume_thread_id,
        );
      thread = opened;
    } else {
      thread =
        capturedInitialMessages === undefined
          ? await engine.start_replaceable_thread(
              encode({ ...threadOptions, config: initialConfig }),
              catalog.specsJson,
            )
          : await engine._start_seeded_replaceable_thread(
              encode({ ...threadOptions, config: initialConfig }),
              catalog.specsJson,
              encode(capturedInitialMessages),
            );
    }
  }
  const session = new Session(
    engine,
    thread,
    catalog,
    options,
    threadOptions,
    saved,
    carrier,
    environment ?? null,
    oneShot,
    apiKey,
  );
  if (borrow?.peek()) attachPrivateRuntime(session, borrow);
  lease.retainOpeningCleanup(() =>
    privateRuntime(session)
      ? closePrivateOwnedRuntime(session, false)
      : session.close(),
  );
  options.environmentOwner?.attachSession(session);
  options.environmentOwner?.signal.throwIfAborted();
  await session._start();
  if (isManualSessionState(saved))
    await session._restoreManualContinuation(saved);
  return session;
}

async function closePrivateOwnedRuntime(
  session: Session<any>,
  keep: boolean,
): Promise<void> {
  await session.close();
  await finishPrivateRuntime(session, keep);
}

interface OwnedRunOptions {
  returnState?: boolean;
  signal?: AbortSignal;
  maxModelSteps?: number;
  budget?: import('./run-budget').RunBudgetTracker;
}

/** @internal Complete and close the Session owned by a one-shot run. */
export async function runOwnedSession<Output>(
  session: Session<Output>,
  input: string | JsonValue[] | null,
  options: OwnedRunOptions = {},
): Promise<Completed<Output>> {
  const cancellation: { rejection?: unknown; reason?: unknown } = {};
  const retire = AsyncResource.bind(() => {
    void session
      ._closeOwnedRun((rejection) => {
        cancellation.rejection = rejection;
        cancellation.reason = options.signal!.reason;
      })
      .catch(() => {});
  });
  options.signal?.addEventListener('abort', retire, { once: true });
  if (options.signal?.aborted) retire();
  try {
    return await completeOwnedSession(session, input, options, cancellation);
  } finally {
    options.signal?.removeEventListener('abort', retire);
  }
}

async function completeOwnedSession<Output>(
  session: Session<Output>,
  input: string | JsonValue[] | null,
  options: OwnedRunOptions,
  cancellation: { rejection?: unknown; reason?: unknown },
): Promise<Completed<Output>> {
  const closeOwned = () =>
    privateRuntime(session)
      ? closePrivateOwnedRuntime(session, false)
      : session.close();
  const originalFailure = (error: unknown) =>
    cancellation.rejection !== undefined &&
    Object.is(error, cancellation.rejection)
      ? cancellation.reason
      : error;
  if (options.signal?.aborted) {
    try {
      await closeOwned();
    } catch (cleanupError) {
      throw new RunCleanupError(
        [options.signal.reason, cleanupError],
        'Native run cancelled and cleanup failed',
        closeOwned,
        { cause: options.signal.reason },
      );
    }
    throw options.signal.reason;
  }
  const result = await (
    input == null
      ? session.wait()
      : session
          ._run(input, options.signal, options.maxModelSteps, options.budget)
          .then(() => session.wait())
  ).catch(async (error) => {
    const primary = originalFailure(error);
    try {
      await closeOwned();
    } catch (cleanupError) {
      throw new RunCleanupError(
        [primary, cleanupError],
        'Native run failed and its owned cleanup is incomplete',
        closeOwned,
        { cause: primary },
      );
    }
    throw primary;
  });
  try {
    options.signal?.throwIfAborted();
    const completed = options.returnState
      ? Object.freeze({ ...result, state: await session.saveState() })
      : result;
    await session.close();
    options.signal?.throwIfAborted();
    if (privateRuntime(session)) await finishPrivateRuntime(session, true);
    return completed;
  } catch (error) {
    const primary = originalFailure(error);
    try {
      await closeOwned();
    } catch (cleanupError) {
      throw new RunCleanupError(
        [primary, cleanupError],
        'Run completion and cleanup failed',
        closeOwned,
        { cause: primary },
      );
    }
    throw primary;
  }
}
