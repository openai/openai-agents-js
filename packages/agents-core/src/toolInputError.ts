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
};

export type InvalidToolInputFailure = {
  error: InvalidToolInputError;
  redacted: boolean;
};

const redactedInvalidToolInputErrors = new WeakSet<InvalidToolInputError>();

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
}: InvalidToolInputFailureOptions): InvalidToolInputFailure {
  const redacted = logger.dontLogToolData;
  const error = new InvalidToolInputError(
    message,
    redacted ? undefined : state,
    redacted ? undefined : originalError,
    redacted ? undefined : toolInvocation,
  );
  if (redacted) {
    redactedInvalidToolInputErrors.add(error);
  }
  return {
    error,
    redacted,
  };
}

/** @internal */
export function isRedactedInvalidToolInputError(
  error: unknown,
): error is InvalidToolInputError {
  return redactedInvalidToolInputErrors.has(error as InvalidToolInputError);
}
