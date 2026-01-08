import { AsyncLocalStorage } from '@openai/agents-core/_shims';
import { Trace, TraceOptions } from './traces';
import { getGlobalTraceProvider } from './provider';
import { Span, SpanError } from './spans';
import { StreamedRunResult } from '../result';

type ContextState = {
  trace?: Trace;
  span?: Span<any>;
  previousSpan?: Span<any>;
  active?: boolean;
  // Unique per trace; used only for identity checks to gate global fallback usage.
  fallbackOwnerToken?: symbol;
};

const ALS_SYMBOL = Symbol.for('openai.agents.core.asyncLocalStorage');
const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
const FALLBACK_OWNERS_SYMBOL = Symbol.for(
  'openai.agents.core.globalFallbackOwners',
);
let localFallbackAls: AsyncLocalStorage<ContextState> | undefined;
let localFallbackOwners: Set<symbol> | undefined;

function getFallbackOwnerSet() {
  try {
    const globalScope = globalThis as unknown as Record<
      symbol | string,
      Set<symbol> | undefined
    >;
    if (!globalScope[FALLBACK_OWNERS_SYMBOL]) {
      globalScope[FALLBACK_OWNERS_SYMBOL] = new Set<symbol>();
    }
    return globalScope[FALLBACK_OWNERS_SYMBOL]!;
  } catch {
    if (!localFallbackOwners) {
      localFallbackOwners = new Set<symbol>();
    }
    return localFallbackOwners;
  }
}

// Global symbols ensure that if multiple copies of agents-core are loaded
// (e.g., via different npm resolution paths or bundlers), they all share the
// same AsyncLocalStorage instance and last-known context. This prevents losing
// trace/span state when a downstream package pulls in a duplicate copy.
// The global fallback should be considered a best-effort safety net only; the
// primary isolation still comes from AsyncLocalStorage when available.
function getContextAsyncLocalStorage() {
  try {
    const globalScope = globalThis as unknown as Record<
      symbol | string,
      AsyncLocalStorage<ContextState> | undefined
    >;

    const globalALS = globalScope[ALS_SYMBOL];

    if (globalALS) {
      return globalALS;
    }

    const newALS = new AsyncLocalStorage<ContextState>();
    globalScope[ALS_SYMBOL] = newALS;
    return newALS;
  } catch {
    // Only allow global fallback lookups if the runtime failed to construct
    // AsyncLocalStorage (e.g., locked-down globalThis or limited runtime).
    // As a defensive fallback (e.g., if globalThis is locked down or ALS
    // construction throws in a constrained runtime), keep a module-local ALS
    // so tracing still functions instead of crashing callers.
    if (!localFallbackAls) {
      localFallbackAls = new AsyncLocalStorage<ContextState>();
    }
    return localFallbackAls;
  }
}

// Store the latest context in globalThis so that, if AsyncLocalStorage store
// lookup fails (duplicate copy, boundary hops), we can still resume tracing.
function setGlobalContext(context: ContextState) {
  try {
    const globalScope = globalThis as unknown as Record<
      symbol | string,
      ContextState | undefined
    >;
    // Best-effort cache of the last active context so runtimes that lose
    // AsyncLocalStorage propagation (or load a duplicate bundle) can still
    // resume tracing.
    globalScope[CONTEXT_SYMBOL] = context;
    if (context.fallbackOwnerToken) {
      getFallbackOwnerSet().add(context.fallbackOwnerToken);
    }
  } catch {
    // Best-effort only: if the global object is non-extensible (SES, locked-down
    // runtimes), swallow the failure and rely on AsyncLocalStorage/module-local
    // context rather than crashing the caller.
  }
}

// Retrieve the fallback context if AsyncLocalStorage has no store. This is
// a best-effort safety net for environments that accidentally load multiple
// copies of agents-core or lose ALS scope (e.g., certain worker runtimes).
function getGlobalContext(): ContextState | undefined {
  try {
    const globalScope = globalThis as unknown as Record<
      symbol | string,
      ContextState | undefined
    >;
    return globalScope[CONTEXT_SYMBOL];
  } catch {
    return undefined;
  }
}

function restoreGlobalContext(
  expectedContext: ContextState,
  previousContext?: ContextState,
  expectedTrace?: Trace,
  options?: { removeOwnerToken?: boolean },
) {
  try {
    const globalScope = globalThis as unknown as Record<
      symbol | string,
      ContextState | undefined
    >;
    const currentGlobalContext = globalScope[CONTEXT_SYMBOL];

    const shouldMutateOwners =
      options?.removeOwnerToken ?? expectedContext.active === false;

    // Always remove our owner token even if another trace replaced the global
    // fallback; this keeps the owner count accurate for fallback gating.
    if (shouldMutateOwners && expectedContext.fallbackOwnerToken) {
      getFallbackOwnerSet().delete(expectedContext.fallbackOwnerToken);
    }

    // Only restore if the global fallback still points to the context this trace
    // installed. If another concurrent trace updated the global context in the
    // meantime, leave it intact to avoid clobbering that run. Consider contexts
    // equivalent when they reference the same trace, even if a cloned context
    // was installed (e.g., via withNewSpanContext).
    const matchesTrace = (left?: ContextState): boolean => {
      if (!left) {
        return false;
      }

      if (left === expectedContext) {
        return true;
      }

      if (
        expectedContext.fallbackOwnerToken &&
        left.fallbackOwnerToken === expectedContext.fallbackOwnerToken
      ) {
        return true;
      }

      if (expectedTrace && left.trace) {
        return left.trace === expectedTrace;
      }

      return false;
    };

    if (!matchesTrace(currentGlobalContext)) {
      return;
    }

    if (previousContext?.active) {
      globalScope[CONTEXT_SYMBOL] = previousContext;
      if (shouldMutateOwners && previousContext.fallbackOwnerToken) {
        getFallbackOwnerSet().add(previousContext.fallbackOwnerToken);
      }
    } else {
      delete globalScope[CONTEXT_SYMBOL];
    }
  } catch {
    // If global mutation is disallowed, do not crash; tracing will continue to
    // rely on AsyncLocalStorage or module-local context.
  }
}

function getActiveContext() {
  const store = getContextAsyncLocalStorage().getStore();
  // Treat an inactive store sentinel as "no store" so that we still consult the
  // global fallback in runtimes that lose AsyncLocalStorage propagation.
  if (store?.active === false) {
    // Fall through to global fallback lookup.
  } else if (store) {
    return store;
  }

  const fallback = getGlobalContext();
  if (!fallback || fallback.active === false) {
    return undefined;
  }

  const owners = getFallbackOwnerSet();
  const ownerToken = fallback.fallbackOwnerToken;

  // Only use the global fallback when we can confirm a single active owner.
  // This avoids cross-trace leakage when AsyncLocalStorage propagation is lost
  // but multiple traces are running concurrently.
  if (ownerToken && owners.has(ownerToken) && owners.size === 1) {
    return fallback;
  }

  if (!ownerToken && owners.size <= 1) {
    return fallback;
  }

  return undefined;
}

function selectNextContext({
  previousAlsStore,
  previousFallbackContext,
}: {
  previousAlsStore?: ContextState;
  previousFallbackContext?: ContextState;
}) {
  // Prefer the original ALS store; if missing, only re-install the global
  // fallback when a single owner is active to avoid cross-trace contamination.
  if (previousAlsStore) {
    return previousAlsStore;
  }

  const fallbackOwners = getFallbackOwnerSet();
  const canRestoreFallback =
    previousFallbackContext?.active &&
    previousFallbackContext.fallbackOwnerToken &&
    fallbackOwners.size === 1 &&
    fallbackOwners.has(previousFallbackContext.fallbackOwnerToken);

  if (canRestoreFallback) {
    return previousFallbackContext;
  }

  // No safe fallback available—return an inactive sentinel to clear the store.
  return { active: false } as ContextState;
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
  previousContext?: ContextState,
  previousAlsStore?: ContextState,
) {
  return async () => {
    // Preserve the original trace reference so cleanup can recognize cloned
    // contexts that may have been installed during nested span scopes.
    const expectedTrace = currentContext.trace;
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
      restoreGlobalContext(currentContext, previousContext, expectedTrace);
      const nextContext = selectNextContext({
        previousAlsStore,
        previousFallbackContext: previousContext,
      });
      getContextAsyncLocalStorage().enterWith(nextContext);
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
    fallbackOwnerToken: Symbol('trace-fallback-owner'),
  };
  const previousContext = getGlobalContext();
  const previousAlsStore = getContextAsyncLocalStorage().getStore();
  setGlobalContext(context);

  return getContextAsyncLocalStorage().run(
    context,
    _wrapFunctionWithTraceLifecycle(
      fn,
      context,
      previousContext,
      previousAlsStore,
    ),
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
    const existingContext = getActiveContext();
    if (existingContext) {
      if (!existingContext.fallbackOwnerToken) {
        existingContext.fallbackOwnerToken = Symbol('trace-fallback-owner');
      }
      setGlobalContext(existingContext);
      getContextAsyncLocalStorage().enterWith(existingContext);
    }
    return await fn();
  }

  const newTrace = getGlobalTraceProvider().createTrace(options);

  const newContext: ContextState = {
    trace: newTrace,
    active: true,
    fallbackOwnerToken: Symbol('trace-fallback-owner'),
  };
  const previousContext = getGlobalContext();
  const previousAlsStore = getContextAsyncLocalStorage().getStore();
  setGlobalContext(newContext);
  return getContextAsyncLocalStorage().run(
    newContext,
    _wrapFunctionWithTraceLifecycle(
      fn,
      newContext,
      previousContext,
      previousAlsStore,
    ),
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
  setGlobalContext(context);
}

export function resetCurrentSpan() {
  const context = getActiveContext();
  if (context) {
    context.span = context.previousSpan;
    context.previousSpan = context.previousSpan?.previousSpan;
    getContextAsyncLocalStorage().enterWith(context);
    setGlobalContext(context);
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
    active: context.active ?? true,
    fallbackOwnerToken: context.fallbackOwnerToken,
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

  if (!currentContext.fallbackOwnerToken) {
    currentContext.fallbackOwnerToken = Symbol('trace-fallback-owner');
  }
  const copyOfContext = cloneCurrentContext(currentContext);
  const previousGlobalContext = getGlobalContext();
  const previousAlsStore = getContextAsyncLocalStorage().getStore();
  // Make the cloned context visible via the global fallback so runtimes without
  // AsyncLocalStorage propagation can still resolve the current span/trace.
  setGlobalContext(copyOfContext);
  const expectedTrace = currentContext.trace ?? copyOfContext.trace;

  return getContextAsyncLocalStorage().run(copyOfContext, async () => {
    try {
      return await fn();
    } finally {
      restoreGlobalContext(
        copyOfContext,
        previousGlobalContext,
        expectedTrace,
        {
          removeOwnerToken: false,
        },
      );
      const nextContext = selectNextContext({
        previousAlsStore,
        previousFallbackContext: previousGlobalContext,
      });
      getContextAsyncLocalStorage().enterWith(nextContext);
    }
  });
}
