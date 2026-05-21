import { Span as TSpan } from './spans';
import { Trace } from './traces';
import logger from '../logger';
import {
  timer as _timer,
  isTracingLoopRunningByDefault,
} from '@openai/agents-core/_shims';
import type { Timeout, Timer } from '../shims/interface';
import { tracing } from '../config';
import { combineAbortSignals } from '../utils/abortSignals';
import { NOOP_TRACE_OR_SPAN_ID } from './utils';

type Span = TSpan<any>;

/**
 * Interface for processing traces
 */
export interface TracingProcessor {
  /**
   * Called when the trace processor should start processing traces.
   * Only available if the processor is performing tasks like exporting traces in a loop to start
   * the loop
   */
  start?(): void;

  /***
   * Called when a trace is started
   */
  onTraceStart(trace: Trace): Promise<void>;

  /**
   * Called when a trace is ended
   */
  onTraceEnd(trace: Trace): Promise<void>;

  /**
   * Called when a span is started
   */
  onSpanStart(span: Span): Promise<void>;

  /**
   * Called when a span is ended
   */
  onSpanEnd(span: Span): Promise<void>;

  /**
   * Called when the trace processor is shutting down
   */
  shutdown(timeout?: number): Promise<void>;

  /**
   * Called when a trace is being flushed
   */
  forceFlush(): Promise<void>;
}

/**
 * Exports traces and spans. For example, could log them or send them to a backend.
 */
export interface TracingExporter {
  /**
   * Export the given traces and spans
   * @param items - The traces and spans to export
   */
  export(items: (Trace | Span)[], signal?: AbortSignal): Promise<void>;
}

/**
 * Prints the traces and spans to the console
 */
export class ConsoleSpanExporter implements TracingExporter {
  async export(items: (Trace | Span)[]): Promise<void> {
    if (tracing.disabled) {
      logger.debug('Tracing is disabled. Skipping export');
      return;
    }

    for (const item of items) {
      if (item.type === 'trace') {
        console.log(
          `[Exporter] Export trace traceId=${item.traceId} name=${item.name}${item.groupId ? ` groupId=${item.groupId}` : ''}`,
        );
      } else {
        console.log(`[Exporter] Export span: ${JSON.stringify(item)}`);
      }
    }
  }
}

export type BatchTraceProcessorOptions = {
  /**
   * The maximum number of spans to store in the queue. After this, we will start dropping spans.
   */
  maxQueueSize?: number;
  /**
   * The maximum number of spans to export in a single batch.
   */
  maxBatchSize?: number;
  /**
   * The delay between checks for new spans to export in milliseconds.
   */
  scheduleDelay?: number;
  /**
   * The ratio of the queue size at which we will trigger an export.
   */
  exportTriggerRatio?: number;
};

export class BatchTraceProcessor implements TracingProcessor {
  readonly #maxQueueSize: number;
  readonly #maxBatchSize: number;
  readonly #scheduleDelay: number;
  readonly #exportTriggerSize: number;
  readonly #exporter: TracingExporter;

  #buffer: Array<Trace | Span> = [];
  #timer: Timer;
  #timeout: Timeout | null = null;
  #exportInProgress = false;
  #timeoutAbortController: AbortController | null = null;
  #activeExportAbortControllers = new Set<AbortController>();

  constructor(
    exporter: TracingExporter,
    {
      maxQueueSize = 1000,
      maxBatchSize = 100,
      scheduleDelay = 5000, // 5 seconds
      exportTriggerRatio = 0.8,
    }: BatchTraceProcessorOptions = {},
  ) {
    this.#maxQueueSize = maxQueueSize;
    this.#maxBatchSize = maxBatchSize;
    this.#scheduleDelay = scheduleDelay;
    this.#exportTriggerSize = maxQueueSize * exportTriggerRatio;
    this.#exporter = exporter;
    this.#timer = _timer;
    if (isTracingLoopRunningByDefault()) {
      this.start();
    } else {
      logger.debug(
        'Automatic trace export loop is not supported in this environment. You need to manually call `getGlobalTraceProvider().forceFlush()` to export traces.',
      );
    }
  }

  start(): void {
    this.#timeoutAbortController = new AbortController();
    this.#runExportLoop();
  }

  async #safeAddItem(item: Trace | Span): Promise<void> {
    if (this.#buffer.length + 1 > this.#maxQueueSize) {
      logger.error('Dropping trace because buffer is full');
      return;
    }

    // add the item to the buffer
    this.#buffer.push(item);

    if (this.#buffer.length > this.#exportTriggerSize) {
      // start exporting immediately
      await this.#exportBatches();
    }
  }

  #runExportLoop(): void {
    this.#timeout = this.#timer.setTimeout(async () => {
      // scheduled export
      await this.#exportBatches();
      this.#runExportLoop();
    }, this.#scheduleDelay);

    // We set this so that Node no longer considers this part of the event loop and keeps the
    // process alive until the timer is done.
    if (typeof this.#timeout.unref === 'function') {
      this.#timeout.unref();
    }
  }

  async #exportBatches(
    force: boolean = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#buffer.length === 0) {
      return;
    }

    logger.debug(
      `Exporting batches. Force: ${force}. Buffer size: ${this.#buffer.length}`,
    );

    const exportBatch = async (batch: Array<Trace | Span>): Promise<void> => {
      this.#exportInProgress = true;
      const activeExportAbortController = new AbortController();
      this.#activeExportAbortControllers.add(activeExportAbortController);
      const combinedSignal = combineAbortSignals(
        signal,
        activeExportAbortController.signal,
      );
      try {
        await this.#exporter.export(batch, combinedSignal.signal);
      } catch (error) {
        logger.error('Tracing exporter failed to export batch', error);
      } finally {
        combinedSignal.cleanup();
        this.#activeExportAbortControllers.delete(activeExportAbortController);
        this.#exportInProgress = this.#activeExportAbortControllers.size > 0;
      }
    };

    if (force || this.#buffer.length < this.#maxBatchSize) {
      const toExport = [...this.#buffer];
      this.#buffer = [];
      await exportBatch(toExport);
    } else if (this.#buffer.length > 0) {
      const batch = this.#buffer.splice(0, this.#maxBatchSize);
      await exportBatch(batch);
    }
  }

  #abortActiveExports(): void {
    for (const controller of this.#activeExportAbortControllers) {
      controller.abort();
    }
  }

  async #waitForShutdownProgress(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      const state: { timeout?: Timeout } = {};
      const cleanup = () => {
        if (state.timeout) {
          this.#timer.clearTimeout(state.timeout);
        }
        signal?.removeEventListener('abort', onAbort);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => done();

      state.timeout = this.#timer.setTimeout(done, 500);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async onTraceStart(trace: Trace): Promise<void> {
    await this.#safeAddItem(trace);
  }

  async onTraceEnd(_trace: Trace): Promise<void> {
    // We don't send traces on end because we already send them on start
  }

  async onSpanStart(_span: Span): Promise<void> {
    // We don't send spans on start because we send them at the end
  }

  async onSpanEnd(span: Span): Promise<void> {
    await this.#safeAddItem(span);
  }

  async shutdown(timeout?: number): Promise<void> {
    let shutdownTimeout: Timeout | undefined;
    const shutdownAbortController = timeout
      ? (this.#timeoutAbortController ?? new AbortController())
      : undefined;

    if (timeout) {
      this.#timeoutAbortController = shutdownAbortController ?? null;
      shutdownTimeout = this.#timer.setTimeout(() => {
        // Force shutdown the HTTP request.
        shutdownAbortController?.abort();
        this.#abortActiveExports();
      }, timeout);

      if (typeof shutdownTimeout.unref === 'function') {
        shutdownTimeout.unref();
      }
    }

    try {
      logger.debug('Shutting down gracefully');
      while (this.#buffer.length > 0 || this.#exportInProgress) {
        logger.debug(
          `Waiting for buffer to empty. Items left: ${this.#buffer.length}`,
        );
        if (!this.#exportInProgress && this.#buffer.length > 0) {
          // No current export in progress. Forcing all items to be exported.
          await this.#exportBatches(true, shutdownAbortController?.signal);
        }
        if (shutdownAbortController?.signal.aborted) {
          logger.debug('Timeout reached, force flushing');
          break;
        }
        // Using setTimeout to add to the event loop and keep this alive until done.
        await this.#waitForShutdownProgress(shutdownAbortController?.signal);
      }
      logger.debug('Buffer empty. Exiting');
    } finally {
      if (shutdownTimeout) {
        this.#timer.clearTimeout(shutdownTimeout);
      }
      if (this.#timer && this.#timeout) {
        // Making sure there are no more requests.
        this.#timer.clearTimeout(this.#timeout);
      }
    }
  }

  async forceFlush(): Promise<void> {
    if (this.#buffer.length > 0) {
      await this.#exportBatches(true);
    }
  }
}

export class MultiTracingProcessor implements TracingProcessor {
  #processors: TracingProcessor[] = [];

  start(): void {
    for (const processor of this.#processors) {
      if (processor.start) {
        processor.start();
      }
    }
  }

  addTraceProcessor(processor: TracingProcessor): void {
    this.#processors.push(processor);
  }

  setProcessors(processors: TracingProcessor[]): void {
    logger.debug('Shutting down old processors');
    for (const processor of this.#processors) {
      processor.shutdown();
    }
    this.#processors = processors;
  }

  async onTraceStart(trace: Trace): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onTraceStart(trace);
    }
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onTraceEnd(trace);
    }
  }

  async onSpanStart(span: Span): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onSpanStart(span);
    }
  }

  async onSpanEnd(span: Span): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onSpanEnd(span);
    }
  }

  /**
   * Dispatches a completed trace lifecycle to every registered processor without
   * calling Trace.start() or Trace.end().
   */
  async dispatchTrace(trace: Trace): Promise<void> {
    if (trace.traceId === NOOP_TRACE_OR_SPAN_ID) {
      return;
    }

    await this.onTraceStart(trace);
    await this.onTraceEnd(trace);
  }

  /**
   * Dispatches a completed span lifecycle to every registered processor without
   * calling Span.start() or Span.end().
   */
  async dispatchSpan(span: Span): Promise<void> {
    if (
      span.traceId === NOOP_TRACE_OR_SPAN_ID ||
      span.spanId === NOOP_TRACE_OR_SPAN_ID
    ) {
      return;
    }

    await this.onSpanStart(span);
    await this.onSpanEnd(span);
  }

  async shutdown(timeout?: number): Promise<void> {
    for (const processor of this.#processors) {
      await processor.shutdown(timeout);
    }
  }

  async forceFlush(): Promise<void> {
    for (const processor of this.#processors) {
      await processor.forceFlush();
    }
  }
}

let _defaultExporter: ConsoleSpanExporter | null = null;
let _defaultProcessor: BatchTraceProcessor | null = null;

export function defaultExporter(): TracingExporter {
  if (!_defaultExporter) {
    _defaultExporter = new ConsoleSpanExporter();
  }

  return _defaultExporter;
}

export function defaultProcessor(): TracingProcessor {
  if (!_defaultProcessor) {
    _defaultProcessor = new BatchTraceProcessor(defaultExporter());
  }
  return _defaultProcessor;
}
