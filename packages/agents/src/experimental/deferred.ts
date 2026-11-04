import { createHash } from 'node:crypto';
import type { Session as PublicSession } from '../runtime/public-agent';
import {
  Session,
  type ManualCheckpointEntry,
  type Turn,
} from '../runtime/session';
import type { ManualTool, ManualToolRequest } from '../runtime/manual';
import { isManualSessionState, type SessionState } from '../runtime/state';
import { invokeWithTimeout } from '../runtime/tools';
import { canonicalDeferredInput } from './deferred-codec';
import { deferredToolCodec } from './deferred-tool';

export { deferredTool } from './deferred-tool';
export { deferredDefault } from './deferred-codec';

export interface JobBinding {
  readonly tenant: string;
  readonly runId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly requestDigest: string;
  readonly checkpointDigest: string;
}

export interface JobContext {
  readonly signal: AbortSignal;
}

export type JobUpdate =
  | {
      readonly status: 'pending' | 'inputRequired';
      readonly receipt: string;
      readonly value?: unknown;
    }
  | {
      readonly status: 'completed' | 'unknown' | 'cancelled' | 'failed';
      readonly receipt?: string;
      readonly value?: unknown;
    };

export type JobOperation = 'advance' | 'respond' | 'cancel';
export type JobAction =
  | 'start'
  | 'reconcileCreation'
  | 'observe'
  | 'respond'
  | 'cancel'
  | 'project'
  | 'deliver'
  | 'busy'
  | 'unknown';

export interface JobClaim {
  readonly binding: JobBinding;
  readonly key: string;
  /** An opaque generation issued and enforced by the journal. */
  readonly generation: string;
  readonly action: JobAction;
  readonly update?: JobUpdate;
  readonly resultJson?: string;
}

export interface JobProvider<Input> {
  start(claim: JobClaim, input: Input, context: JobContext): Promise<JobUpdate>;
  observe(claim: JobClaim, context: JobContext): Promise<JobUpdate>;
  reconcileCreation?(
    claim: JobClaim,
    input: Input,
    context: JobContext,
  ): Promise<JobUpdate>;
  respond?(
    claim: JobClaim,
    response: unknown,
    context: JobContext,
  ): Promise<JobUpdate>;
  cancel?(claim: JobClaim, context: JobContext): Promise<JobUpdate>;
}

/**
 * The application owns durable storage and conditional reservations.
 * Only the winner of prepared-to-creating may receive a start claim. Every
 * operation must check the current principal, immutable binding and generation.
 * A lost acknowledgment keeps its reservation spent; recovery must reconcile it.
 */
export interface JobJournal {
  prepare(
    stateJson: string,
    bindings: readonly JobBinding[],
    context: JobContext,
  ): Promise<void>;
  claim(
    binding: JobBinding,
    operation: JobOperation,
    context: JobContext,
  ): Promise<JobClaim>;
  authorize(
    claim: JobClaim,
    action: JobAction,
    context: JobContext,
  ): Promise<void>;
  record(
    claim: JobClaim,
    update: JobUpdate,
    context: JobContext,
  ): Promise<void>;
  saveResult(
    claim: JobClaim,
    resultJson: string,
    context: JobContext,
  ): Promise<void>;
}

export type AdvanceOutcome =
  | { readonly status: 'continued'; readonly turn: Turn<unknown> }
  | { readonly status: Exclude<JobUpdate['status'], 'completed'> | 'busy' };

export type AdvanceOptions = {
  /** Allow at most one bounded observation after a pending start. */
  readonly waitMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
} & (
  | { readonly operation?: 'advance' | 'cancel'; readonly response?: never }
  | { readonly operation: 'respond'; readonly response: unknown }
);

export type StartOptions = Pick<
  AdvanceOptions,
  'waitMs' | 'timeoutMs' | 'signal'
>;

export interface DeferredScope<Output> {
  readonly session: PublicSession<Output>;
  readonly outcome: AdvanceOutcome;
}

export interface DeferredRegistration<Input, Result> {
  readonly providerId: string;
  readonly provider: JobProvider<Input>;
  readonly project: (value: unknown) => Result;
  readonly maxOutputBytes?: number;
  readonly requireReconciliation?: boolean;
}

/** A host journal can refuse an operation without exposing its private reason. */
export class DeferredAuthorizationError extends Error {
  constructor() {
    super('Deferred operation was denied');
    this.name = 'DeferredAuthorizationError';
  }
}

interface Registration {
  readonly tool: ManualTool;
  readonly codec: NonNullable<ReturnType<typeof deferredToolCodec>>;
  readonly providerId: string;
  readonly provider: JobProvider<any>;
  readonly project: (value: unknown) => unknown;
  readonly maxOutputBytes: number;
  readonly requireReconciliation: boolean;
}

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const callKey = (name: string, callId: string): string =>
  JSON.stringify([name, callId]);

const actions = new Set<JobAction>([
  'start',
  'reconcileCreation',
  'observe',
  'respond',
  'cancel',
  'project',
  'deliver',
  'busy',
  'unknown',
]);
const statuses = new Set<JobUpdate['status']>([
  'pending',
  'inputRequired',
  'completed',
  'unknown',
  'cancelled',
  'failed',
]);
class UncertainJob extends Error {}
interface AdvanceContext extends JobContext {
  check(): void;
  live(): void;
}
function duration(value: number, zero = false): void {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    (!zero && value === 0) ||
    value > 2_147_483_647
  )
    throw new TypeError(
      'Deferred operations require bounded nonnegative durations',
    );
}
function captureUpdate(value: JobUpdate, previous?: string): JobUpdate {
  if (!value || typeof value !== 'object')
    throw new TypeError('Invalid job update');
  const status = value.status;
  const receipt = value.receipt ?? previous;
  if (
    !statuses.has(status) ||
    (receipt !== undefined && (typeof receipt !== 'string' || !receipt)) ||
    ((status === 'pending' || status === 'inputRequired') && !receipt) ||
    (previous !== undefined && receipt !== previous)
  )
    throw new TypeError('Invalid job update');
  const update = { status, receipt, value: value.value };
  if (status === 'pending' || status === 'inputRequired')
    return Object.freeze({ ...update, status, receipt: receipt! });
  return Object.freeze({ ...update, status });
}
function captureClaim(value: JobClaim, binding: JobBinding): JobClaim {
  if (
    !value ||
    typeof value !== 'object' ||
    !value.binding ||
    (Object.keys(binding) as (keyof JobBinding)[]).some(
      (key) => value.binding[key] !== binding[key],
    )
  )
    throw new DeferredAuthorizationError();
  const { key, generation, action, update, resultJson } = value;
  if (
    typeof key !== 'string' ||
    !key ||
    typeof generation !== 'string' ||
    !generation ||
    !actions.has(action)
  )
    throw new DeferredAuthorizationError();
  if (resultJson !== undefined && typeof resultJson !== 'string')
    throw new TypeError('Invalid saved job result');
  return Object.freeze({
    binding,
    key,
    generation,
    action,
    update: update === undefined ? undefined : captureUpdate(update),
    resultJson,
  });
}
async function journalCall<T>(
  invoke: () => Promise<T>,
  context: AdvanceContext,
): Promise<T> {
  context.check();
  let value: T;
  try {
    value = await invoke();
  } catch (error) {
    if (error instanceof DeferredAuthorizationError) throw error;
    throw new UncertainJob();
  }
  context.check();
  return value;
}

/** Private coordinator; providers and journals own their external effects. */
export class DeferredTools {
  private readonly journal: JobJournal;
  private readonly tenant: string;
  private readonly runId: string;
  private readonly registrations = new Map<string, Registration>();

  constructor(options: { journal: JobJournal; tenant: string; runId: string }) {
    if (!options.tenant || !options.runId)
      throw new TypeError(
        'Deferred tools require an application tenant and run',
      );
    if (
      ['prepare', 'claim', 'authorize', 'record', 'saveResult'].some(
        (name) =>
          typeof options.journal[name as keyof JobJournal] !== 'function',
      )
    )
      throw new TypeError('Deferred tools require a complete job journal');
    this.journal = options.journal;
    this.tenant = options.tenant;
    this.runId = options.runId;
  }

  register<Input, Result>(
    tool: ManualTool<Input, Result>,
    registration: DeferredRegistration<Input, Result>,
  ): void {
    const codec = deferredToolCodec(tool);
    if (!codec)
      throw new TypeError(
        'Deferred registration requires a deferredTool declaration',
      );
    if (
      !tool.name ||
      !registration.providerId ||
      this.registrations.has(tool.name)
    )
      throw new TypeError(
        'Deferred tools require a unique name and configured provider',
      );
    const maxOutputBytes = registration.maxOutputBytes ?? 16_384;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
      throw new TypeError(
        'Deferred result limits must be positive byte counts',
      );
    const requireReconciliation = registration.requireReconciliation ?? true;
    if (
      typeof registration.project !== 'function' ||
      typeof registration.provider.start !== 'function' ||
      typeof registration.provider.observe !== 'function' ||
      (requireReconciliation &&
        typeof registration.provider.reconcileCreation !== 'function')
    )
      throw new TypeError(
        'Deferred tools require a provider, projector and creation reconciliation',
      );
    this.registrations.set(
      tool.name,
      Object.freeze({
        tool,
        codec,
        providerId: registration.providerId,
        provider: registration.provider,
        project: registration.project,
        maxOutputBytes,
        requireReconciliation,
      }),
    );
  }

  /** Prepare, reopen and advance; borrow the reopened Session until the callback returns. */
  async start<Output, Result>(
    session: PublicSession<Output>,
    request: ManualToolRequest,
    options: StartOptions,
    use: (scope: DeferredScope<Output>) => Result | Promise<Result>,
  ): Promise<Result> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    duration(timeoutMs);
    duration(options.waitMs ?? 0, true);
    if (!(session instanceof Session) || typeof use !== 'function')
      throw new TypeError('Deferred start requires a Session and callback');
    const signal = options.signal ?? new AbortController().signal;
    const deadline = performance.now() + timeoutMs;
    const remaining = () => {
      if (signal.aborted)
        throw new DOMException('Deferred start was cancelled', 'AbortError');
      const time = deadline - performance.now();
      if (time <= 0)
        throw new DOMException('Deferred start timed out', 'TimeoutError');
      return time;
    };
    remaining();
    const opening = session._captureDeferredReopen(request);
    const state = await this.prepareCheckpoint(
      session,
      request,
      {
        timeoutMs: remaining(),
        signal,
      },
      opening.check,
    );
    remaining();
    let reopened: Session<Output> | undefined;
    let result!: Result;
    let failure: { error: unknown } | undefined;
    try {
      let timedOut = false;
      try {
        await invokeWithTimeout(
          async (openingSignal) => {
            reopened = await opening.open(state);
            openingSignal.throwIfAborted();
            remaining();
          },
          signal,
          remaining() / 1000,
          'deferred reopening',
          () => {
            timedOut = true;
          },
        );
      } catch {
        if (signal.aborted)
          throw new DOMException('Deferred start was cancelled', 'AbortError');
        if (timedOut || performance.now() >= deadline)
          throw new DOMException('Deferred start timed out', 'TimeoutError');
        throw new TypeError('Deferred session could not be reopened');
      }
      if (!(reopened instanceof Session))
        throw new TypeError('Deferred session could not be reopened');
      const interactions = await reopened.pendingInteractions();
      remaining();
      const job = this.registrations.get(request.name);
      const current = interactions.find(
        (candidate) =>
          candidate.subagentId === null &&
          candidate.turnId === request.turnId &&
          'callId' in candidate &&
          candidate.callId === request.callId &&
          job?.tool.match(candidate) === candidate,
      );
      if (!current || !('callId' in current))
        throw new TypeError('Deferred request was not restored');
      const outcome = await this.advance(reopened, current, {
        waitMs: options.waitMs,
        timeoutMs: remaining(),
        signal,
      });
      result = await use(Object.freeze({ session: reopened, outcome }));
    } catch (error) {
      failure = { error };
    }
    try {
      await reopened?.close();
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure.error, error],
          'Deferred scope and cleanup failed',
          { cause: failure.error },
        );
      throw error;
    }
    if (failure) throw failure.error;
    return result;
  }

  /**
   * Advance one restored call without leaving a poller behind. The journal
   * chooses the next conditional action; timeout never authorizes a new start.
   * Caller cancellation joins work and does not cancel the remote job.
   */
  async advance(
    session: PublicSession<unknown>,
    request: ManualToolRequest,
    options: AdvanceOptions = {},
  ): Promise<AdvanceOutcome> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const waitMs = options.waitMs ?? 0;
    const operation = options.operation ?? 'advance';
    duration(timeoutMs);
    duration(waitMs, true);
    if (
      !['advance', 'respond', 'cancel'].includes(operation) ||
      (options.response !== undefined && operation !== 'respond')
    )
      throw new TypeError('Invalid deferred operation');
    const job = this.registrations.get(request.name);
    if (
      !(session instanceof Session) ||
      !job ||
      job.tool.match(request) !== request
    )
      throw new TypeError(
        'Deferred work requires its registered Session request',
      );
    if (
      operation !== 'advance' &&
      typeof job.provider[operation] !== 'function'
    )
      throw new TypeError('Deferred provider does not support this operation');
    const parentSignal = options.signal ?? new AbortController().signal;
    const deadline = performance.now() + timeoutMs;
    let timedOut = false;
    try {
      const snapshot = session._deferredCheckpoint(request);
      const input = canonicalDeferredInput(
        job.codec.parseInput(snapshot.arguments),
      );
      if (input !== canonicalDeferredInput(request.arguments))
        throw new TypeError('Deferred arguments changed after admission');
      const binding = Object.freeze({
        tenant: this.tenant,
        runId: this.runId,
        providerId: job.providerId,
        sessionId: snapshot.sourceSessionId,
        turnId: request.turnId,
        callId: request.callId,
        toolName: request.name,
        requestDigest: digest(input),
        checkpointDigest: digest(snapshot.serialized),
      });
      return await invokeWithTimeout(
        async (signal) => {
          const context: AdvanceContext = {
            signal,
            check() {
              signal.throwIfAborted();
              if (performance.now() >= deadline) {
                timedOut = true;
                throw new DOMException(
                  'Deferred operation timed out',
                  'TimeoutError',
                );
              }
            },
            live() {
              this.check();
              session._deferredCheckpoint(request);
              this.check();
            },
          };
          context.live();
          return this.advanceJob(
            session,
            request,
            job,
            binding,
            { ...options, operation, waitMs },
            context,
          );
        },
        parentSignal,
        timeoutMs / 1000,
        'deferred operation',
        () => {
          timedOut = true;
        },
      );
    } catch (error) {
      if (parentSignal.aborted)
        throw new DOMException(
          'Deferred operation was cancelled',
          'AbortError',
        );
      if (timedOut || error instanceof UncertainJob)
        return { status: 'unknown' };
      if (error instanceof DeferredAuthorizationError)
        throw new DeferredAuthorizationError();
      throw new TypeError('Deferred operation could not be completed');
    }
  }

  private async advanceJob(
    session: Session<unknown>,
    request: ManualToolRequest,
    job: Registration,
    binding: JobBinding,
    options: { operation: JobOperation; response?: unknown; waitMs: number },
    context: AdvanceContext,
  ): Promise<AdvanceOutcome> {
    let claim = captureClaim(
      await journalCall(
        () =>
          this.journal.claim(binding, options.operation, {
            signal: context.signal,
          }),
        context,
      ),
      binding,
    );
    context.live();
    const action = claim.action;
    if (action === 'busy' || action === 'unknown') return { status: action };
    if (
      (options.operation !== 'advance' && action !== options.operation) ||
      (options.operation === 'advance' &&
        (action === 'respond' || action === 'cancel'))
    )
      throw new DeferredAuthorizationError();
    if (
      action === 'start' &&
      (claim.update !== undefined || claim.resultJson !== undefined)
    )
      throw new TypeError('A start claim cannot contain prior job state');

    const authorize = async (
      current: JobClaim,
      next: JobAction,
      active = context,
    ) => {
      await journalCall(
        () => this.journal.authorize(current, next, { signal: active.signal }),
        active,
      );
      active.live();
    };
    const deliver = async (
      current: JobClaim,
      raw: string,
      projected: boolean,
    ): Promise<AdvanceOutcome> => {
      context.live();
      if (Buffer.byteLength(raw, 'utf8') > job.maxOutputBytes)
        throw new TypeError('Deferred result exceeds its byte limit');
      const value = job.codec.parseResult(
        session._validateDeferredResult(raw, [
          current.key,
          ...(current.update?.receipt ? [current.update.receipt] : []),
        ]),
      );
      if (JSON.stringify(value) !== raw)
        throw new TypeError('Deferred result is not lossless JSON');
      context.check();
      if (projected)
        await journalCall(
          () =>
            this.journal.saveResult(current, raw, { signal: context.signal }),
          context,
        );
      await authorize(current, 'deliver');
      return {
        status: 'continued',
        turn: await session._deliverDeferredResult(request, value, raw, () =>
          context.check(),
        ),
      };
    };
    if (action === 'deliver') {
      if (claim.resultJson === undefined)
        throw new TypeError('Saved result is missing');
      return deliver(claim, claim.resultJson, false);
    }
    if (
      ['observe', 'respond', 'cancel'].includes(action) &&
      !claim.update?.receipt
    )
      throw new TypeError('Provider operation requires a receipt');
    if (action === 'respond' && claim.update?.status !== 'inputRequired')
      throw new TypeError('Job does not require input');
    if (
      action === 'cancel' &&
      claim.update?.status !== 'pending' &&
      claim.update?.status !== 'inputRequired'
    )
      throw new TypeError('Job cannot be cancelled');
    if (action === 'reconcileCreation' && !job.requireReconciliation)
      return { status: 'unknown' };

    type Phase = 'authorizing' | 'provider' | 'recording';
    const providerUpdate = async (
      current: JobClaim,
      next: JobAction,
      active: AdvanceContext,
      phase: (value: Phase) => void = () => {},
    ) => {
      phase('authorizing');
      await authorize(current, next, active);
      phase('provider');
      let value: JobUpdate;
      try {
        const hostContext = { signal: active.signal };
        if (next === 'start')
          value = await job.provider.start(
            current,
            request.arguments,
            hostContext,
          );
        else if (next === 'reconcileCreation' && job.provider.reconcileCreation)
          value = await job.provider.reconcileCreation(
            current,
            request.arguments,
            hostContext,
          );
        else if (next === 'observe')
          value = await job.provider.observe(current, hostContext);
        else if (next === 'respond' && job.provider.respond)
          value = await job.provider.respond(
            current,
            options.response,
            hostContext,
          );
        else if (next === 'cancel' && job.provider.cancel)
          value = await job.provider.cancel(current, hostContext);
        else throw new DeferredAuthorizationError();
      } catch (error) {
        active.check();
        if (error instanceof DeferredAuthorizationError) throw error;
        return undefined;
      }
      active.check();
      const update = captureUpdate(value, current.update?.receipt);
      phase('recording');
      await journalCall(
        () => this.journal.record(current, update, { signal: active.signal }),
        active,
      );
      return update;
    };

    let update = claim.update;
    if (action !== 'project') {
      update = await providerUpdate(claim, action, context);
      if (
        update?.status === 'pending' &&
        action === 'start' &&
        options.waitMs > 0
      ) {
        claim = Object.freeze({ ...claim, update });
        const waitDeadline = performance.now() + options.waitMs;
        let phase: Phase = 'authorizing';
        let expiredDuring: Phase | undefined;
        try {
          update = await invokeWithTimeout(
            async (signal) => {
              const active: AdvanceContext = {
                signal,
                check() {
                  context.check();
                  if (performance.now() >= waitDeadline) {
                    expiredDuring ??= phase;
                    throw new DOMException(
                      'Deferred observation timed out',
                      'TimeoutError',
                    );
                  }
                  signal.throwIfAborted();
                },
                live() {
                  this.check();
                  context.live();
                },
              };
              return providerUpdate(claim, 'observe', active, (next) => {
                phase = next;
              });
            },
            context.signal,
            options.waitMs / 1000,
            'deferred observation',
            () => {
              expiredDuring = phase;
            },
          );
        } catch (error) {
          context.check();
          if (error instanceof UncertainJob) return { status: 'unknown' };
          if (expiredDuring)
            return {
              status: expiredDuring === 'provider' ? 'pending' : 'unknown',
            };
          throw error;
        }
      }
      if (!update) return { status: 'unknown' };
    }
    if (!update || (action === 'project' && update.status !== 'completed'))
      throw new TypeError('Projection requires a completed job');
    if (update.status !== 'completed') return { status: update.status };
    claim = Object.freeze({ ...claim, update });
    await authorize(claim, 'project');
    const value = job.codec.parseResult(job.project(update.value));
    context.check();
    return deliver(claim, JSON.stringify(value), true);
  }

  async prepare(
    session: PublicSession<unknown>,
    request: ManualToolRequest,
    options: Pick<StartOptions, 'timeoutMs' | 'signal'> = {},
  ): Promise<SessionState> {
    return this.prepareCheckpoint(session, request, options);
  }

  private async prepareCheckpoint(
    session: PublicSession<unknown>,
    request: ManualToolRequest,
    options: Pick<StartOptions, 'timeoutMs' | 'signal'>,
    checkOpening?: () => void,
  ): Promise<SessionState> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    )
      throw new TypeError(
        'Deferred preparation requires a finite positive timeout',
      );
    const selected = this.registrations.get(request.name);
    if (
      !(session instanceof Session) ||
      selected?.tool.match(request) !== request
    )
      throw new TypeError(
        'Deferred preparation requires its registered Session request',
      );
    const parentSignal = options.signal ?? new AbortController().signal;
    const deadline = performance.now() + timeoutMs;
    let timedOut = false;
    try {
      return await invokeWithTimeout(
        async (signal) => {
          const assertActive = () => {
            signal.throwIfAborted();
            if (performance.now() >= deadline) {
              timedOut = true;
              throw new DOMException(
                'Deferred checkpoint preparation timed out',
                'TimeoutError',
              );
            }
          };
          assertActive();
          const inputs = new Map<
            string,
            { job: Registration; canonical: string }
          >();
          const validate = (entries: readonly ManualCheckpointEntry[]) => {
            assertActive();
            checkOpening?.();
            inputs.clear();
            for (const entry of entries) {
              const job = this.registrations.get(entry.request.name);
              if (!job || job.tool.match(entry.request) !== entry.request)
                continue;
              const checked = canonicalDeferredInput(
                job.codec.parseInput(entry.arguments),
              );
              const admitted = canonicalDeferredInput(entry.request.arguments);
              if (checked !== admitted)
                throw new TypeError(
                  'Deferred arguments changed after admission',
                );
              inputs.set(callKey(entry.request.name, entry.request.callId), {
                job,
                canonical: admitted,
              });
            }
            if (!inputs.has(callKey(request.name, request.callId)))
              throw new TypeError(
                'Deferred preparation requires its registered root request',
              );
            assertActive();
          };
          const { state, serialized } =
            await session._prepareDeferredCheckpoint(request, validate, signal);
          if (
            !isManualSessionState(state) ||
            state.source_session_id !== request.sessionId ||
            state.manual_continuation.turn_id !== request.turnId
          )
            throw new TypeError('Deferred checkpoint identity changed');
          const checkpointDigest = digest(serialized);
          const bindings: JobBinding[] = [];
          for (const pending of state.manual_continuation.pending_manual) {
            const input = inputs.get(callKey(pending.name, pending.call_id));
            if (!input) continue;
            bindings.push(
              Object.freeze({
                tenant: this.tenant,
                runId: this.runId,
                providerId: input.job.providerId,
                sessionId: state.source_session_id,
                turnId: state.manual_continuation.turn_id,
                callId: pending.call_id,
                toolName: pending.name,
                requestDigest: digest(input.canonical),
                checkpointDigest,
              }),
            );
          }
          if (bindings.length !== inputs.size)
            throw new TypeError('Deferred checkpoint pending calls changed');
          const save = (storageSignal: AbortSignal) =>
            this.journal.prepare(serialized, Object.freeze(bindings), {
              signal: storageSignal,
            });
          const expired = performance.now() >= deadline;
          if (expired && !parentSignal.aborted) timedOut = true;
          if (signal.aborted || expired) {
            // A committed seal gets one bounded persistence attempt before interruption escapes.
            await invokeWithTimeout(
              save,
              new AbortController().signal,
              timeoutMs / 1000,
              'deferred checkpoint persistence',
              () => {},
            );
          } else {
            await save(signal);
          }
          assertActive();
          return state;
        },
        parentSignal,
        timeoutMs / 1000,
        'deferred preparation',
        () => {
          timedOut = true;
        },
      );
    } catch (error) {
      if (timedOut)
        throw new DOMException(
          'Deferred checkpoint preparation timed out',
          'TimeoutError',
        );
      if (parentSignal.aborted)
        throw new DOMException(
          'Deferred checkpoint preparation was cancelled',
          'AbortError',
        );
      if (error instanceof DeferredAuthorizationError)
        throw new DeferredAuthorizationError();
      if (error instanceof TypeError)
        throw new TypeError('Deferred checkpoint could not be prepared');
      throw new Error('Deferred checkpoint could not be prepared');
    }
  }
}
