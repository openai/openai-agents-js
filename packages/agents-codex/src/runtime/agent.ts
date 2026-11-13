import { configuredAgentTool } from './agent-tool';
import { MAX_AUDIO_INPUT_BYTES } from './media';
import { managedWorkspaceRestore } from './managed-workspace';
import {
  attachPrivateRuntime,
  privateRuntime,
  finishPrivateRuntime,
} from './private-engine-reuse';
import { RunCleanupError, RunDiagnosticError } from './native-error';
import { captureInitialMessages } from './initial-messages';
import { projectProfileCatalog } from './agent-profiles';
import { captureTraceContext } from './trace-context';
import { networkPolicyDigest } from './network-policy';
import { localRecoveryRequired } from './local-recovery';
import { hostedMcpConfigurations } from './hosted-mcp-binding';
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
  encode,
  encodeReceipt,
  losslessJsonObjectSchema as jsonObject,
  type JsonValue,
} from './binding';
import type { NativeConfig } from './config';
import type { RuntimeOptions, ThreadOptions } from './options';
import {
  captureTools,
  type SessionTool,
  type ToolCatalog,
  protocolToolSpecs,
} from './tools';
import { manualResultSchema, supportsManualCheckpoint } from './manual';
import {
  Session,
  InteractionRequired,
  NativeError,
  type SessionOptions,
  type OneShotOptions,
  type Completed,
  type CapturedInputStoragePolicy,
} from './session';
import {
  sessionStateSchema,
  isManualSessionState,
  isOutputAwareState,
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
  /** Live inference credential, excluded from persisted config/runtime. */
  plan?: { bearer: string; identity: string };
}

/** @internal Open one native Session from the public Agent's captured declaration. */
export async function openSession(
  setup: SessionSetup,
  options: SessionOptions,
  lease: ProviderLease,
  oneShot?: OneShotOptions,
  catalog: ToolCatalog = captureTools(setup.tools),
): Promise<Session> {
  const hostedMcp = hostedMcpConfigurations([
    ...catalog.tools,
    ...[...(options.agentGraph?.profiles.values() ?? [])].flatMap(
      (profile) => profile.catalog.tools,
    ),
  ]);
  const { initialMessages, verifyRememberedApprovals, ...liveOptions } =
    options;
  const audioBudget = { remaining: MAX_AUDIO_INPUT_BYTES };
  const capturedInitialMessages = captureInitialMessages(
    initialMessages,
    options.state,
    setup.threadOptions._sdk_resume_thread_id,
    audioBudget,
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
  const authenticatedHistory = options[managedWorkspaceRestore] === true;
  if (isOutputAwareState(saved) && saved.remembered_approvals?.length) {
    const verified = await verifyRememberedApprovals?.(structuredClone(saved));
    options.environmentOwner?.signal.throwIfAborted();
    if (verified !== true) {
      delete saved.remembered_approvals;
    }
  }
  if (saved && !authenticatedHistory) {
    // Imported history has been remaining usable without granting memory admission.
    for (const thread of [saved, ...saved.descendants]) {
      for (const item of thread.history) {
        const payload = item.payload;
        if (
          item.type !== 'turn_context' ||
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload)
        )
          continue;
        const receipt = payload.sdk_receipt;
        if (receipt && typeof receipt === 'object' && !Array.isArray(receipt))
          delete receipt.sandbox_memory_input_admitted;
      }
    }
  }
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
    ...(hostedMcp.length
      ? {
          _hosted_tools: [
            ...(capturedThreadOptions._hosted_tools ?? []),
            ...hostedMcp,
          ],
        }
      : {}),
    ...(options.environmentOwner?.workspaceInstructions === undefined
      ? {}
      : {
          user_instructions_appendix:
            options.environmentOwner.workspaceInstructions,
        }),
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
      !isOutputAwareState(saved) &&
      (options.restoredOutput?.output ?? options.output)?.schema != null
    )
      throw new TypeError(
        'Cannot resume a pending manual checkpoint with a structured output schema',
      );
    const pending = saved.manual_continuation.pending_manual;
    const schemas = pending.map((call) => {
      const tool = catalog.tools.find(
        (tool) =>
          (tool.kind === 'manual' || configuredAgentTool(tool) !== undefined) &&
          tool.name === call.name &&
          (call.namespace === undefined || call.namespace === 'functions'),
      );
      return tool
        ? {
            name: tool.name,
            schema:
              tool.kind === 'manual'
                ? manualResultSchema(tool)
                : configuredAgentTool(tool)!.resultSchema,
          }
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
    const current = protocolToolSpecs(catalog);
    for (const call of pending) {
      const select = (specs: typeof prior) =>
        specs.find((spec) =>
          call.shell
            ? call.name === 'shell' && spec.type === 'shell'
            : call.patch
              ? call.name === 'apply_patch' && spec.type === 'applyPatch'
              : spec.type === 'function' && spec.name === call.name,
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
    !isDeepStrictEqual(saved.managed_tool_specs, protocolToolSpecs(catalog))
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

  const nativeRestore = saved ? nativeCheckpoint(saved) : undefined;
  if (nativeRestore && options[managedWorkspaceRestore]) {
    if (
      !options.managedWorkspace?.authorizedReceipt ||
      environment?.writePolicy !== 'strict'
    )
      throw new TypeError(
        'Managed restore requires current strict workspace authority',
      );
    // Earlier preflight retains strictness, network and readOnly checks. Current
    // startup supplies authority; the paired workspace can relocate its cwd.
    delete nativeRestore.executor_policy_digest;
  }
  const checkpointJson = nativeRestore
    ? encodeReceipt(nativeRestore)
    : undefined;
  const freshManual = isManualSessionState(saved);
  const borrow = lease.privateRuntime;
  let idle = borrow?.peek();
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
  // Plain-only owners have been parking direct executions only. A fallback has
  // been receiving a fresh Engine/home instead of inheriting the parked kernel.
  if (borrow?.plainOnly && idle) {
    const home = await borrow.reset();
    runtime = { ...runtime, ...home };
    threadOptions = { ...threadOptions, runtime };
    idle = undefined;
    carrier = new NativeProviderRoutes();
    engine = undefined;
  }
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
    if (lease.codexLogin === undefined)
      await carrier.start(config, runtime, apiKey);
    options.environmentOwner?.signal.throwIfAborted();
    engine = setup.plan
      ? await native._create_plan_engine(
          encode(initialConfig),
          encode(runtime),
          setup.plan.bearer,
          setup.plan.identity,
          checkpointJson ?? null,
          saved ? catalog.specsJson : null,
          options.customStore ?? null,
        )
      : saved
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
    if (lease.codexLogin === undefined)
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
              encode(
                capturedInitialMessages,
                audioBudget.remaining === MAX_AUDIO_INPUT_BYTES
                  ? undefined
                  : MAX_AUDIO_INPUT_BYTES,
              ),
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
    lease.codexLogin === undefined ? carrier : undefined,
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
  if (oneShot?.returnRawUsage) session._startRawUsage();
  if (oneShot?.returnItems) session._startProducedItems();
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
  modelOverride?: string;
  modelSettingsOverride?: import('./provider').ModelSettings;
  toolNotFoundBehavior?: 'raise_error' | 'return_error_to_model';
  guardrailInput?: import('./input').UserInput;
  errorInput?: import('./input').UserInput | null;
  inputStoragePolicy?: CapturedInputStoragePolicy;
  returnState?: boolean;
  returnHistory?: boolean;
  returnRawUsage?: boolean;
  returnItems?: boolean;
  signal?: AbortSignal;
  maxModelSteps?: number;
  budget?: import('./run-budget').RunBudgetTracker;
}

async function captureRunHistory(session: Session<any>) {
  const { items } = await session._historyForReplay();
  return Object.freeze(
    items.filter(
      (item) =>
        item.type !== 'message' ||
        (item.role !== 'developer' && item.role !== 'system'),
    ),
  );
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
    delete options.guardrailInput;
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
  const pending = (async () => {
    if (options.returnRawUsage) session._startRawUsage();
    if (options.returnItems || options.errorInput !== undefined)
      session._startProducedItems();
    if (input != null) {
      await session._run(
        input,
        options.signal,
        options.maxModelSteps,
        options.budget,
        options.guardrailInput,
        options.errorInput ?? undefined,
        options.modelOverride,
        options.modelSettingsOverride,
        options.toolNotFoundBehavior,
        options.inputStoragePolicy,
      );
    }
    return session.wait();
  })();
  delete options.guardrailInput;
  const result = await pending.catch(async (error) => {
    let primary = originalFailure(error);
    if (options.errorInput !== undefined && !options.signal?.aborted) {
      try {
        const details = await session._captureRunErrorDetails(
          options.errorInput,
        );
        if (details) primary = new RunDiagnosticError(details, primary);
      } catch {
        // Preserve the original failure when evidence capture throws.
      }
    }
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
    const completed =
      options.returnState ||
      options.returnHistory ||
      options.returnRawUsage ||
      options.returnItems
        ? Object.freeze({
            ...result,
            ...(options.returnState
              ? { state: await session.saveState() }
              : {}),
            ...(options.returnHistory
              ? { history: await captureRunHistory(session) }
              : {}),
            ...(options.returnRawUsage
              ? { rawUsage: session._takeRawUsage(result.turn.turnId) }
              : {}),
            ...(options.returnItems
              ? { items: session._takeProducedItems(result.turn.turnId) }
              : {}),
          })
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
