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
      `Failed to apply a ${providerName} sandbox manifest and close the sandbox. Manifest error: ${providerErrorMessage(manifestError)} Close error: ${providerErrorMessage(closeError)}`,
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
    const cause = providerErrorMessage(error);
    throw new SandboxProviderError(
      `${providerName} failed to ${operation}${cause ? `: ${cause}` : ''}`,
      {
        provider,
        operation,
        ...context,
        ...providerErrorDetails(error),
        cause,
      },
    );
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
      ...providerErrorDetails(error),
      cause: providerErrorMessage(error),
    },
  );
}

export function providerErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  const details = providerErrorDetails(error);
  const detailText = formatProviderErrorDetailSummary(details);
  if (!detailText) {
    return message;
  }
  return message ? `${message} (${detailText})` : detailText;
}

export function providerErrorDetails(error: unknown): Record<string, unknown> {
  return collectProviderErrorDetails(error, new Set<object>(), 0);
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

function collectProviderErrorDetails(
  value: unknown,
  seen: Set<object>,
  depth: number,
): Record<string, unknown> {
  if (!isRecord(value) || seen.has(value) || depth > 2) {
    return {};
  }
  seen.add(value);

  const details: Record<string, unknown> = {};
  addOptionalString(
    details,
    'errorName',
    value.name,
    (name) => name !== 'Error',
  );
  addOptionalScalar(details, 'errorCode', value.code);
  addOptionalScalar(
    details,
    'status',
    firstDefined(value.status, value.statusCode),
  );
  addOptionalScalar(
    details,
    'httpStatus',
    firstDefined(value.httpStatus, value.httpStatusCode),
  );
  addOptionalString(
    details,
    'requestId',
    firstDefined(value.requestId, value.request_id, value.requestID),
  );

  const payload = firstDefined(value.json, value.data, value.body, value.error);
  const formattedPayload = formatProviderPayload(payload, seen, depth + 1);
  if (formattedPayload !== undefined) {
    details.errorBody = formattedPayload;
  }

  const response = value.response;
  if (isRecord(response)) {
    addOptionalScalar(
      details,
      'responseStatus',
      firstDefined(response.status, response.statusCode),
    );
    addOptionalString(details, 'responseStatusText', response.statusText);
    addOptionalString(
      details,
      'responseRequestId',
      firstDefined(response.requestId, response.request_id, response.requestID),
    );
    const responseBody = formatProviderPayload(
      firstDefined(response.json, response.data, response.body, response.error),
      seen,
      depth + 1,
    );
    if (responseBody !== undefined) {
      details.responseBody = responseBody;
    }
  }

  const causeDetails = collectProviderErrorDetails(
    value.cause,
    seen,
    depth + 1,
  );
  for (const [key, detail] of Object.entries(causeDetails)) {
    details[key] ??= detail;
  }

  return details;
}

function formatProviderErrorDetailSummary(
  details: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of [
    'status',
    'httpStatus',
    'responseStatus',
    'errorCode',
    'requestId',
    'responseRequestId',
  ]) {
    const value = details[key];
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(`${key}: ${value}`);
    }
  }
  const body = details.responseBody ?? details.errorBody;
  if (body !== undefined) {
    parts.push(`body: ${formatSummaryValue(body)}`);
  }
  return parts.join(', ');
}

function formatProviderPayload(
  value: unknown,
  seen: Set<object>,
  depth: number,
): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return truncateProviderString(String(value));
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 3)
      .map((item) => formatProviderPayload(item, seen, depth + 1))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!isRecord(value) || seen.has(value) || depth > 3) {
    return undefined;
  }
  seen.add(value);

  const summary: Record<string, unknown> = {};
  for (const key of [
    'code',
    'message',
    'error',
    'type',
    'name',
    'reason',
    'status',
    'statusCode',
  ]) {
    const formatted = formatProviderPayload(value[key], seen, depth + 1);
    if (formatted !== undefined) {
      summary[key] = formatted;
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function formatSummaryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return truncateProviderString(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function addOptionalScalar(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    target[key] = value;
  }
}

function addOptionalString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  predicate: (value: string) => boolean = () => true,
): void {
  if (typeof value === 'string' && value && predicate(value)) {
    target[key] = truncateProviderString(value);
  }
}

function truncateProviderString(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
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
