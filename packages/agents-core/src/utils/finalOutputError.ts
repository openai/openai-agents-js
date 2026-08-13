import { ModelBehaviorError, UserError } from '../errors';
import logger from '../logger';
import { isAsyncStandardSchemaValidationError } from './standardSchema';

const dataRedactedErrors = new WeakSet<object>();

export const REDACTED_FINAL_OUTPUT_ERROR_MESSAGE =
  'Invalid output type: final assistant output did not match the expected schema.';

const REDACTED_ERROR_DETAILS_MESSAGE = 'Error details are redacted.';

function markDataRedacted<T extends Error>(error: T): T {
  dataRedactedErrors.add(error);
  return error;
}

export function createRedactedFinalOutputError(): ModelBehaviorError {
  return markDataRedacted(
    new ModelBehaviorError(REDACTED_FINAL_OUTPUT_ERROR_MESSAGE),
  );
}

export function processFinalOutputWithRedaction<T>(callback: () => T): T {
  const redactFromStart = logger.dontLogModelData;

  try {
    return callback();
  } catch (error) {
    if (isAsyncStandardSchemaValidationError(error)) {
      throw error;
    }
    if (!redactFromStart && !logger.dontLogModelData) {
      throw error;
    }
    throw createRedactedFinalOutputError();
  }
}

export function createRedactedErrorDetailsError(): UserError {
  return new UserError(REDACTED_ERROR_DETAILS_MESSAGE);
}

export function isDataRedactedError(error: unknown): error is Error {
  return (
    (typeof error === 'object' || typeof error === 'function') &&
    error !== null &&
    dataRedactedErrors.has(error)
  );
}
