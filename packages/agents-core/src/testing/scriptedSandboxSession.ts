import { cloneManifest, Manifest } from '../sandbox/manifest';
import type { SandboxSession, SandboxSessionState } from '../sandbox/session';
import { snapshotTestingValue } from '../utils/testingSnapshot';

type AnyFunction = (...args: any[]) => any;

export type ScriptedSandboxMethod = {
  [TKey in keyof SandboxSession]-?: NonNullable<
    SandboxSession[TKey]
  > extends AnyFunction
    ? TKey
    : never;
}[keyof SandboxSession];

type SandboxMethodFunction<TMethod extends ScriptedSandboxMethod> = Extract<
  NonNullable<SandboxSession[TMethod]>,
  AnyFunction
>;

type SandboxMethodArgs<TMethod extends ScriptedSandboxMethod> = Parameters<
  SandboxMethodFunction<TMethod>
>;

type SandboxMethodResult<TMethod extends ScriptedSandboxMethod> = Awaited<
  ReturnType<SandboxMethodFunction<TMethod>>
>;

type ScriptedSandboxResponderResult<TMethod extends ScriptedSandboxMethod> =
  ReturnType<SandboxMethodFunction<TMethod>> extends PromiseLike<unknown>
    ? SandboxMethodResult<TMethod> | PromiseLike<SandboxMethodResult<TMethod>>
    : ReturnType<SandboxMethodFunction<TMethod>>;

export type RecordedSandboxCall = Readonly<{
  /** The zero-based position of this call in `calls`. */
  index: number;
  /** The invoked method. New SDK versions may add method names. */
  method: string;
  /** Detached invocation-time arguments in parameter order. */
  args: readonly unknown[];
}>;

export type ScriptedSandboxCallFor<TMethod extends ScriptedSandboxMethod> =
  Readonly<{
    index: number;
    method: TMethod;
    args: Readonly<SandboxMethodArgs<TMethod>>;
  }>;

type ScriptedSandboxMatcher<TMethod extends ScriptedSandboxMethod> = (
  ...args: SandboxMethodArgs<TMethod>
) => boolean | void;

type ScriptedSandboxResponder<TMethod extends ScriptedSandboxMethod> = (
  call: ScriptedSandboxCallFor<TMethod>,
) => ScriptedSandboxResponderResult<TMethod>;

type ScriptedSandboxStepBase<TMethod extends ScriptedSandboxMethod> = {
  method: TMethod;
  match?: ScriptedSandboxMatcher<TMethod>;
};

type ScriptedSandboxResultStep<TMethod extends ScriptedSandboxMethod> =
  ScriptedSandboxStepBase<TMethod> & {
    result: SandboxMethodResult<TMethod>;
    respond?: never;
    error?: never;
  };

type ScriptedSandboxResponderStep<TMethod extends ScriptedSandboxMethod> =
  ScriptedSandboxStepBase<TMethod> & {
    respond: ScriptedSandboxResponder<TMethod>;
    result?: never;
    error?: never;
  };

type ScriptedSandboxErrorStep<TMethod extends ScriptedSandboxMethod> =
  ScriptedSandboxStepBase<TMethod> & {
    error: unknown;
    result?: never;
    respond?: never;
  };

type ScriptedSandboxStep<TMethod extends ScriptedSandboxMethod> =
  | ScriptedSandboxResultStep<TMethod>
  | ScriptedSandboxResponderStep<TMethod>
  | ScriptedSandboxErrorStep<TMethod>;

export type ScriptedSandboxInput<
  TMethod extends ScriptedSandboxMethod = ScriptedSandboxMethod,
> = {
  [TCurrentMethod in TMethod]: ScriptedSandboxStep<TCurrentMethod>;
}[TMethod];

export type ScriptedSandboxSession<
  TMethod extends ScriptedSandboxMethod = never,
> = SandboxSession &
  Required<Pick<SandboxSession, TMethod>> & {
    /** All calls recorded by this session in invocation order. */
    readonly calls: readonly RecordedSandboxCall[];
    /** The number of scripted steps that have not been consumed. */
    readonly remainingSteps: number;
    /** Throws when the script still contains unconsumed steps. */
    assertComplete(): void;
  };

export type InvalidScriptedSandboxStepReason =
  'invalid_input' | 'unknown_method' | 'invalid_matcher' | 'invalid_outcome';

export class InvalidScriptedSandboxStepError extends Error {
  readonly reason: InvalidScriptedSandboxStepReason;
  /** The zero-based position of the invalid factory input. */
  readonly inputIndex: number;
  readonly method?: string;

  constructor(options: {
    reason: InvalidScriptedSandboxStepReason;
    inputIndex: number;
    message: string;
    method?: string;
  }) {
    super(options.message);
    this.name = 'InvalidScriptedSandboxStepError';
    this.reason = options.reason;
    this.inputIndex = options.inputIndex;
    this.method = options.method;
  }
}

export class UnexpectedSandboxCallError extends Error {
  /** The zero-based position of the call in `calls`. */
  readonly callIndex: number;
  readonly actualMethod: string;
  readonly expectedMethod?: string;
  readonly remainingSteps: number;

  constructor(options: {
    callIndex: number;
    actualMethod: string;
    expectedMethod?: string;
    remainingSteps: number;
  }) {
    const expectation = options.expectedMethod
      ? `; expected ${options.expectedMethod}`
      : '; no scripted steps remain';
    super(
      `Scripted sandbox session received unexpected ${options.actualMethod} call #${displayIndex(options.callIndex)}${expectation}.`,
    );
    this.name = 'UnexpectedSandboxCallError';
    this.callIndex = options.callIndex;
    this.actualMethod = options.actualMethod;
    this.expectedMethod = options.expectedMethod;
    this.remainingSteps = options.remainingSteps;
  }
}

export class SandboxCallMatcherError extends Error {
  /** The zero-based position of the call in `calls`. */
  readonly callIndex: number;
  readonly method: string;

  constructor(call: RecordedSandboxCall) {
    super(
      `Scripted sandbox session matcher rejected ${call.method} call #${displayIndex(call.index)}.`,
    );
    this.name = 'SandboxCallMatcherError';
    this.callIndex = call.index;
    this.method = call.method;
  }
}

export class UnconsumedSandboxStepsError extends Error {
  readonly remainingSteps: number;
  readonly pendingMethods: readonly string[];

  constructor(pendingMethods: readonly string[]) {
    super(
      `Scripted sandbox session has ${pendingMethods.length} unconsumed step${pendingMethods.length === 1 ? '' : 's'}: ${pendingMethods.join(', ')}.`,
    );
    this.name = 'UnconsumedSandboxStepsError';
    this.remainingSteps = pendingMethods.length;
    this.pendingMethods = Object.freeze([...pendingMethods]);
  }
}

type NormalizedScriptedSandboxStep = {
  method: ScriptedSandboxMethod;
  match?: (...args: any[]) => boolean | void;
} & (
  | { type: 'result'; result: unknown }
  | { type: 'responder'; respond: (call: RecordedSandboxCall) => unknown }
  | { type: 'error'; error: unknown }
);

type InternalRecordedSandboxCall = Readonly<{
  index: number;
  method: ScriptedSandboxMethod;
  args: readonly unknown[];
}>;

const sandboxMethodModes = {
  start: 'async',
  running: 'async',
  registerPreStopHook: 'sync',
  runPreStopHooks: 'async',
  preStop: 'async',
  stop: 'async',
  shutdown: 'async',
  delete: 'async',
  createEditor: 'sync',
  exec: 'async',
  execCommand: 'async',
  writeStdin: 'async',
  viewImage: 'async',
  readFile: 'async',
  listDir: 'async',
  pathExists: 'async',
  directoryExists: 'async',
  materializeEntry: 'async',
  applyManifest: 'async',
  persistWorkspace: 'async',
  hydrateWorkspace: 'async',
  setArchiveLimits: 'sync',
  resolveExposedPort: 'async',
  supportsPty: 'sync',
  close: 'async',
} as const satisfies Record<ScriptedSandboxMethod, 'async' | 'sync'>;

/**
 * Creates a deterministic sandbox session with only the scripted optional
 * methods installed on the returned object.
 */
export function scriptedSandboxSession<
  const TInputs extends readonly ScriptedSandboxInput[],
>(inputs: TInputs): ScriptedSandboxSession<TInputs[number]['method']>;
export function scriptedSandboxSession<TMethod extends ScriptedSandboxMethod>(
  inputs: Iterable<ScriptedSandboxInput<TMethod>>,
): ScriptedSandboxSession<TMethod>;
export function scriptedSandboxSession(): ScriptedSandboxSession<never>;
export function scriptedSandboxSession(
  inputs: Iterable<ScriptedSandboxInput> = [],
): ScriptedSandboxSession<ScriptedSandboxMethod> {
  const steps = Array.from(inputs, (input, index) =>
    normalizeInput(input, index),
  );
  const calls: InternalRecordedSandboxCall[] = [];
  const configuredMethods = new Set(steps.map((step) => step.method));
  const state: SandboxSessionState = { manifest: new Manifest() };
  const session = { state } as SandboxSession &
    Partial<Record<ScriptedSandboxMethod, AnyFunction>> & {
      calls: readonly RecordedSandboxCall[];
      remainingSteps: number;
      assertComplete(): void;
    };

  const invoke = (method: ScriptedSandboxMethod, args: unknown[]): unknown => {
    const call: InternalRecordedSandboxCall = Object.freeze({
      index: calls.length,
      method,
      args: Object.freeze(snapshotSandboxCallArgs(method, args)),
    });
    calls.push(call);

    const step = steps.shift();
    if (!step || step.method !== method) {
      throw new UnexpectedSandboxCallError({
        callIndex: call.index,
        actualMethod: method,
        expectedMethod: step?.method,
        remainingSteps: steps.length,
      });
    }

    if (step.match) {
      const matchArgs = snapshotSandboxCallArgs(method, call.args);
      if (step.match(...matchArgs) === false) {
        throw new SandboxCallMatcherError(call);
      }
    }

    if (step.type === 'error') {
      throw step.error;
    }
    if (step.type === 'responder') {
      return step.respond(snapshotRecordedCall(call));
    }
    return step.result;
  };

  for (const method of configuredMethods) {
    const scriptedMethod = (...args: unknown[]) => {
      if (sandboxMethodModes[method] === 'sync') {
        return invoke(method, args);
      }
      try {
        return Promise.resolve(invoke(method, args));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    Object.defineProperty(session, method, {
      configurable: false,
      enumerable: true,
      value: scriptedMethod,
      writable: true,
    });
  }

  Object.defineProperties(session, {
    calls: {
      configurable: false,
      enumerable: true,
      get: () => Object.freeze(calls.map(snapshotRecordedCall)),
    },
    remainingSteps: {
      configurable: false,
      enumerable: true,
      get: () => steps.length,
    },
    assertComplete: {
      configurable: false,
      enumerable: true,
      value: () => {
        if (steps.length > 0) {
          throw new UnconsumedSandboxStepsError(
            steps.map((step) => step.method),
          );
        }
      },
      writable: false,
    },
  });

  return session as ScriptedSandboxSession<ScriptedSandboxMethod>;
}

function normalizeInput(
  input: unknown,
  inputIndex: number,
): NormalizedScriptedSandboxStep {
  if (!isRecord(input)) {
    throw new InvalidScriptedSandboxStepError({
      reason: 'invalid_input',
      inputIndex,
      message: `Scripted sandbox step #${displayIndex(inputIndex)} must be an object.`,
    });
  }

  const method = input.method;
  if (
    typeof method !== 'string' ||
    !Object.prototype.hasOwnProperty.call(sandboxMethodModes, method)
  ) {
    throw new InvalidScriptedSandboxStepError({
      reason: 'unknown_method',
      inputIndex,
      method: typeof method === 'string' ? method : undefined,
      message: `Scripted sandbox step #${displayIndex(inputIndex)} has an unknown method.`,
    });
  }

  if (typeof input.match !== 'undefined' && typeof input.match !== 'function') {
    throw new InvalidScriptedSandboxStepError({
      reason: 'invalid_matcher',
      inputIndex,
      method,
      message: `Scripted sandbox step #${displayIndex(inputIndex)} for ${method} must use a function matcher.`,
    });
  }

  const hasResult = Object.prototype.hasOwnProperty.call(input, 'result');
  const hasResponder = Object.prototype.hasOwnProperty.call(input, 'respond');
  const hasError = Object.prototype.hasOwnProperty.call(input, 'error');
  if (Number(hasResult) + Number(hasResponder) + Number(hasError) !== 1) {
    throw new InvalidScriptedSandboxStepError({
      reason: 'invalid_outcome',
      inputIndex,
      method,
      message: `Scripted sandbox step #${displayIndex(inputIndex)} for ${method} must define exactly one of result, respond, or error.`,
    });
  }

  const base = {
    method: method as ScriptedSandboxMethod,
    ...(typeof input.match === 'function'
      ? { match: input.match as (...args: any[]) => boolean | void }
      : {}),
  };
  if (hasResponder) {
    if (typeof input.respond !== 'function') {
      throw new InvalidScriptedSandboxStepError({
        reason: 'invalid_outcome',
        inputIndex,
        method,
        message: `Scripted sandbox step #${displayIndex(inputIndex)} for ${method} must use a function responder.`,
      });
    }
    return {
      ...base,
      type: 'responder',
      respond: input.respond as (call: RecordedSandboxCall) => unknown,
    };
  }
  if (hasError) {
    return { ...base, type: 'error', error: input.error };
  }
  return {
    ...base,
    type: 'result',
    result: snapshotTestingValue(input.result),
  };
}

function displayIndex(index: number): number {
  return index + 1;
}

function snapshotRecordedCall(
  call: InternalRecordedSandboxCall,
): RecordedSandboxCall {
  return Object.freeze({
    index: call.index,
    method: call.method,
    args: Object.freeze(snapshotSandboxCallArgs(call.method, call.args)),
  });
}

function snapshotSandboxCallArgs(
  method: ScriptedSandboxMethod,
  args: readonly unknown[],
): unknown[] {
  const snapshot = snapshotTestingValue([...args]);
  if (method === 'applyManifest' && snapshot[0] instanceof Manifest) {
    snapshot[0] = cloneManifest(snapshot[0]);
  }
  return snapshot;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}
