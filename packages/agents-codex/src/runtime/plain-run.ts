import type { _PlainRun } from '../../native/index.js';
import type { SessionSetup } from './agent';
import { apiRateLimits, type ApiRateLimits } from './api-rate-limits';
import {
  binding,
  decodePlainRunObject,
  encode,
  type Engine,
  type JsonObject,
} from './binding';
import { NativeProviderRoutes } from './http-model';
import { nativeInput } from './input';
import {
  markNativeErrorNotStarted,
  nativeError,
  NativeError,
  RunCleanupError,
} from './native-error';
import { ObservationBuffer } from './observation';
import type { ProviderLease } from './provider';
import { decodeRequestMetadata } from './request-metadata';
import { projectResponseFactRecord } from './response-facts';
import { tokenUsageInfo, runUsageSnapshot } from './run-events';
import {
  issueTurn,
  StaleTurnError,
  type Completed,
  type SessionOptions,
  type TurnCompletion,
} from './session';

/** @internal One prepared owner; dispatch happens only after the opening handoff. */
export interface PreparedPlainRun {
  run(): Promise<Completed<string>>;
}

/** Build a real settled Turn without retaining the native owner or its lease. */
async function completedPlainRun(
  dto: JsonObject,
  retention: SessionOptions['observationRetention'],
): Promise<Completed<string>> {
  const { sessionId, turnId, submissionId, finalOutput } = dto;
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof turnId !== 'string' ||
    !turnId ||
    typeof submissionId !== 'string' ||
    !submissionId ||
    typeof finalOutput !== 'string' ||
    !Array.isArray(dto.events)
  )
    throw new NativeError('Invalid plain run result');
  // The dedicated plain bridge has been populating this DTO only from its
  // final observed response completion, independently of retained history.
  const threadUsage = tokenUsageInfo(dto.usage);
  const measuredUsage = runUsageSnapshot(
    threadUsage?.lastTokenUsage ?? null,
    1,
    threadUsage === null ? 1 : 0,
  );
  const observations = new ObservationBuffer(sessionId, { retention });
  const identity = { submissionId, turnId };
  let rates: ApiRateLimits = Object.freeze({});
  observations.append({ type: 'turn_started', ...identity });
  if (dto.eventsGap === true) observations.gap();
  for (const row of dto.events) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      typeof row.payload !== 'string'
    )
      throw new NativeError('Invalid plain run observation');
    if (
      ![
        'model_request_dispatching',
        'output_text_delta',
        'api_rate_limits',
        'token_count',
        'response_fact',
      ].includes(String(row.kind))
    )
      continue;
    const value = decodePlainRunObject(row.payload);
    switch (row.kind) {
      case 'model_request_dispatching': {
        const event = decodeRequestMetadata(value, submissionId);
        if (
          event &&
          'threadId' in event &&
          event.threadId === sessionId &&
          event.turnId === turnId
        )
          observations.append(event);
        break;
      }
      case 'output_text_delta':
        if (typeof value.itemId === 'string' && typeof value.delta === 'string')
          observations.append({
            type: 'output_text_delta',
            ...identity,
            itemId: value.itemId,
            delta: value.delta,
          });
        break;
      case 'api_rate_limits': {
        const snapshot = apiRateLimits(value);
        if (snapshot) {
          rates = snapshot;
          observations.append({
            type: 'api_rate_limits_updated',
            ...identity,
            snapshot,
          });
        }
        break;
      }
      case 'token_count': {
        const snapshot = apiRateLimits(value.api_rate_limits);
        if (snapshot) {
          rates = snapshot;
          observations.append({
            type: 'api_rate_limits_updated',
            ...identity,
            snapshot,
          });
        }
        if (value.info != null || value.rate_limits != null)
          observations.append({
            type: 'usage_updated',
            ...identity,
            usage: tokenUsageInfo(value.info),
          });
        break;
      }
      case 'response_fact': {
        const record = projectResponseFactRecord(value);
        if (record && record.threadId === sessionId && record.turnId === turnId)
          observations.append({ type: 'response_fact', ...identity, record });
        break;
      }
      // Native model metadata and item bookkeeping have no public Observation variant.
    }
  }
  rates = apiRateLimits(dto.apiRateLimits) ?? rates;
  observations.append({
    type: 'turn_finished',
    ...identity,
    status: 'completed',
  });
  observations.finish('closed');
  const settled = Promise.withResolvers<Completed<string>>();
  const turn = issueTurn<string>(
    sessionId,
    turnId,
    submissionId,
    () => settled.promise,
    (eventOptions) =>
      observations.events(eventOptions, {
        after: 0,
        includes: (event) =>
          'submissionId' in event && event.submissionId === submissionId,
        phase: () => 'ended',
      }),
    (input) => {
      nativeInput(input);
      return Promise.reject(new NativeError('Turn is no longer active'));
    },
    async (mode) => {
      if (mode !== 'force' && mode !== 'graceful')
        throw new TypeError('mode must be force or graceful');
    },
    undefined,
    {
      rootResultReady: () => true,
      runUsage: () => measuredUsage,
      notify: () => observations.notify(),
      rateLimits: () => rates,
      wait: async (_turn, { signal }, completion: TurnCompletion<string>) => {
        if (completion.outcome) return completion.promise;
        signal?.throwIfAborted();
        const aborted = Promise.withResolvers<never>();
        const abort = () => aborted.reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (completion.outcome) return await completion.promise;
          signal?.throwIfAborted();
          return await Promise.race([completion.promise, aborted.promise]);
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      },
    },
    (input) => {
      nativeInput(input);
      return Promise.reject(
        markNativeErrorNotStarted(
          new StaleTurnError('Turn is no longer active'),
        ),
      );
    },
  );
  const completed: Completed<string> = Object.freeze({
    turn,
    finalOutput,
    threadUsage,
    runUsage: measuredUsage,
    repairAttempts: Object.freeze([]),
    guardrailResults: Object.freeze([]),
  });
  // Ordinary Agent.run has already waited on its Turn before publishing Completed.
  // Prime the same settlement so an already-aborted later waiter sees that outcome first.
  const publicResult = turn.wait();
  settled.resolve(completed);
  return publicResult;
}

/** @internal Consume one canonical prepared opening; undefined leaves ordinary opening valid. */
export async function tryOpenPlainRun(
  setup: SessionSetup,
  options: SessionOptions,
  lease: ProviderLease,
  normalizedText: string,
  signal?: AbortSignal,
): Promise<PreparedPlainRun | undefined> {
  const settings = options.initialModelSettings;
  if (
    lease.chatGPT ||
    !lease.apiKey ||
    options.modelBackend ||
    options.beforeComplete ||
    options.inputGuardrails?.length ||
    options.outputGuardrails?.length ||
    options.agentInputGuardrails?.length ||
    options.agentOutputGuardrails?.length ||
    options.beforeCompact ||
    options.compaction ||
    options.transformContext ||
    options.hostedPrompt !== undefined ||
    options.tracingCapture ||
    options.parentTrace ||
    options.environment ||
    options.agentGraph ||
    options.localStorage ||
    options.customStore ||
    options.localResume ||
    options.state ||
    options.onInteraction ||
    options.initialMessages ||
    setup.tools.length ||
    setup.applicationAppsJson ||
    (settings &&
      Object.entries(settings).some(
        ([key, value]) => value !== undefined && key !== 'reasoningEffort',
      )) ||
    (settings?.reasoningEffort !== undefined &&
      typeof settings.reasoningEffort !== 'string')
  )
    return undefined;
  options.environmentOwner?.signal.throwIfAborted();
  const native = await binding();
  options.environmentOwner?.signal.throwIfAborted();
  const config = { ...setup.config, mcp_servers: {} };
  const runtime = {
    ...native._packaged_runtime(),
    ...setup.runtime,
    ...(setup.model === undefined ? {} : { model: setup.model }),
  };
  const borrow = lease.privateRuntime;
  const idle = borrow?.peek();
  let engine: Engine | undefined = idle?.engine;
  let carrier: NativeProviderRoutes | undefined = idle?.carrier;
  let owned: _PlainRun | undefined;
  let waiting: Promise<string> | undefined;
  let pooled = idle !== undefined;
  let phase:
    | 'request'
    | 'engine'
    | 'carrier'
    | 'environment'
    | 'provider'
    | 'borrow'
    | 'done' = 'request';
  let diagnostic: unknown;
  let environmentFailure: unknown;
  let cancellationError: unknown;
  const cancel = () => {
    borrow?.invalidate?.();
    try {
      owned?.cancel();
    } catch (error) {
      cancellationError = error;
    }
  };
  const cleanup = async (keep: boolean): Promise<void> => {
    if (phase === 'request') {
      if (owned) {
        const request = owned;
        if (!keep) cancel();
        let joined = false;
        try {
          await (waiting ??= request.wait());
          joined = true;
        } catch {
          /* Preserve the model/caller failure. */
        }
        // Joined terminal cleanup; synchronous stop on the success path.
        if (keep && joined) request.cancel();
        else await request.close();
        owned = undefined;
        waiting = undefined;
      }
      phase = 'engine';
    }
    if (phase === 'engine') {
      if (pooled) phase = 'environment';
      else {
        const report = await engine?._close_report();
        if (report) diagnostic ??= new NativeError(report);
        engine = undefined;
        phase = 'carrier';
      }
    }
    if (phase === 'carrier') {
      await carrier?.close();
      carrier = undefined;
      phase = 'environment';
    }
    if (phase === 'environment') {
      try {
        await options.environmentOwner?.dispose();
      } catch (error) {
        environmentFailure ??= error;
        diagnostic ??= error;
      }
      phase = 'provider';
    }
    if (phase === 'provider') {
      await (options.onClose ?? lease.release)();
      phase = 'borrow';
    }
    if (phase === 'borrow') {
      try {
        await borrow?.finish(
          keep &&
            !signal?.aborted &&
            (!borrow?.plainOnly ||
              (diagnostic === undefined &&
                environmentFailure === undefined &&
                cancellationError === undefined)),
          true,
        );
      } finally {
        if (!borrow || borrow.done) {
          engine = undefined;
          carrier = undefined;
          phase = 'done';
        }
      }
    }
    // Completed release reports are consumed once; failed environment disposal stays joinable.
    const completedDiagnostic = diagnostic ?? cancellationError;
    diagnostic = environmentFailure;
    cancellationError = undefined;
    if (completedDiagnostic !== undefined) throw completedDiagnostic;
  };
  const previousOpeningCleanup = lease.retainOpeningCleanup(() =>
    cleanup(false),
  );
  if (idle) {
    if (borrow?.concurrent && setup.apiKey !== idle.apiKey) {
      lease.retainOpeningCleanup(previousOpeningCleanup ?? lease.release);
      return undefined;
    }
    const transports = lease.httpTransports(
      native._create_provider_http_transports,
      idle.engine,
    );
    if (
      transports !== idle.transports ||
      setup.apiKey !== idle.apiKey ||
      !idle.engine._private_reuse_ready ||
      !idle.carrier.reuseBinding(idle.engine)
    ) {
      borrow?.invalidate?.();
      if (!borrow?.concurrent) idle.plainAdmission = undefined;
      lease.retainOpeningCleanup(previousOpeningCleanup ?? lease.release);
      return undefined;
    }
  } else {
    carrier = new NativeProviderRoutes();
    await carrier.start(config, runtime, setup.apiKey);
    options.environmentOwner?.signal.throwIfAborted();
  }
  const configJson = encode(config);
  const runtimeJson = encode(runtime);
  const model = setup.model ?? null;
  if (!idle) {
    engine = await native.create_engine(
      configJson,
      runtimeJson,
      setup.apiKey ?? null,
      null,
    );
    options.environmentOwner?.signal.throwIfAborted();
  }
  // Offline capability/input admission precedes every possible model request.
  const cached = idle?.plainAdmission;
  const admitted =
    idle?.phase === 'engine' &&
    cached?.configJson === configJson &&
    cached.runtimeJson === runtimeJson &&
    cached.model === model;
  if (!admitted) {
    if (idle && borrow?.concurrent) {
      lease.retainOpeningCleanup(previousOpeningCleanup ?? lease.release);
      return undefined;
    }
    if (idle) idle.plainAdmission = undefined;
    if (!(await engine!._plain_run_supported(configJson, runtimeJson, model))) {
      if (!pooled) {
        const report = await engine!._close_report();
        engine = undefined;
        phase = 'carrier';
        await carrier!.close();
        carrier = undefined;
        if (report) {
          diagnostic = new NativeError(report);
          throw diagnostic;
        }
      }
      lease.retainOpeningCleanup(previousOpeningCleanup ?? lease.release);
      return undefined;
    }
  }
  if (!idle) {
    const transports = lease.httpTransports(
      native._create_provider_http_transports,
      engine!,
    );
    carrier!.bindEngine(engine!, transports);
    if (borrow && transports && engine!._private_reuse_ready) {
      borrow.bind(engine!, carrier!, transports);
      pooled = true;
    }
  }
  const entry = borrow?.peek();
  if (
    entry &&
    entry.engine === engine &&
    entry.phase === 'engine' &&
    (!idle || entry === idle) &&
    (!borrow?.concurrent || entry.plainAdmission === undefined)
  ) {
    entry.plainAdmission = { configJson, runtimeJson, model };
  }
  options.environmentOwner?.signal.throwIfAborted();
  const payload = encode({
    input: normalizedText,
    instructions: setup.instructions,
    model: setup.model ?? null,
    ...(settings?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort }),
    ...(lease.websocketsAllowed && borrow?.refreshWebsocketTrust
      ? { freshWebsocketConnector: true }
      : {}),
    observationRetentionAll: options.observationRetention === 'all',
    preferBufferedResponse: setup.threadOptions._buffered_responses === true,
  });
  let completed: Promise<Completed<string>> | undefined;
  const execute = async (): Promise<Completed<string>> => {
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      owned = await engine!._plain_run(payload);
      if (signal?.aborted) cancel();
      waiting = owned.wait();
      const dto = decodePlainRunObject(await waiting);
      signal?.throwIfAborted();
      if (dto.error != null) {
        const fault = dto.error;
        throw nativeError(
          fault,
          fault &&
            typeof fault === 'object' &&
            !Array.isArray(fault) &&
            typeof fault.message === 'string'
            ? fault.message
            : undefined,
        );
      }
      // Validate/project the detached result before permitting cross-Provider reuse.
      const result = await completedPlainRun(dto, options.observationRetention);
      await cleanup(true);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      borrow?.invalidate?.();
      const primary = signal?.aborted ? signal.reason : error;
      try {
        await cleanup(false);
      } catch (cleanupError) {
        throw new RunCleanupError(
          [primary, cleanupError],
          'Native run failed and its owned cleanup is incomplete',
          () => cleanup(false),
          { cause: primary },
        );
      }
      throw primary;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  return { run: () => (completed ??= execute()) };
}
