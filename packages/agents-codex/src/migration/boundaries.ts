import type { AgentOutputType } from '@openai/agents-core';
import type { ResolvedAgentOutput } from '@openai/agents-core/types';
import {
  defineOutputGuardrail,
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  ToolCallError,
  type Agent,
  type FunctionTool,
  type InputGuardrail,
  type InputGuardrailResult,
  type OutputGuardrail,
  type OutputGuardrailFunctionArgs,
  type OutputGuardrailResult,
  type OutputGuardrailMetadata,
  type RunContext,
  type RunHooks,
  type ToolInputGuardrailDefinition,
  type ToolInputGuardrailResult,
  type ToolInputParameters,
  type ToolOutputGuardrailDefinition,
  type ToolOutputGuardrailResult,
} from '@openai/agents-core';
import {
  defineInputGuardrail,
  runToolInputGuardrails,
  runToolOutputGuardrails,
} from '@openai/agents-core/utils/internal';
import { toSmartString } from '@openai/agents-core/utils';
import type {
  AgentInputItem,
  FunctionCallItem,
} from '@openai/agents-core/types';

type CheckedResult = {
  output: { tripwireTriggered: boolean };
};

async function checkBatch<Result extends CheckedResult>(
  checks: readonly (() => Promise<Result>)[],
  tripwire: (result: Result) => Error,
  executionError: (error: unknown) => Error,
  onFailure: (error: Error) => void,
): Promise<Result[]> {
  let failed = false;
  let firstFailure: Error;
  const pending = checks.map(async (check) => {
    try {
      let result: Result;
      let triggered: boolean;
      try {
        result = await check();
        triggered = result.output.tripwireTriggered;
      } catch (error) {
        throw executionError(error);
      }
      if (triggered) throw tripwire(result);
      return result;
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error as Error;
        onFailure(firstFailure);
      }
      throw error;
    }
  });
  // Observe failure promptly, but retain ownership of every started callback.
  const settled = await Promise.allSettled(pending);
  if (failed) throw firstFailure!;
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

/** @internal Captures both batches before invoking application callbacks. */
export function runInputChecks<
  Context,
  Output extends AgentOutputType = 'text',
>({
  agent,
  context,
  input,
  agentGuardrails = agent.inputGuardrails,
  runnerGuardrails = [],
  onFailure,
}: {
  agent: Agent<Context, Output>;
  context: RunContext<Context>;
  input: string | AgentInputItem[];
  agentGuardrails?: readonly InputGuardrail[];
  runnerGuardrails?: readonly InputGuardrail[];
  onFailure: (error: Error) => void;
}) {
  const definitions = [...runnerGuardrails, ...agentGuardrails].map(
    defineInputGuardrail,
  );
  const args = { agent, context, input };
  const runBatch = (parallel: boolean) =>
    checkBatch(
      definitions
        .filter((guard) => (guard.runInParallel !== false) === parallel)
        .map((guard) => () => guard.run(args)),
      (result) =>
        new InputGuardrailTripwireTriggered(
          `Input guardrail triggered: ${result.guardrail.name}`,
          result,
        ),
      (error) =>
        new GuardrailExecutionError(
          `Input guardrail failed to complete: ${error}`,
          error as Error,
        ),
      onFailure,
    );
  const blocking = runBatch(false);
  let parallel: Promise<InputGuardrailResult[]> | undefined;
  return {
    blocking,
    startParallel: () => (parallel ??= blocking.then(() => runBatch(true))),
    async join() {
      await Promise.allSettled([blocking, ...(parallel ? [parallel] : [])]);
    },
  };
}

/** @internal Validates output before the caller publishes a successful result. */
export function checkFinalOutput<
  Context,
  Output extends AgentOutputType = 'text',
>({
  agent,
  context,
  output,
  agentGuardrails = agent.outputGuardrails,
  runnerGuardrails = [],
  details,
  onFailure,
}: {
  agent: Agent<Context, Output>;
  context: RunContext<Context>;
  output: ResolvedAgentOutput<Output>;
  agentGuardrails?: readonly OutputGuardrail<Output, Context>[];
  runnerGuardrails?: readonly OutputGuardrail<Output, Context>[];
  details?: OutputGuardrailFunctionArgs<Context, Output>['details'];
  onFailure: (error: Error) => void;
}): Promise<OutputGuardrailResult<OutputGuardrailMetadata, Output>[]> {
  const definitions = [...runnerGuardrails, ...agentGuardrails].map((guard) =>
    defineOutputGuardrail<Output, Context>(guard),
  );
  const args = { agent, context, agentOutput: output, details };
  return checkBatch(
    definitions.map((guard) => () => guard.run(args)),
    (result) =>
      new OutputGuardrailTripwireTriggered(
        `Output guardrail triggered: ${result.guardrail.name}`,
        result,
      ),
    (error) =>
      new GuardrailExecutionError(
        `Output guardrail failed to complete: ${error}`,
        error as Error,
      ),
    onFailure,
  );
}

/** @internal Agent listeners run before Runner listeners at the start boundary. */
export function emitAgentStart<
  Context,
  Output extends AgentOutputType = 'text',
>({
  agent,
  context,
  input,
  hooks,
}: {
  agent: Agent<Context, Output>;
  context: RunContext<Context>;
  input: AgentInputItem[];
  hooks?: RunHooks<Context, NoInfer<Output>>;
}): void {
  agent.emit('agent_start', context, agent, input);
  hooks?.emit('agent_start', context, agent, input);
}

/** @internal Runner listeners run before Agent listeners at the success boundary. */
export function emitAgentEnd<Context, Output extends AgentOutputType = 'text'>({
  agent,
  context,
  output,
  hooks,
}: {
  agent: Agent<Context, Output>;
  context: RunContext<Context>;
  output: ResolvedAgentOutput<Output>;
  hooks?: RunHooks<Context, NoInfer<Output>>;
}): void {
  hooks?.emit('agent_end', context, agent, output);
  agent.emit('agent_end', context, output);
}

/** @internal Runs one admitted function call with the existing SDK guardrails and events. */
export async function invokeGuardedTool<
  Context,
  Parameters extends ToolInputParameters,
  Result,
  Output extends AgentOutputType = 'text',
>({
  agent,
  context,
  tool,
  toolCall,
  invoke,
  check,
  signal,
  hooks,
  inputGuardrails = tool.inputGuardrails,
  outputGuardrails = tool.outputGuardrails,
  onInputResult,
  onOutputResult,
}: {
  agent: Agent<Context, Output>;
  context: RunContext<Context>;
  tool: FunctionTool<Context, Parameters, Result>;
  toolCall: FunctionCallItem;
  invoke: () => Promise<unknown>;
  check: () => void;
  signal: AbortSignal;
  hooks?: RunHooks<Context, Output>;
  inputGuardrails?: ToolInputGuardrailDefinition<Context>[];
  outputGuardrails?: ToolOutputGuardrailDefinition<Context>[];
  onInputResult?: (result: ToolInputGuardrailResult) => void;
  onOutputResult?: (result: ToolOutputGuardrailResult) => void;
}): Promise<unknown> {
  let started = false;
  let endAttempted = false;
  const admit = () => {
    signal.throwIfAborted();
    check();
  };
  const end = (output: string) => {
    // A throwing listener must not cause a second attempt or resume skipped listeners.
    endAttempted = true;
    hooks?.emit('agent_tool_end', context, agent, tool, output, { toolCall });
    agent.emit('agent_tool_end', context, tool, output, { toolCall });
  };
  try {
    admit();
    const input = await runToolInputGuardrails({
      guardrails: inputGuardrails,
      context,
      agent,
      toolCall,
      onResult: (result) => {
        onInputResult?.(result);
        admit();
      },
    });
    admit();
    hooks?.emit('agent_tool_start', context, agent, tool, { toolCall });
    agent.emit('agent_tool_start', context, tool, { toolCall });
    started = true;
    admit();
    let output: unknown;
    if (input.type === 'reject') {
      // Admitted tools have no output schema or custom failure-output policy.
      output = input.message;
    } else {
      const invokedOutput = await invoke();
      admit();
      output = await runToolOutputGuardrails({
        guardrails: outputGuardrails,
        context,
        agent,
        toolCall,
        toolOutput: invokedOutput,
        onResult: (result) => {
          onOutputResult?.(result);
          admit();
        },
      });
      admit();
    }
    end(toSmartString(output));
    admit();
    return output;
  } catch (error) {
    let failure = error;
    if (!endAttempted && (!signal.aborted || started)) {
      try {
        end(signal.aborted ? 'aborted' : String(error));
      } catch (hookError) {
        failure = hookError;
      }
    }
    if (
      signal.aborted &&
      Object.is(failure, error) &&
      Object.is(error, signal.reason)
    )
      throw signal.reason;
    throw new ToolCallError(
      `Failed to run function tools: ${failure}`,
      failure as Error,
    );
  }
}
