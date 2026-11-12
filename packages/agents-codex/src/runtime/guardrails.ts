import type { Agent } from './public-agent';
import type { CompletionContext } from './model-callbacks';
import type { BeforeStepContext } from './session';
import type { ChildBeforeStepContext } from './native-agents';
import type { JsonObject } from './binding';
import type { UserInput } from './input';
import type { ToolCallInfo } from './call-metadata';

export interface GuardrailResult {
  readonly tripwireTriggered: boolean;
  readonly outputInfo?: unknown;
}

export interface InputGuardrail<Context = unknown> {
  readonly name: string;
  readonly runInParallel?: boolean;
  /** Root input before model augmentation; staged user content joins in one message. Mixed Responses batches use JSON text. */
  readonly callback: (
    input: Omit<BeforeStepContext<Context>, 'stepIndex'> & {
      readonly agent: Agent<any, any>;
      readonly input: UserInput;
    },
  ) => GuardrailResult | Promise<GuardrailResult>;
  /** Explicit child admission with original Core user/communication records. */
  readonly childCallback?: (
    context: ChildBeforeStepContext<Context> & {
      readonly agent: Agent<any, any>;
      readonly input: readonly JsonObject[];
    },
  ) => GuardrailResult | Promise<GuardrailResult>;
}

export interface OutputGuardrail<Context = unknown> {
  readonly name: string;
  readonly callback: (
    context: CompletionContext<Context, unknown>,
    agent: Agent<any, any>,
  ) => GuardrailResult | Promise<GuardrailResult>;
}

export interface GuardrailRecord {
  readonly kind: 'input' | 'output';
  readonly name: string;
  readonly result: GuardrailResult;
  readonly agent: Agent<any, any>;
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId?: string;
  readonly toolCall?: ToolCallInfo;
}

export class GuardrailTripwire extends Error {
  constructor(
    readonly record: GuardrailRecord,
    readonly results: readonly GuardrailRecord[],
  ) {
    super('Run blocked by guardrail');
    this.name = 'GuardrailTripwire';
  }
}

/** @internal Immutable captured callback declarations. */
export function captureGuardrails<
  T extends InputGuardrail<any> | OutputGuardrail<any>,
>(checks: readonly T[] | undefined): readonly T[] {
  return Object.freeze(
    (checks ?? []).map((check) => {
      const name = check.name;
      if (typeof name !== 'string' || !name.trim())
        throw new TypeError('Guardrail name must be a nonempty string');
      const callback = check.callback;
      if (typeof callback !== 'function')
        throw new TypeError('Guardrail callback must be a function');
      const runInParallel =
        'runInParallel' in check ? check.runInParallel : undefined;
      if (runInParallel !== undefined && typeof runInParallel !== 'boolean')
        throw new TypeError('runInParallel must be a boolean');
      const childCallback =
        'childCallback' in check ? check.childCallback : undefined;
      if (childCallback !== undefined && typeof childCallback !== 'function')
        throw new TypeError('childCallback must be a function');
      const captured = {
        name,
        callback: Function.prototype.bind.call(callback, check),
        ...(runInParallel === undefined ? {} : { runInParallel }),
        ...(childCallback === undefined
          ? {}
          : {
              childCallback: Function.prototype.bind.call(childCallback, check),
            }),
      };
      Object.freeze(captured);
      return captured as T;
    }),
  );
}

/** @internal Capture the verdict without cloning arbitrary host diagnostics. */
export function captureGuardrailResult(
  value: GuardrailResult,
): GuardrailResult {
  if (!value || typeof value.tripwireTriggered !== 'boolean')
    throw new TypeError('Guardrail callback must return a guardrail result');
  return Object.freeze({
    tripwireTriggered: value.tripwireTriggered,
    outputInfo: value.outputInfo,
  });
}
