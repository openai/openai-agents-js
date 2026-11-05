import { networkPolicyDigest } from './network-policy';
import { localRecoveryRequired } from './local-recovery';
import { assertCheckpointNetworkPolicy } from './state';
import { assertCheckpointSelections } from './selection-state';
import { readCheckpointSelections } from './state';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  binding,
  decode,
  encode,
  encodeReceipt,
  jsonObject,
  jsonValue,
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
import { environmentConfig } from './environment';
import { NativeProviderRoutes, type SelectedModelRoute } from './http-model';
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
  selectedModel?: SelectedModelRoute;
}

/** @internal Open one native Session from the public Agent's captured declaration. */
export async function openSession(
  setup: SessionSetup,
  options: SessionOptions,
  lease: ProviderLease,
  oneShot?: OneShotOptions,
  catalog: ToolCatalog = captureTools(setup.tools),
): Promise<Session> {
  const { instructions, model, config, apiKey } = setup;
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
      if (!oneShot.onRequiredAction) throw new InteractionRequired(saved);
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
    saved.executor_policy_digest === undefined &&
    (environment?.kind === 'local' || environment?.writableRoots !== undefined)
  ) {
    throw new TypeError(
      'Restore requires the recorded executor write and network policy',
    );
  }
  const native = await binding();
  const runtime: RuntimeOptions = {
    ...native._packaged_runtime(),
    ...setup.runtime,
    ...(model === undefined ? {} : { model }),
    ...(environment ? { environment: environmentConfig(environment) } : {}),
  };
  const { _sdk_reconciled_calls, ...capturedThreadOptions } =
    setup.threadOptions;
  const threadOptions: ThreadOptions = {
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
  if (saved)
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
      saved.manual_context.instructions !== instructions ||
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
    !oneShot.onRequiredAction &&
    (!supportsManualCheckpoint(threadOptions, !!environment) ||
      options.output?.schema != null)
  )
    throw new InteractionRequired();

  const checkpointJson = saved
    ? encodeReceipt(nativeCheckpoint(saved))
    : undefined;
  const freshManual = isManualSessionState(saved);
  const carrier = new NativeProviderRoutes(setup.selectedModel);
  let engine: import('./binding').Engine | undefined = undefined;
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
      const message = await engine?._close_report();
      if (message) completedFailure ??= new NativeError(message);
      phase = 'carrier';
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
    : await native.create_engine(
        encode(initialConfig),
        encode(runtime),
        apiKey ?? null,
        setup.applicationAppsJson ?? null,
      );
  options.environmentOwner?.signal.throwIfAborted();
  await carrier.bindEngine(engine);
  options.environmentOwner?.signal.throwIfAborted();
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
      throw localRecoveryRequired(opened, threadOptions._sdk_resume_thread_id);
    thread = opened;
  } else {
    thread = await engine.start_replaceable_thread(
      encode({ ...threadOptions, config: initialConfig }),
      catalog.specsJson,
    );
  }
  if (setup.selectedModel)
    setup.selectedModel.bindRoot(thread._selected_model_root());
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
  lease.retainOpeningCleanup(() => session.close());
  options.environmentOwner?.attachSession(session);
  options.environmentOwner?.signal.throwIfAborted();
  await session._start();
  if (isManualSessionState(saved))
    await session._restoreManualContinuation(saved);
  return session;
}

/** @internal Complete and close the Session owned by a one-shot run. */
export async function runOwnedSession<Output>(
  session: Session<Output>,
  input: string | JsonValue[] | null,
  options: {
    returnState?: boolean;
    signal?: AbortSignal;
    maxModelSteps?: number;
  } = {},
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
  options: {
    returnState?: boolean;
    signal?: AbortSignal;
    maxModelSteps?: number;
  },
  cancellation: { rejection?: unknown; reason?: unknown },
): Promise<Completed<Output>> {
  const originalFailure = (error: unknown) =>
    cancellation.rejection !== undefined &&
    Object.is(error, cancellation.rejection)
      ? cancellation.reason
      : error;
  if (options.signal?.aborted) {
    try {
      await session.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [options.signal.reason, cleanupError],
        'Native run cancelled and cleanup failed',
        { cause: options.signal.reason },
      );
    }
    throw options.signal.reason;
  }
  const result = await (
    input == null
      ? session.wait()
      : session
          ._run(input, options.signal, options.maxModelSteps)
          .then(() => session.wait())
  ).catch(async (error) => {
    const primary = originalFailure(error);
    try {
      await session.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        'Native run failed and its owned cleanup is incomplete',
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
    return completed;
  } catch (error) {
    const primary = originalFailure(error);
    try {
      await session.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        'Run completion and cleanup failed',
        { cause: primary },
      );
    }
    throw primary;
  }
}
