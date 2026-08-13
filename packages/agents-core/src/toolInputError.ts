import type { Agent } from './agent';
import {
  InvalidToolInputError,
  type ToolInvocationErrorContext,
} from './errors';
import logger from './logger';
import type { RunState } from './runState';

type InvalidToolInputFailureOptions = {
  message: string;
  state?: RunState<any, Agent<any, any>>;
  originalError: unknown;
  toolInvocation?: ToolInvocationErrorContext;
  disposition?: InvalidToolInputDisposition;
  fatal?: boolean;
};

export type InvalidToolInputFailure = {
  error: InvalidToolInputError;
  redacted: boolean;
  disposition: InvalidToolInputDisposition;
  fatal: boolean;
};

export type InvalidToolInputDisposition = {
  redacted: boolean;
};

const redactedInvalidToolInputErrors = new WeakSet<InvalidToolInputError>();
const invalidToolInputFailures = new WeakMap<
  InvalidToolInputError,
  InvalidToolInputFailure
>();

/**
 * Constructs invalid tool input errors without retaining model-produced input
 * or parser details when tool data is redacted.
 *
 * @internal
 */
export function createInvalidToolInputFailure({
  message,
  state,
  originalError,
  toolInvocation,
  disposition: requestedDisposition,
  fatal = false,
}: InvalidToolInputFailureOptions): InvalidToolInputFailure {
  const disposition =
    requestedDisposition ?? createInvalidToolInputDisposition();
  if (logger.dontLogToolData) {
    disposition.redacted = true;
  }
  const redacted = disposition.redacted;
  const error = new InvalidToolInputError(
    message,
    redacted ? undefined : state,
    redacted ? undefined : originalError,
    redacted ? undefined : toolInvocation,
  );
  if (redacted) {
    redactedInvalidToolInputErrors.add(error);
  }
  const failure = {
    error,
    redacted,
    disposition,
    fatal,
  };
  invalidToolInputFailures.set(error, failure);
  return failure;
}

/** @internal */
export function createInvalidToolInputDisposition(): InvalidToolInputDisposition {
  return { redacted: logger.dontLogToolData };
}

/** @internal */
export function refreshInvalidToolInputFailure(
  failure: InvalidToolInputFailure,
): boolean {
  if (logger.dontLogToolData) {
    failure.disposition.redacted = true;
  }
  if (
    failure.disposition.redacted &&
    !redactedInvalidToolInputErrors.has(failure.error)
  ) {
    failure.error = new InvalidToolInputError(failure.error.message);
    redactedInvalidToolInputErrors.add(failure.error);
    invalidToolInputFailures.set(failure.error, failure);
  }
  failure.redacted = failure.disposition.redacted;
  return failure.redacted;
}

/** @internal */
export function isRedactedInvalidToolInputError(
  error: unknown,
): error is InvalidToolInputError {
  return redactedInvalidToolInputErrors.has(error as InvalidToolInputError);
}

/** @internal */
export function getInvalidToolInputFailure(
  error: unknown,
): InvalidToolInputFailure | undefined {
  return invalidToolInputFailures.get(error as InvalidToolInputError);
}
