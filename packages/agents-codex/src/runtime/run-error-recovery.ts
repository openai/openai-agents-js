import type { NativeError, RunErrorDetails } from './native-error';
import type { OutputValidationError } from './output';

/** A settled one-shot failure eligible for application output recovery. */
export interface RunFailure<Context = unknown> {
  readonly kind: 'max_requests' | 'model_refusal' | 'invalid_output';
  readonly error: NativeError | OutputValidationError;
  readonly details: RunErrorDetails & {
    readonly history: readonly Record<string, unknown>[];
  };
  readonly context: Context | undefined;
}

/** A replacement application result; this never retries the native request. */
export class RecoverRun<Output> {
  constructor(
    readonly output: Output,
    readonly includeInHistory = true,
  ) {
    if (typeof includeInHistory !== 'boolean')
      throw new TypeError('includeInHistory must be boolean');
    Object.freeze(this);
  }
}

export type RunErrorHandler<Output, Context = unknown> = (
  failure: RunFailure<Context>,
) =>
  | RecoverRun<Output>
  | null
  | undefined
  | Promise<RecoverRun<Output> | null | undefined>;
