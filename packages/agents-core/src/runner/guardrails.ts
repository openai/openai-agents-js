import { Agent, AgentOutputType } from '../agent';
import {
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
} from '../errors';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
  InputGuardrailDefinition,
  InputGuardrailResult,
  OutputGuardrailDefinition,
  OutputGuardrailFunctionArgs,
  OutputGuardrailMetadata,
} from '../guardrail';
import { RunState } from '../runState';
import { getTurnInput } from './items';
import { withGuardrailSpan } from '../tracing';
import type { GuardrailFunctionOutput } from '../guardrail';

export type GuardrailTracker = {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly error: unknown;
  markPending: () => void;
  setPromise: (promise?: Promise<InputGuardrailResult[]>) => void;
  setError: (err: unknown) => void;
  throwIfError: () => void;
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
    pending = false;
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

  const throwIfError = () => {
    if (error) {
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
  onError: (error: unknown) => never;
}): Promise<TResult[]> {
  const {
    state,
    guardrails,
    guardrailArgs,
    resultsTarget,
    onTripwire,
    isTripwireError,
    onError,
  } = options;

  try {
    const results = await Promise.all(
      guardrails.map(async (guardrail) => {
        return withGuardrailSpan(
          async (span) => {
            const result = await guardrail.run(guardrailArgs);
            span.spanData.triggered = result.output.tripwireTriggered;
            return result;
          },
          { data: { name: guardrail.name } },
          state._currentAgentSpan,
        );
      }),
    );
    resultsTarget.push(...results);
    for (const result of results) {
      if (result.output.tripwireTriggered) {
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
    if (isTripwireError(error)) {
      throw error;
    }
    onError(error);
    return [];
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
): Promise<InputGuardrailResult[]> {
  if (guardrails.length === 0) {
    return [];
  }
  const guardrailArgs = {
    agent: state._currentAgent,
    input: state._originalInput,
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
      // roll back the current turn to enable reruns
      state._currentTurn--;
      throw new GuardrailExecutionError(
        `Input guardrail failed to complete: ${error}`,
        error as Error,
        state,
      );
    },
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
) {
  const guardrails = runnerOutputGuardrails.concat(
    state._currentAgent.outputGuardrails.map(defineOutputGuardrail),
  );
  if (guardrails.length === 0) {
    return;
  }
  const agentOutput = state._currentAgent.processFinalOutput(output);
  const runOutput = getTurnInput([], state._generatedItems);
  const guardrailArgs: OutputGuardrailFunctionArgs<unknown, TOutput> = {
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
      throw new GuardrailExecutionError(
        `Output guardrail failed to complete: ${error}`,
        error as Error,
        state,
      );
    },
  });
}
