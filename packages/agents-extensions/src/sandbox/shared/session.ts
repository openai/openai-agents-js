import { UserError } from '@openai/agents-core';
import {
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  withSandboxSpan,
  type SandboxConcurrencyLimits,
  type SnapshotSpec,
} from '@openai/agents-core/sandbox';
import { isRecord } from './typeGuards';

export { withSandboxSpan };

export async function closeRemoteSessionOnManifestError(
  providerName: string,
  session: { close(): Promise<void> },
  manifestError: unknown,
): Promise<never> {
  try {
    await session.close();
  } catch (closeError) {
    throw new UserError(
      `Failed to apply a ${providerName} sandbox manifest and close the sandbox. Manifest error: ${errorMessage(manifestError)} Close error: ${errorMessage(closeError)}`,
    );
  }
  throw manifestError;
}

export function assertRunAsUnsupported(
  providerName: string,
  runAs?: string,
): void {
  if (runAs) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support runAs yet.`,
      {
        provider: providerName,
        feature: 'runAs',
      },
    );
  }
}

export function assertCoreSnapshotUnsupported(
  providerName: string,
  snapshot?: SnapshotSpec,
): void {
  if (snapshot && snapshot.type !== 'noop') {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support core sandbox snapshots yet. Use the provider-specific workspacePersistence option when available.`,
      {
        provider: providerName,
        feature: 'snapshot',
      },
    );
  }
}

export function assertCoreConcurrencyLimitsUnsupported(
  providerName: string,
  limits?: SandboxConcurrencyLimits,
): void {
  if (
    limits?.manifestEntries !== undefined ||
    limits?.localDirFiles !== undefined
  ) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support core sandbox concurrencyLimits yet.`,
      {
        provider: providerName,
        feature: 'concurrencyLimits',
      },
    );
  }
}

export async function withProviderError<T>(
  providerName: string,
  provider: string,
  operation: string,
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new SandboxProviderError(`${providerName} failed to ${operation}.`, {
      provider,
      operation,
      ...context,
      cause: errorMessage(error),
    });
  }
}

export function isProviderSandboxNotFoundError(error: unknown): boolean {
  if (isNotFoundErrorRecord(error, new Set())) {
    return true;
  }

  const text = errorMessage(error).trim();
  return isNotFoundErrorMessage(text);
}

export type ResumeRecreateErrorContext = {
  providerName: string;
  provider: string;
  details?: Record<string, unknown>;
};

export function assertResumeRecreateAllowed(
  error: unknown,
  context: ResumeRecreateErrorContext,
): void {
  if (error instanceof UserError) {
    throw error;
  }

  if (isProviderSandboxNotFoundError(error)) {
    return;
  }

  throw new SandboxProviderError(
    `${context.providerName} failed to reconnect sandbox during resume.`,
    {
      provider: context.provider,
      operation: 'resume',
      ...context.details,
      cause: errorMessage(error),
    },
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SandboxProviderError && error.details) {
    return `${message} Details: ${formatErrorDetails(error.details)}`;
  }
  return message;
}

function formatErrorDetails(details: Record<string, unknown>): string {
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function isNotFoundErrorRecord(error: unknown, seen: Set<object>): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  for (const key of ['status', 'statusCode', 'httpStatus', 'httpStatusCode']) {
    if (is404(error[key])) {
      return true;
    }
  }

  const response = error.response;
  if (isRecord(response) && is404(response.status)) {
    return true;
  }

  if (isNotFoundErrorCode(error.code)) {
    return true;
  }

  if (
    typeof error.message === 'string' &&
    isNotFoundErrorMessage(error.message)
  ) {
    return true;
  }

  return isNotFoundErrorRecord(error.cause, seen);
}

function is404(value: unknown): boolean {
  return value === 404 || value === '404';
}

function isNotFoundErrorCode(value: unknown): boolean {
  if (typeof value === 'number') {
    return value === 404;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return /^(404|not_found|not-found|notfound|resource_not_found|resource-not-found|not found)$/iu.test(
    value.trim(),
  );
}

function isNotFoundErrorMessage(message: string): boolean {
  const text = message.trim();
  if (!text) {
    return false;
  }
  if (/^(404|not[_ -]?found)$/iu.test(text)) {
    return true;
  }
  return (
    /\b(sandbox|sandbox instance|instance|devbox)\b.*\b(not found|missing|does not exist|no such)\b/iu.test(
      text,
    ) ||
    /\b(not found|missing|does not exist|no such)\b.*\b(sandbox|sandbox instance|instance|devbox)\b/iu.test(
      text,
    )
  );
}
