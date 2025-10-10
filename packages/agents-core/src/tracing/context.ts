import { AsyncLocalStorage } from '@openai/agents-core/_shims';
import { Trace, TraceOptions } from './traces';
import { getGlobalTraceProvider } from './provider';
import { Span, SpanError } from './spans';
import { StreamedRunResult } from '../result';

type ContextState = {
  trace?: Trace;
  span?: Span<any>;
  previousSpan?: Span<any>;
};

let _contextAsyncLocalStorage: AsyncLocalStorage<ContextState> | undefined;

function getContextAsyncLocalStorage() {
  _contextAsyncLocalStorage ??= new AsyncLocalStorage<ContextState>();
  return _contextAsyncLocalStorage;
}

/**
 * This function will get the current trace from the execution context.
 *
 * @returns The current trace or null if there is no trace.
 */
export function getCurrentTrace() {
  const currentTrace = getContextAsyncLocalStorage().getStore();
  if (currentTrace?.trace) {
    return currentTrace.trace;
  }

  return null;
}

/**
 * This function will get the current span from the execution context.
 *
 * @returns The current span or null if there is no span.
 */
export function getCurrentSpan() {
  const currentSpan = getContextAsyncLocalStorage().getStore();
  if (currentSpan?.span) {
    return currentSpan.span;
  }
  return null;
}

/**
 * This is an AsyncLocalStorage instance that stores the current trace.
 * It will automatically handle the execution context of different event loop executions.
 *
 * The functions below should be the only way that this context gets interfaced with.
 */
function _wrapFunctionWithTraceLifecycle<T>(fn: (trace: Trace) => Promise<T>) {
  return async () => {
    const trace = getCurrentTrace();
    if (!trace) {
      throw new Error('No trace found');
    }

    await trace.start();
    const result = await fn(trace);

    // If result is a StreamedRunResult, defer trace end until stream loop completes
    if (result instanceof StreamedRunResult) {
      const streamLoopPromise = result._getStreamLoopPromise();
      if (streamLoopPromise) {
        streamLoopPromise.finally(() => trace.end());
        return result;
      }
    }

    // For non-streaming results, end trace synchronously
    await trace.end();

    return result;
  };
}

/**
 * This function will create a new trace and assign it to the execution context of the function
 * passed to it.
 *
 * @param fn - The function to run and assign the trace context to.
 * @param options - Options for the creation of the trace
 */

export async function withTrace<T>(
  trace: string | Trace,
  fn: (trace: Trace) => Promise<T>,
  options: TraceOptions = {},
): Promise<T> {
  const newTrace =
    typeof trace === 'string'
      ? getGlobalTraceProvider().createTrace({
          ...options,
          name: trace,
        })
      : trace;

  return getContextAsyncLocalStorage().run(
    { trace: newTrace },
    _wrapFunctionWithTraceLifecycle(fn),
  );
}
/**
 * This function will check if there is an existing active trace in the execution context. If there
 * is, it will run the given function with the existing trace. If there is no trace, it will create
 * a new one and assign it to the execution context of the function.
 *
 * @param fn - The fzunction to run and assign the trace context to.
 * @param options - Options for the creation of the trace
 */
export async function getOrCreateTrace<T>(
  fn: () => Promise<T>,
  options: TraceOptions = {},
): Promise<T> {
  const currentTrace = getCurrentTrace();
  if (currentTrace) {
    // if this execution context already has a trace instance in it we just continue
    return await fn();
  }

  const newTrace = getGlobalTraceProvider().createTrace(options);

  return getContextAsyncLocalStorage().run(
    { trace: newTrace },
    _wrapFunctionWithTraceLifecycle(fn),
  );
}

/**
 * This function will set the current span in the execution context.
 *
 * @param span - The span to set as the current span.
 */
export function setCurrentSpan(span: Span<any>) {
  const context = getContextAsyncLocalStorage().getStore();
  if (!context) {
    throw new Error('No existing trace found');
  }

  if (context.span) {
    context.span.previousSpan = context.previousSpan;
    context.previousSpan = context.span;
  }
  context.span = span;
  getContextAsyncLocalStorage().enterWith(context);
}

export function resetCurrentSpan() {
  const context = getContextAsyncLocalStorage().getStore();
  if (context) {
    context.span = context.previousSpan;
    context.previousSpan = context.previousSpan?.previousSpan;
    getContextAsyncLocalStorage().enterWith(context);
  }
}

/**
 * This function will add an error to the current span.
 *
 * @param spanError - The error to add to the current span.
 */
export function addErrorToCurrentSpan(spanError: SpanError) {
  const currentSpan = getCurrentSpan();
  if (currentSpan) {
    currentSpan.setError(spanError);
  }
}

/**
 * This function will clone the current context by creating new instances of the trace, span, and
 * previous span.
 *
 * @param context - The context to clone.
 * @returns A clone of the context.
 */
export function cloneCurrentContext(context: ContextState) {
  return {
    trace: context.trace?.clone(),
    span: context.span?.clone(),
    previousSpan: context.previousSpan?.clone(),
  };
}

/**
 * This function will run the given function with a new span context.
 *
 * @param fn - The function to run with the new span context.
 */
export function withNewSpanContext<T>(fn: () => Promise<T>) {
  const currentContext = getContextAsyncLocalStorage().getStore();
  if (!currentContext) {
    throw new Error('No existing trace found');
  }

  const copyOfContext = cloneCurrentContext(currentContext);

  return getContextAsyncLocalStorage().run(copyOfContext, fn);
}
