import { TracingProcessor } from './processor';
import { getGlobalTraceProvider } from './provider';
import type { TracingConfig } from './config';

export {
  getCurrentSpan,
  getCurrentTrace,
  getOrCreateTrace,
  resetCurrentSpan,
  setCurrentSpan,
  withTrace,
} from './context';
export * from './createSpans';
export {
  BatchTraceProcessor,
  TracingExporter,
  TracingProcessor,
  ConsoleSpanExporter,
} from './processor';
export { NoopSpan, Span } from './spans';
export type {
  SpanData,
  AgentSpanData,
  FunctionSpanData,
  GenerationSpanData,
  ResponseSpanData,
  HandoffSpanData,
  CustomSpanData,
  GuardrailSpanData,
  TranscriptionSpanData,
  SpeechSpanData,
  SpeechGroupSpanData,
  MCPListToolsSpanData,
  SpanOptions,
  SpanError,
} from './spans';
export { NoopTrace, Trace } from './traces';
export { generateGroupId, generateSpanId, generateTraceId } from './utils';
export type { TracingConfig };

/**
 * Add a processor to the list of processors. Each processor will receive all traces/spans.
 *
 * @param processor - The processor to add.
 */
export function addTraceProcessor(processor: TracingProcessor): void {
  getGlobalTraceProvider().registerProcessor(processor);
}

/**
 * Set the list of processors. This will replace any existing processors.
 *
 * @param processors - The list of processors to set.
 */
export function setTraceProcessors(processors: TracingProcessor[]): void {
  getGlobalTraceProvider().setProcessors(processors);
}

/**
 * Set the disabled state of the tracing provider.
 *
 * @param disabled - Whether to disable tracing.
 */
export function setTracingDisabled(disabled: boolean): void {
  getGlobalTraceProvider().setDisabled(disabled);
}

/**
 * Start the trace export loop.
 */
export function startTraceExportLoop(): void {
  getGlobalTraceProvider().startExportLoop();
}
