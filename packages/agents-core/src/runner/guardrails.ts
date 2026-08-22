import { Agent, AgentOutputType } from '../agent';
import {
  AgentsError,
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  UserError,
} from '../errors';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
  InputGuardrailDefinition,
  InputGuardrailResult,
  OutputGuardrailDefinition,
  OutputGuardrailFunctionArgs,
  OutputGuardrailMetadata,
  OutputGuardrailResult,
} from '../guardrail';
import { RunState } from '../runState';
import type { AgentInputItem } from '../types';
import { getRunOutput } from './items';
import { withGuardrailSpan } from '../tracing';
import type { GuardrailFunctionOutput } from '../guardrail';
import type { ToolOutputGuardrailResult } from '../toolGuardrail';
import {
  isDataRedactedError,
  processFinalOutputWithRedaction,
} from '../utils/finalOutputError';

export type GuardrailTracker = {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly error: unknown;
  markPending: () => void;
  setPromise: (promise?: Promise<InputGuardrailResult[]>) => void;
  setError: (err: unknown) => void;
  throwIfError: () => Promise<void>;
  awaitCompletion: (options?: { suppressErrors?: boolean }) => Promise<void>;
};

export const createGuardrailTracker = (): GuardrailTracker => {
  let pending = false;
  let failed = false;
  let error: unknown = undefined;
  let promise: Promise<InputGuardrailResult[]> | undefined;

  const setError = (err: unknown) => {
    failed = true;
    error = err;
  };

  const setPromise = (incoming?: Promise<InputGuardrailResult[]>) => {
    if (!incoming) {
      return;
    }
    pending = true;
    promise = incoming
      .then((results) => results)
      .catch((err) => {
        setError(err);
        // Swallow to keep downstream flow consistent; failure is signaled via `failed`.
        return [];
      })
      .finally(() => {
        pending = false;
      });
  };

  const throwIfError = async () => {
    if (error) {
      if (promise) {
        await promise;
      }
      throw error;
    }
  };

  const awaitCompletion = async (options?: { suppressErrors?: boolean }) => {
    if (promise) {
      await promise;
    }
    if (error && !options?.suppressErrors) {
      throw error;
    }
  };

  return {
    get pending() {
      return pending;
    },
    get failed() {
      return failed;
    },
    get error() {
      return error;
    },
    markPending: () => {
      pending = true;
    },
    setPromise,
    setError,
    throwIfError,
    awaitCompletion,
  };
};

type GuardrailResultLike = {
  guardrail: { name: string };
  output: GuardrailFunctionOutput;
};

type ObservedGuardrailResult<TResult> = {
  result: TResult;
  tripwireTriggered: boolean;
};

const currentResponseOutputGuardrailResults = new WeakMap<
  RunState<any, any>,
  {
    response: RunState<any, any>['_lastTurnResponse'];
    results: Set<OutputGuardrailResult<any, any>>;
  }
>();

/** Validates restored result ownership without publishing live ownership evidence. */
export function getSerializedOutputGuardrailResults(
  state: RunState<any, any>,
  blockedOutput: string,
): Set<OutputGuardrailResult<any, any>> {
  const results = new Set<OutputGuardrailResult<any, any>>();
  for (const result of state._outputGuardrailResults) {
    if (result.agent !== state._currentAgent) {
      continue;
    }
    if (
      result.agentOutput !== blockedOutput ||
      result.output.outputInfo !== undefined
    ) {
      throw new UserError(
        'Cannot resume this serialized terminal output because previous output guardrail result ownership was not preserved. Continue the live RunState or start a new run from safe input.',
      );
    }
    results.add(result);
  }
  return results;
}

function getCurrentResponseOutputGuardrailResults(
  state: RunState<any, any>,
  guardedTerminalToolOutput: boolean,
  redactedOutput: string,
): Set<OutputGuardrailResult<any, any>> {
  const existing = currentResponseOutputGuardrailResults.get(state);
  if (existing && existing.response === state._lastTurnResponse) {
    return existing.results;
  }

  const results =
    guardedTerminalToolOutput &&
    state._serializedCurrentStep === state._currentStep
      ? getSerializedOutputGuardrailResults(state, redactedOutput)
      : new Set<OutputGuardrailResult<any, any>>();

  currentResponseOutputGuardrailResults.set(state, {
    response: state._lastTurnResponse,
    results,
  });
  return results;
}

async function runGuardrailsWithTripwire<
  TContext,
  TAgent extends Agent<TContext, any>,
  TArgs,
  TResult extends GuardrailResultLike,
>(options: {
  state: RunState<TContext, TAgent>;
  guardrails: { name: string; run: (args: TArgs) => Promise<TResult> }[];
  guardrailArgs: TArgs;
  resultsTarget: TResult[];
  onTripwire: (result: TResult) => never;
  isTripwireError: (error: unknown) => boolean;
  onError: (error: unknown) => unknown;
  onErrorObserved?: (error: unknown) => void;
  onResultObserved?: (result: TResult, tripwireTriggered: boolean) => void;
}): Promise<TResult[]> {
  const {
    state,
    guardrails,
    guardrailArgs,
    resultsTarget,
    onTripwire,
    isTripwireError,
    onError,
    onErrorObserved,
    onResultObserved,
  } = options;

  const guardrailPromises = guardrails.map(async (guardrail) => {
    const observedResult = await withGuardrailSpan(
      async (span) => {
        const result = await guardrail.run(guardrailArgs);
        const tripwireTriggered = result.output.tripwireTriggered;
        span.spanData.triggered = tripwireTriggered;
        return {
          result,
          tripwireTriggered,
        } satisfies ObservedGuardrailResult<TResult>;
      },
      { data: { name: guardrail.name } },
      state._currentAgentSpan,
    );
    onResultObserved?.(observedResult.result, observedResult.tripwireTriggered);
    return observedResult;
  });

  let resultsPublished = false;
  try {
    const observedResults = await Promise.all(guardrailPromises);
    const results = observedResults.map(({ result }) => result);
    resultsTarget.push(...results);
    resultsPublished = true;
    for (const { result, tripwireTriggered } of observedResults) {
      if (tripwireTriggered) {
        if (state._currentAgentSpan) {
          state._currentAgentSpan.setError({
            message: 'Guardrail tripwire triggered',
            data: { guardrail: result.guardrail.name },
          });
        }
        onTripwire(result);
      }
    }
    return results;
  } catch (error) {
    const finalError = isTripwireError(error) ? error : onError(error);
    onErrorObserved?.(finalError);
    // Promise.all rejects immediately, so drain the full batch before the
    // failure is surfaced to prevent sibling guardrails from outliving the run.
    const settledResults = await Promise.allSettled(guardrailPromises);
    if (!resultsPublished) {
      for (const result of settledResults) {
        if (result.status === 'fulfilled') {
          resultsTarget.push(result.value.result);
        }
      }
    }
    throw finalError;
  }
}

export function buildInputGuardrailDefinitions<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  state: RunState<TContext, TAgent>,
  runnerGuardrails: InputGuardrailDefinition[],
): InputGuardrailDefinition[] {
  return runnerGuardrails.concat(
    state._currentAgent.inputGuardrails.map(defineInputGuardrail),
  );
}

export function splitInputGuardrails(guardrails: InputGuardrailDefinition[]): {
  blocking: InputGuardrailDefinition[];
  parallel: InputGuardrailDefinition[];
} {
  const blocking: InputGuardrailDefinition[] = [];
  const parallel: InputGuardrailDefinition[] = [];

  for (const guardrail of guardrails) {
    if (guardrail.runInParallel === false) {
      blocking.push(guardrail);
    } else {
      parallel.push(guardrail);
    }
  }

  return { blocking, parallel };
}

export async function runInputGuardrails<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  state: RunState<TContext, TAgent>,
  guardrails: InputGuardrailDefinition[],
  options: {
    onErrorObserved?: (error: unknown) => void;
    input?: string | AgentInputItem[];
  } = {},
): Promise<InputGuardrailResult[]> {
  if (guardrails.length === 0) {
    return [];
  }
  const guardrailArgs = {
    agent: state._currentAgent,
    input: options.input ?? state._originalInput,
    context: state._context,
  };
  return await runGuardrailsWithTripwire({
    state,
    guardrails,
    guardrailArgs,
    resultsTarget: state._inputGuardrailResults,
    onTripwire: (result) => {
      throw new InputGuardrailTripwireTriggered(
        `Input guardrail triggered: ${JSON.stringify(result.output.outputInfo)}`,
        result,
        state,
      );
    },
    isTripwireError: (error) =>
      error instanceof InputGuardrailTripwireTriggered,
    onError: (error) => {
      return new GuardrailExecutionError(
        `Input guardrail failed to complete: ${error}`,
        error as Error,
        state,
      );
    },
    onErrorObserved: options.onErrorObserved,
  });
}

export async function runOutputGuardrails<
  TContext,
  TOutput extends AgentOutputType,
  TAgent extends Agent<TContext, TOutput>,
>(
  state: RunState<TContext, TAgent>,
  runnerOutputGuardrails: OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>
  >[],
  output: string,
  onResultObserved?: (
    result: OutputGuardrailResult<any, any>,
    tripwireTriggered: boolean,
  ) => void,
) {
  // Runner-level output guardrails are context-agnostic, so align them with the active run context type.
  const runnerGuardrails = runnerOutputGuardrails as OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>,
    TContext
  >[];
  const guardrails = runnerGuardrails.concat(
    state._currentAgent.outputGuardrails.map(defineOutputGuardrail),
  );
  if (guardrails.length === 0) {
    return;
  }
  const agentOutput =
    state._currentAgent.outputType === 'text'
      ? state._currentAgent.processFinalOutput(output)
      : processFinalOutputWithRedaction(() =>
          state._currentAgent.processFinalOutput(output),
        );
  const runOutput = getRunOutput(
    state._generatedItems,
    state._reasoningItemIdPolicy,
  );
  const guardrailArgs: OutputGuardrailFunctionArgs<TContext, TOutput> = {
    agent: state._currentAgent,
    agentOutput,
    context: state._context,
    details: {
      modelResponse: state._lastTurnResponse,
      output: runOutput,
    },
  };
  await runGuardrailsWithTripwire({
    state,
    guardrails,
    guardrailArgs,
    resultsTarget: state._outputGuardrailResults,
    onTripwire: (result) => {
      throw new OutputGuardrailTripwireTriggered(
        `Output guardrail triggered: ${JSON.stringify(result.output.outputInfo)}`,
        result,
        state,
      );
    },
    isTripwireError: (error) =>
      error instanceof OutputGuardrailTripwireTriggered,
    onError: (error) => {
      return new GuardrailExecutionError(
        `Output guardrail failed to complete: ${error}`,
        error as Error,
        state,
      );
    },
    onResultObserved,
  });
}

export async function finalizeOutputGuardrails<
  TContext,
  TAgent extends Agent<TContext, any>,
>(options: {
  state: RunState<TContext, TAgent>;
  runnerOutputGuardrails: OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>
  >[];
  output: string;
  redactedOutput: string;
  guardedTerminalToolOutput: boolean;
  signal?: AbortSignal;
  sanitizeRejectedOutput: (
    state: RunState<TContext, TAgent>,
    resultStart: number,
    completedTripwireResult: OutputGuardrailResult<any, any> | undefined,
    observedResults: ReadonlyMap<OutputGuardrailResult<any, any>, boolean>,
    tripwire?: OutputGuardrailTripwireTriggered<any, any>,
    ownedGuardrailResults?: ReadonlySet<OutputGuardrailResult<any, any>>,
  ) => false | string | Promise<false | string>;
  persistBlockedOutput?: () => Promise<void>;
  persistUnblockedFailure?: () => Promise<void>;
  releaseBlockedOutputPersistence: (state: RunState<TContext, TAgent>) => void;
}): Promise<void> {
  const {
    state,
    runnerOutputGuardrails,
    output,
    redactedOutput,
    guardedTerminalToolOutput,
    signal,
    sanitizeRejectedOutput,
    persistBlockedOutput,
    persistUnblockedFailure,
    releaseBlockedOutputPersistence,
  } = options;
  if (
    runnerOutputGuardrails.length === 0 &&
    state._currentAgent.outputGuardrails.length === 0
  ) {
    return;
  }
  const outputGuardrailResultStart = state._outputGuardrailResults.length;
  let completedTripwireResult: OutputGuardrailResult<any, any> | undefined;
  const observedResults = new Map<OutputGuardrailResult<any, any>, boolean>();
  const ownedGuardrailResults = getCurrentResponseOutputGuardrailResults(
    state,
    guardedTerminalToolOutput,
    redactedOutput,
  );

  try {
    await runOutputGuardrails(
      state,
      runnerOutputGuardrails,
      output,
      (guardrailResult, tripwireTriggered) => {
        ownedGuardrailResults.add(guardrailResult);
        observedResults.set(guardrailResult, tripwireTriggered);
        if (tripwireTriggered && !completedTripwireResult) {
          completedTripwireResult = guardrailResult;
        }
      },
    );
  } catch (error) {
    const currentTripwireResult =
      state._outputGuardrailResults
        .slice(outputGuardrailResultStart)
        .find(
          (result) =>
            ownedGuardrailResults.has(result) &&
            observedResults.get(result) === true,
        ) ?? completedTripwireResult;
    const outputBlockedResult = sanitizeRejectedOutput(
      state,
      outputGuardrailResultStart,
      currentTripwireResult,
      observedResults,
      error instanceof OutputGuardrailTripwireTriggered ? error : undefined,
      ownedGuardrailResults,
    );
    const outputBlockedMessage =
      typeof outputBlockedResult === 'string' || outputBlockedResult === false
        ? outputBlockedResult
        : await outputBlockedResult;
    signal?.throwIfAborted();
    const outputBlocked = outputBlockedMessage !== false;
    const blockedMessage = outputBlockedMessage || redactedOutput;
    const guardrailError = outputBlocked
      ? sanitizeBlockedOutputGuardrailError(
          error,
          output,
          blockedMessage,
          state,
          currentTripwireResult,
        )
      : error;
    const completedOutputTripwireError =
      completedTripwireResult !== undefined &&
      guardrailError instanceof OutputGuardrailTripwireTriggered;

    if (outputBlocked || completedOutputTripwireError) {
      if (persistBlockedOutput && !signal?.aborted) {
        try {
          await persistBlockedOutput();
        } catch (persistenceError) {
          if (guardrailError instanceof AgentsError) {
            guardrailError.state ??= state;
          }
          if (
            guardrailError instanceof OutputGuardrailTripwireTriggered ||
            !isDataRedactedError(guardrailError)
          ) {
            (guardrailError as Error & { cause?: unknown }).cause =
              outputBlocked
                ? sanitizeBlockedOutputGuardrailErrorDetails(
                    persistenceError,
                    output,
                    blockedMessage,
                    state,
                  )
                : persistenceError;
          }
        }
      }
      releaseBlockedOutputPersistence(state);
    } else if (persistUnblockedFailure && !signal?.aborted) {
      try {
        await persistUnblockedFailure();
      } catch (persistenceError) {
        if (!isDataRedactedError(guardrailError)) {
          (guardrailError as Error & { cause?: unknown }).cause =
            persistenceError;
        }
      }
    }
    throw guardrailError;
  }
}

export function sanitizeBlockedOutputGuardrailError(
  error: unknown,
  rejectedOutput: string,
  redactedOutput: string,
  state: RunState<any, any>,
  currentTripwireResult?: OutputGuardrailResult<any, any>,
): unknown {
  if (error instanceof OutputGuardrailTripwireTriggered) {
    const completedResult = {
      guardrail: { type: 'output' as const, name: 'output_guardrail' },
      agent: state._currentAgent,
      agentOutput: redactedOutput,
      output: {
        tripwireTriggered: true,
        outputInfo: undefined,
      },
    };
    try {
      const guardrailName = currentTripwireResult?.guardrail.name;
      if (typeof guardrailName === 'string' && guardrailName.length > 0) {
        completedResult.guardrail.name = guardrailName;
      }
    } catch {
      // Keep the safe fallback name when caller-owned metadata is unreadable.
    }
    return new OutputGuardrailTripwireTriggered(
      'Output guardrail triggered.',
      completedResult,
      state,
    );
  }

  if (!(error instanceof GuardrailExecutionError)) {
    return error;
  }

  return new GuardrailExecutionError(
    sanitizeBlockedOutputGuardrailErrorDetails(
      error,
      rejectedOutput,
      redactedOutput,
      state,
    ).message,
    sanitizeBlockedOutputGuardrailErrorDetails(
      error.error,
      rejectedOutput,
      redactedOutput,
      state,
    ),
    state,
  );
}

export function sanitizeBlockedOutputGuardrailErrorDetails(
  error: unknown,
  rejectedOutput: string,
  redactedOutput: string,
  state: RunState<any, any>,
): Error {
  if (state._currentAgent.outputType !== 'text') {
    return new Error('Error details are redacted.');
  }
  const message =
    error instanceof Error ? error.message : 'Error details are redacted.';
  return new Error(
    rejectedOutput.length > 0
      ? message.split(rejectedOutput).join(redactedOutput)
      : message,
  );
}

function cloneSanitizedOutputGuardrailResult(
  result: OutputGuardrailResult<any, any>,
  redactedOutput: string,
  tripwireTriggered: boolean,
): OutputGuardrailResult<any, any> | undefined {
  try {
    return {
      guardrail: {
        type: 'output',
        name: result.guardrail.name,
      },
      agent: result.agent,
      agentOutput: redactedOutput,
      output: {
        tripwireTriggered,
        outputInfo: undefined,
      },
    };
  } catch {
    return undefined;
  }
}

export function sanitizeBlockedOutputGuardrailResults(
  state: RunState<any, any>,
  resultStartIndex: number,
  redactedOutput: string,
  observedTripwireResults: ReadonlyMap<
    OutputGuardrailResult<any, any>,
    boolean
  >,
  tripwire?: OutputGuardrailTripwireTriggered<any, any>,
  ownedGuardrailResults: ReadonlySet<
    OutputGuardrailResult<any, any>
  > = new Set(),
): ReadonlySet<OutputGuardrailResult<any, any>> {
  const results = state._outputGuardrailResults;
  const sanitizedResults: OutputGuardrailResult<any, any>[] = [];
  const replacements = new Map<
    object,
    (typeof state._outputGuardrailResults)[number]
  >();
  const sanitizedOwnedResults = new Set<OutputGuardrailResult<any, any>>();
  for (let index = 0; index < resultStartIndex; index += 1) {
    try {
      const result = results[index];
      if (!ownedGuardrailResults.has(result)) {
        sanitizedResults.push(result);
        continue;
      }
      const replacement = cloneSanitizedOutputGuardrailResult(
        result,
        redactedOutput,
        false,
      );
      if (replacement) {
        replacements.set(result, replacement);
        sanitizedOwnedResults.add(replacement);
        sanitizedResults.push(replacement);
      }
    } catch {
      // Omit unreadable prior-attempt results instead of retaining rejected data.
    }
  }
  for (let index = resultStartIndex; index < results.length; index += 1) {
    try {
      const result = results[index];
      const tripwireTriggered = observedTripwireResults.get(result);
      if (typeof tripwireTriggered !== 'boolean') {
        continue;
      }
      let replacement = replacements.get(result);
      if (!replacement) {
        replacement = cloneSanitizedOutputGuardrailResult(
          result,
          redactedOutput,
          tripwireTriggered,
        );
        if (!replacement) {
          continue;
        }
        replacements.set(result, replacement);
      }
      sanitizedOwnedResults.add(replacement);
      sanitizedResults.push(replacement);
    } catch {
      // Omit unreadable caller-owned results instead of retaining sensitive data.
    }
  }
  state._outputGuardrailResults = sanitizedResults;
  if (tripwire) {
    tripwire.result = replacements.get(tripwire.result) ??
      cloneSanitizedOutputGuardrailResult(
        tripwire.result,
        redactedOutput,
        true,
      ) ?? {
        guardrail: {
          type: 'output',
          name: 'output_guardrail',
        },
        agent: state._currentAgent,
        agentOutput: redactedOutput,
        output: {
          tripwireTriggered: true,
          outputInfo: undefined,
        },
      };
    sanitizedOwnedResults.add(tripwire.result);
    tripwire.message = 'Output guardrail triggered.';
    tripwire.stack = `${tripwire.name}: ${tripwire.message}`;
  }
  currentResponseOutputGuardrailResults.set(state, {
    response: state._lastTurnResponse,
    results: sanitizedOwnedResults,
  });
  return sanitizedOwnedResults;
}

export function replaceSanitizedOutputGuardrailMessages(
  state: RunState<any, any>,
  sanitizedOwnedResults: ReadonlySet<OutputGuardrailResult<any, any>>,
  redactedOutput: string,
  tripwire?: OutputGuardrailTripwireTriggered<any, any>,
): void {
  const replacements = new Map<
    OutputGuardrailResult<any, any>,
    OutputGuardrailResult<any, any>
  >();
  state._outputGuardrailResults = state._outputGuardrailResults.map(
    (result) => {
      if (!sanitizedOwnedResults.has(result)) {
        return result;
      }
      const replacement = cloneSanitizedOutputGuardrailResult(
        result,
        redactedOutput,
        result.output.tripwireTriggered,
      );
      if (!replacement) {
        return result;
      }
      replacements.set(result, replacement);
      return replacement;
    },
  );
  if (tripwire && sanitizedOwnedResults.has(tripwire.result)) {
    tripwire.result =
      replacements.get(tripwire.result) ??
      cloneSanitizedOutputGuardrailResult(
        tripwire.result,
        redactedOutput,
        true,
      ) ??
      tripwire.result;
  }
  currentResponseOutputGuardrailResults.set(state, {
    response: state._lastTurnResponse,
    results: new Set(replacements.values()),
  });
}

export function sanitizeBlockedToolOutputGuardrailResults(
  state: RunState<any, any>,
  resultStartIndex: number,
  redactedOutput: string,
): void {
  const results = state._toolOutputGuardrailResults;
  const sanitizedResults = results.slice(0, resultStartIndex);
  for (let index = resultStartIndex; index < results.length; index += 1) {
    try {
      const result = results[index];
      const behavior = result.output.behavior;
      const behaviorType = behavior.type;
      let sanitizedBehavior: ToolOutputGuardrailResult['output']['behavior'];
      if (behaviorType === 'rejectContent') {
        sanitizedBehavior = {
          type: 'rejectContent',
          message: redactedOutput,
        };
      } else if (behaviorType === 'throwException') {
        sanitizedBehavior = { type: 'throwException' };
      } else if (behaviorType === 'allow') {
        sanitizedBehavior = { type: 'allow' };
      } else {
        continue;
      }
      sanitizedResults.push({
        guardrail: {
          type: 'tool_output',
          name: result.guardrail.name,
        },
        output: {
          outputInfo: undefined,
          behavior: sanitizedBehavior,
        },
      });
    } catch {
      // Omit unreadable caller-owned results instead of retaining sensitive data.
    }
  }
  state._toolOutputGuardrailResults = sanitizedResults;
}
