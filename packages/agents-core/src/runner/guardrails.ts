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
    state._inputGuardrailResults.push(...results);
    for (const result of results) {
      if (result.output.tripwireTriggered) {
        if (state._currentAgentSpan) {
          state._currentAgentSpan.setError({
            message: 'Guardrail tripwire triggered',
            data: { guardrail: result.guardrail.name },
          });
        }
        throw new InputGuardrailTripwireTriggered(
          `Input guardrail triggered: ${JSON.stringify(result.output.outputInfo)}`,
          result,
          state,
        );
      }
    }
    return results;
  } catch (e) {
    if (e instanceof InputGuardrailTripwireTriggered) {
      throw e;
    }
    // roll back the current turn to enable reruns
    state._currentTurn--;
    throw new GuardrailExecutionError(
      `Input guardrail failed to complete: ${e}`,
      e as Error,
      state,
    );
  }
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
    for (const result of results) {
      if (result.output.tripwireTriggered) {
        if (state._currentAgentSpan) {
          state._currentAgentSpan.setError({
            message: 'Guardrail tripwire triggered',
            data: { guardrail: result.guardrail.name },
          });
        }
        throw new OutputGuardrailTripwireTriggered(
          `Output guardrail triggered: ${JSON.stringify(result.output.outputInfo)}`,
          result,
          state,
        );
      }
    }
  } catch (e) {
    if (e instanceof OutputGuardrailTripwireTriggered) {
      throw e;
    }
    throw new GuardrailExecutionError(
      `Output guardrail failed to complete: ${e}`,
      e as Error,
      state,
    );
  }
}
