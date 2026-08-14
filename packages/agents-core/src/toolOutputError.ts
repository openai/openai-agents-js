import { InvalidToolOutputError, type ToolOutputErrorContext } from './errors';
import logger from './logger';

export type InvalidToolOutputFailure = {
  error: InvalidToolOutputError;
  redacted: boolean;
  disposition: InvalidToolOutputDisposition;
};

export type InvalidToolOutputDisposition = {
  redacted: boolean;
};

const redactedInvalidToolOutputErrors = new WeakSet<InvalidToolOutputError>();
const invalidToolOutputFailures = new WeakMap<
  InvalidToolOutputError,
  InvalidToolOutputFailure
>();
const invalidToolOutputRedactedMessages = new WeakMap<
  InvalidToolOutputFailure,
  string
>();

const REDACTED_INVALID_TOOL_OUTPUT_MESSAGE = 'Invalid function tool output.';

/**
 * Constructs invalid tool output errors without retaining tool output or
 * validator details when tool data is redacted.
 *
 * @internal
 */
export function createInvalidToolOutputError(
  message: string,
  originalError?: unknown,
  toolOutput?: ToolOutputErrorContext,
): InvalidToolOutputError {
  const disposition = { redacted: logger.dontLogToolData };
  const error = disposition.redacted
    ? new InvalidToolOutputError(message)
    : new InvalidToolOutputError(message, undefined, originalError, toolOutput);
  if (disposition.redacted) {
    redactedInvalidToolOutputErrors.add(error);
  }
  const failure = {
    error,
    redacted: disposition.redacted,
    disposition,
  };
  invalidToolOutputFailures.set(error, failure);
  invalidToolOutputRedactedMessages.set(failure, message);
  return error;
}

/** @internal */
export function refreshInvalidToolOutputFailure(
  failure: InvalidToolOutputFailure,
): boolean {
  if (logger.dontLogToolData) {
    failure.disposition.redacted = true;
  }
  if (failure.disposition.redacted) {
    failure.error = new InvalidToolOutputError(
      invalidToolOutputRedactedMessages.get(failure) ??
        REDACTED_INVALID_TOOL_OUTPUT_MESSAGE,
    );
    redactedInvalidToolOutputErrors.add(failure.error);
    invalidToolOutputFailures.set(failure.error, failure);
  }
  failure.redacted = failure.disposition.redacted;
  return failure.redacted;
}

/** @internal */
export function getInvalidToolOutputFailure(
  error: unknown,
): InvalidToolOutputFailure | undefined {
  return invalidToolOutputFailures.get(error as InvalidToolOutputError);
}

/** @internal */
export function isRedactedInvalidToolOutputError(
  error: unknown,
): error is InvalidToolOutputError {
  return redactedInvalidToolOutputErrors.has(error as InvalidToolOutputError);
}
