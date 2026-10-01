import {
  TracingExporter,
  BatchTraceProcessor,
  setTraceProcessors,
  type Span,
  type GenerationSpanData,
  type Trace,
} from '@openai/agents-core';
import { logModelAndToolActionError } from '@openai/agents-core/utils/internal';
import { getTracingExportApiKey, HEADERS } from './defaults';
import logger from './logger';
import {
  truncateSpanFieldValue,
  sanitizeGenerationUsageForTracesIngest,
} from './tracingFieldProcessing';

/**
 * Options for OpenAITracingExporter.
 */
export type OpenAITracingExporterOptions = {
  apiKey?: string;
  organization: string;
  project: string;
  endpoint: string;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
};

const OPENAI_TRACING_INGEST_ENDPOINT =
  'https://api.openai.com/v1/traces/ingest';

function retryAfterMs(headers: Headers): number | undefined {
  const milliseconds = headers.get('retry-after-ms')?.trim();
  if (milliseconds) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  const retryAfter = headers.get('retry-after')?.trim();
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds)) {
    const value = seconds * 1000;
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(true);
    }, delayMs);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGenerationSpanData(
  spanData: Record<string, unknown>,
): spanData is GenerationSpanData {
  return spanData.type === 'generation';
}

function isGenerationUsageData(
  usage: unknown,
): usage is NonNullable<GenerationSpanData['usage']> {
  return isRecord(usage);
}

function cloneRecordSafely(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const clone: Record<string, unknown> = {};

  for (const key of Object.keys(value)) {
    try {
      clone[key] = value[key];
    } catch {
      // Omit unreadable properties so tracing export remains non-fatal.
    }
  }

  return clone;
}

function omitAssistantReasoning(value: unknown): unknown {
  if (!isRecord(value) || value.role !== 'assistant') {
    return value;
  }

  const message = { ...value };
  delete message.reasoning;
  if (Array.isArray(message.content)) {
    message.content = message.content
      .filter((part) => !isRecord(part) || part.type !== 'reasoning')
      .map((part) => {
        if (
          !isRecord(part) ||
          (part.type !== 'text' && part.type !== 'refusal')
        ) {
          return part;
        }
        // Chat Completions replay copies message provider data onto these parts.
        const content = { ...part };
        delete content.reasoning;
        return content;
      });
  }
  return message;
}

/** Filter known generation shapes, without traversing user or tool JSON. */
function omitGenerationReasoning(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value
    .filter((item) => !isRecord(item) || item.type !== 'reasoning')
    .map((item) => {
      if (
        isRecord(item) &&
        item.object === 'chat.completion' &&
        Array.isArray(item.choices)
      ) {
        return {
          ...item,
          choices: item.choices.map((choice) =>
            isRecord(choice) && isRecord(choice.message)
              ? { ...choice, message: omitAssistantReasoning(choice.message) }
              : choice,
          ),
        };
      }
      return omitAssistantReasoning(item);
    });
}

/**
 * OpenAI traces ingest currently accepts only input/output token counts at the top-level
 * generation usage object. Keep those fields and move other usage data under `usage.details`
 * to avoid non-fatal 400 client errors.
 */
function sanitizeSpanDataForTracesIngest(
  spanData: Record<string, unknown>,
  omitReasoning: boolean,
): Record<string, unknown> {
  let sanitizedSpanData = spanData;
  let didMutate = false;

  for (const fieldName of ['input', 'output']) {
    if (!(fieldName in spanData)) {
      continue;
    }

    let fieldValue: unknown;
    let exportValue: unknown;
    try {
      fieldValue = spanData[fieldName];
      // Filter before truncation so reasoning does not consume the field budget.
      // Work on export-only copies: custom processors retain the original spans.
      exportValue =
        omitReasoning && isGenerationSpanData(spanData)
          ? omitGenerationReasoning(fieldValue)
          : fieldValue;
    } catch {
      if (!didMutate) {
        sanitizedSpanData = cloneRecordSafely(spanData);
        didMutate = true;
      }

      delete sanitizedSpanData[fieldName];
      continue;
    }

    const sanitizedField = truncateSpanFieldValue(exportValue);
    if (sanitizedField === fieldValue) {
      continue;
    }

    if (!didMutate) {
      sanitizedSpanData = cloneRecordSafely(spanData);
      didMutate = true;
    }
    sanitizedSpanData[fieldName] = sanitizedField;
  }

  if (
    !isGenerationSpanData(spanData) ||
    !isGenerationUsageData(spanData.usage)
  ) {
    return didMutate ? sanitizedSpanData : spanData;
  }

  const sanitizedUsage = sanitizeGenerationUsageForTracesIngest(spanData.usage);
  if (!sanitizedUsage) {
    if (!didMutate) {
      sanitizedSpanData = cloneRecordSafely(spanData);
      didMutate = true;
    }

    delete sanitizedSpanData.usage;
    return sanitizedSpanData;
  }

  if (sanitizedUsage === spanData.usage) {
    return didMutate ? sanitizedSpanData : spanData;
  }

  if (!didMutate) {
    sanitizedSpanData = cloneRecordSafely(spanData);
  }
  sanitizedSpanData.usage = sanitizedUsage;
  return sanitizedSpanData;
}

function sanitizePayloadItemForTracesIngest(
  payloadItem: Record<string, unknown>,
  omitReasoning: boolean,
): Record<string, unknown> {
  if (payloadItem.object !== 'trace.span' || !isRecord(payloadItem.span_data)) {
    return payloadItem;
  }

  return {
    ...payloadItem,
    span_data: sanitizeSpanDataForTracesIngest(
      payloadItem.span_data,
      omitReasoning,
    ),
  };
}

/**
 * A tracing exporter that exports traces to OpenAI's tracing API.
 */
export class OpenAITracingExporter implements TracingExporter {
  #options: OpenAITracingExporterOptions;

  constructor(options: Partial<OpenAITracingExporterOptions> = {}) {
    this.#options = {
      apiKey: options.apiKey ?? undefined,
      organization: options.organization ?? '',
      project: options.project ?? '',
      endpoint: options.endpoint ?? OPENAI_TRACING_INGEST_ENDPOINT,
      maxRetries: options.maxRetries ?? 3,
      baseDelay: options.baseDelay ?? 1000,
      maxDelay: options.maxDelay ?? 30000,
    };
  }

  async export(
    items: (Trace | Span<any>)[],
    signal?: AbortSignal,
  ): Promise<void> {
    const defaultApiKey = this.#options.apiKey ?? getTracingExportApiKey();
    const itemsByKey = new Map<string | undefined, (Trace | Span<any>)[]>();

    for (const item of items) {
      const mapKey = (item as Trace & { tracingApiKey?: string }).tracingApiKey;
      const list = itemsByKey.get(mapKey) ?? [];
      list.push(item);
      itemsByKey.set(mapKey, list);
    }

    for (const [key, groupedItems] of itemsByKey.entries()) {
      // Item-level key wins; fall back to exporter config or environment.
      const apiKey = key ?? defaultApiKey;
      if (!apiKey) {
        logger.error(
          'No API key provided for OpenAI tracing exporter. Exports will be skipped',
        );
        continue;
      }

      const payloadItems = groupedItems
        .map((entry) => entry.toJSON())
        .filter((item) => !!item)
        .map((item) =>
          isRecord(item)
            ? sanitizePayloadItemForTracesIngest(
                item,
                this.#options.endpoint.replace(/\/$/, '') ===
                  OPENAI_TRACING_INGEST_ENDPOINT,
              )
            : item,
        );
      const payload = { data: payloadItems };

      let attempts = 0;
      let delay = this.#options.baseDelay;

      while (attempts < this.#options.maxRetries) {
        let serverDelay: number | undefined;
        try {
          const response = await fetch(this.#options.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'OpenAI-Beta': 'traces=v1',
              ...HEADERS,
            },
            body: JSON.stringify(payload),
            signal,
          });

          if (response.ok) {
            logger.debug(`Exported ${payload.data.length} items`);
            break;
          }

          const retryAdvice = response.headers
            ?.get('x-should-retry')
            ?.trim()
            .toLowerCase();
          const clientError = response.status >= 400 && response.status < 500;
          const shouldRetry =
            retryAdvice === 'true' ||
            (retryAdvice !== 'false' &&
              (!clientError ||
                response.status === 408 ||
                response.status === 409 ||
                response.status === 429));

          if (!shouldRetry) {
            if (clientError) {
              if (logger.dontLogModelData || logger.dontLogToolData) {
                try {
                  await response.body?.cancel();
                } catch {
                  // Best-effort cleanup must not replace the tracing response error.
                }
                logger.error(
                  `[non-fatal] Tracing client error ${response.status}. Response data is redacted.`,
                );
              } else {
                try {
                  logger.error(
                    `[non-fatal] Tracing client error ${
                      response.status
                    }: ${await response.text()}`,
                  );
                } catch {
                  logger.error(
                    `[non-fatal] Tracing client error ${response.status}. Response data could not be read.`,
                  );
                }
              }
            } else {
              try {
                await response.body?.cancel();
              } catch {
                // Best-effort cleanup must not replace the server retry veto.
              }
              logger.error(
                `[non-fatal] Tracing: server forbade retry for ${response.status}.`,
              );
            }
            break;
          }

          serverDelay = response.headers
            ? retryAfterMs(response.headers)
            : undefined;
          try {
            await response.body?.cancel();
          } catch {
            // Best-effort cleanup must not prevent retrying the batch.
          }
          logger.warn(
            `[non-fatal] Tracing: ${clientError ? 'client' : 'server'} error ${response.status}, retrying.`,
          );
        } catch (error: any) {
          logModelAndToolActionError(
            logger,
            '[non-fatal] Tracing: request failed:',
            error,
          );
        }

        if (signal?.aborted) {
          logger.error('Tracing: request aborted');
          break;
        }

        attempts++;
        if (attempts >= this.#options.maxRetries) {
          break;
        }

        let sleepTime = delay + Math.random() * 0.1 * delay; // 10% jitter
        if (serverDelay !== undefined) {
          sleepTime = Math.min(
            Math.max(sleepTime, serverDelay),
            this.#options.maxDelay,
          );
        }
        const shouldContinue = await sleepWithAbort(sleepTime, signal);
        if (!shouldContinue) {
          logger.error('Tracing: request aborted');
          break;
        }
        delay = Math.min(delay * 2, this.#options.maxDelay);
      }

      if (attempts >= this.#options.maxRetries) {
        logger.error(
          `Tracing: failed to export traces after ${
            this.#options.maxRetries
          } attempts`,
        );
      }
    }
  }
}

/**
 * Sets the OpenAI Tracing exporter as the default exporter with a BatchTraceProcessor handling the
 * traces
 */
export function setDefaultOpenAITracingExporter() {
  const exporter = new OpenAITracingExporter();
  const processor = new BatchTraceProcessor(exporter);
  setTraceProcessors([processor]);
}
