import { AsyncLocalStorage } from '@openai/agents-core/_shims';
import { Trace, TraceOptions } from './traces';
import { getGlobalTraceProvider } from './provider';
import { Span, SpanError } from './spans';
import { StreamedRunResult } from '../result';

type ContextState = {
  trace?: Trace;
  span?: Span<any>;
  previousSpan?: Span<any>;
  active: boolean;
};

const ALS_SYMBOL = Symbol.for('openai.agents.core.asyncLocalStorage');
let localFallbackAls: AsyncLocalStorage<ContextState | undefined> | undefined;

// Global symbols ensure that if multiple copies of agents-core are loaded
// (e.g., via different npm resolution paths or bundlers), they all share the
// same AsyncLocalStorage instance. This prevents losing trace/span state when a
// downstream package pulls in a duplicate copy.
function getContextAsyncLocalStorage() {
  try {
    const globalScope = globalThis as unknown as Record<
      symbol | string,
      AsyncLocalStorage<ContextState | undefined> | undefined
    >;

    const globalALS = globalScope[ALS_SYMBOL];

    if (globalALS) {
      return globalALS;
    }

    const newALS = new AsyncLocalStorage<ContextState | undefined>();
    globalScope[ALS_SYMBOL] = newALS;
    return newALS;
  } catch {
    // As a defensive fallback (e.g., if globalThis is locked down or ALS
    // construction throws in a constrained runtime), keep a module-local ALS so
    // tracing still functions instead of crashing callers.
    if (!localFallbackAls) {
      localFallbackAls = new AsyncLocalStorage<ContextState | undefined>();
    }
    return localFallbackAls;
  }
}

function getActiveContext() {
  const store = getContextAsyncLocalStorage().getStore();
  if (store?.active === true) {
    return store;
  }
  return undefined;
}

/**
 * This function will get the current trace from the execution context.
 *
 * @returns The current trace or null if there is no trace.
 */
export function getCurrentTrace() {
  const currentTrace = getActiveContext();
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
  const currentSpan = getActiveContext();
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
function _wrapFunctionWithTraceLifecycle<T>(
  fn: (trace: Trace) => Promise<T>,
  currentContext: ContextState,
  previousAlsStore?: ContextState,
) {
  return async () => {
    const trace = getCurrentTrace();
    if (!trace) {
      throw new Error('No trace found');
    }

    let cleanupDeferred = false;
    let started = false;

    const cleanupContext = () => {
      currentContext.active = false;
      currentContext.trace = undefined;
      currentContext.span = undefined;
      currentContext.previousSpan = undefined;
      getContextAsyncLocalStorage().enterWith(previousAlsStore);
    };

    try {
      await trace.start();
      started = true;

      const result = await fn(trace);

      // If result is a StreamedRunResult, defer trace end until stream loop completes
      if (result instanceof StreamedRunResult) {
        const streamLoopPromise = result._getStreamLoopPromise();
        if (streamLoopPromise) {
          cleanupDeferred = true;
          streamLoopPromise.finally(async () => {
            try {
              if (started) {
                await trace.end();
              }
            } finally {
              cleanupContext();
            }
          });

          return result;
        }
      }

      // For non-streaming results, end trace synchronously
      if (started) {
        await trace.end();
      }

      return result;
    } finally {
      // If cleanup was deferred to the streaming loop, keep the context marked
      // active so concurrent traces do not clear it prematurely. Otherwise,
      // mark inactive and restore now.
      if (!cleanupDeferred) {
        cleanupContext();
      }
    }
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

  const context: ContextState = {
    trace: newTrace,
    active: true,
  };
  const previousAlsStore = getContextAsyncLocalStorage().getStore();

  return getContextAsyncLocalStorage().run(
    context,
    _wrapFunctionWithTraceLifecycle(fn, context, previousAlsStore),
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
    return await fn();
  }

  const newTrace = getGlobalTraceProvider().createTrace(options);

  const newContext: ContextState = {
    trace: newTrace,
    active: true,
  };
  const previousAlsStore = getContextAsyncLocalStorage().getStore();
  return getContextAsyncLocalStorage().run(
    newContext,
    _wrapFunctionWithTraceLifecycle(fn, newContext, previousAlsStore),
  );
}

/**
 * This function will set the current span in the execution context.
 *
 * @param span - The span to set as the current span.
 */
export function setCurrentSpan(span: Span<any>) {
  const context = getActiveContext();
  if (!context) {
    throw new Error('No existing trace found');
  }

  if (context.span) {
    context.span.previousSpan = context.previousSpan;
    context.previousSpan = context.span;
  }

  span.previousSpan = context.span ?? context.previousSpan;
  context.span = span;
  getContextAsyncLocalStorage().enterWith(context);
}

export function resetCurrentSpan() {
  const context = getActiveContext();
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
    active: context.active,
  };
}

/**
 * This function will run the given function with a new span context.
 *
 * @param fn - The function to run with the new span context.
 */
export function withNewSpanContext<T>(fn: () => Promise<T>) {
  const currentContext = getActiveContext();
  if (!currentContext) {
    return fn();
  }

  const copyOfContext = cloneCurrentContext(currentContext);
  return getContextAsyncLocalStorage().run(copyOfContext, fn);
}
