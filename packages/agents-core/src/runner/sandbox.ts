import type { Agent, AgentOutputType } from '../agent';
import { UserError } from '../errors';
import logger, { logToolActionWarning } from '../logger';
import { rehydrateProcessedResponseTools, type RunState } from '../runState';
import type { SandboxRuntimeManager } from '../sandbox/runtime';
import type { SandboxMemoryAgentRunner } from '../sandbox/memory/generation';
import type { SandboxRuntimeModel } from '../sandbox/runtime/agentPreparation';
import { isSandboxAgent } from '../sandbox/runtime/agentKeys';
import { processedResponseRequiresExecutionToolRehydration } from '../sandbox/runtime/toolRehydration';
import { disposeResolvedComputers } from '../tool';
import { resetCurrentSpan } from '../tracing/context';
import type { Span } from '../tracing/spans';
import type { Trace } from '../tracing/traces';
import type { AgentInputItem } from '../types';
import { prepareAgentArtifacts } from './modelPreparation';

export type SandboxMemoryPersistenceContext = {
  sdkSessionId?: () => Promise<string | undefined>;
  inputOverride?: () => string | AgentInputItem[] | undefined;
};

export async function prepareSandboxInterruptedTurnResume<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(args: {
  startingAgent: TAgent;
  state: RunState<TContext, TAgent>;
  sandboxRuntime: SandboxRuntimeManager<TContext>;
  runConfigModel?: SandboxRuntimeModel;
  tracingParent?: Span<any> | Trace;
}): Promise<void> {
  const {
    startingAgent,
    state,
    sandboxRuntime,
    runConfigModel,
    tracingParent,
  } = args;
  logger.debug('Continuing from interruption');
  if (!state._lastTurnResponse || !state._lastProcessedResponse) {
    throw new UserError('No model response found in previous state', state);
  }

  const requiresExecutionToolRehydration =
    processedResponseRequiresExecutionToolRehydration(
      state._lastProcessedResponse,
    );
  if (
    !isSandboxAgent(state._currentAgent) &&
    !requiresExecutionToolRehydration
  ) {
    return;
  }

  const resumedPreservedSessions =
    await sandboxRuntime.adoptPreservedOwnedSessions(tracingParent);
  if (resumedPreservedSessions || requiresExecutionToolRehydration) {
    await rehydrateInterruptedTurnExecutionTools({
      startingAgent,
      state,
      sandboxRuntime,
      runConfigModel,
      force: resumedPreservedSessions,
      tracingParent,
    });
  }
}

export async function finalizeSandboxRuntime<TContext>(args: {
  state: RunState<TContext, Agent<TContext, AgentOutputType>>;
  sandboxRuntime: SandboxRuntimeManager<TContext>;
  preserveSessionsForInterruption: boolean;
  finishAgentSpanForInterruption?: boolean;
  runError?: unknown;
  groupId?: string;
  memoryContext?: SandboxMemoryPersistenceContext;
  runAgent: SandboxMemoryAgentRunner;
  tracingParent?: Span<any> | Trace;
}): Promise<void> {
  const {
    state,
    sandboxRuntime,
    preserveSessionsForInterruption,
    finishAgentSpanForInterruption = false,
    runError,
    groupId,
    memoryContext,
    runAgent,
    tracingParent,
  } = args;

  if (!preserveSessionsForInterruption) {
    try {
      await disposeResolvedComputers({ runContext: state._context });
    } catch (error) {
      logToolActionWarning(
        logger,
        'Failed to dispose computers after run:',
        error,
      );
    }
  }

  await sandboxRuntime.enqueueMemoryGeneration(state, {
    exception: runError,
    groupId,
    inputOverride: memoryContext?.inputOverride?.(),
    sdkSessionId: memoryContext?.sdkSessionId,
    runAgent: async (agent, input, runOptions) =>
      await runAgent(agent, input, runOptions),
    tracingParent,
  });
  try {
    await sandboxRuntime.cleanup(state, {
      preserveOwnedSessions: preserveSessionsForInterruption,
      tracingParent,
    });
  } finally {
    if (state._currentAgentSpan) {
      try {
        if (
          !preserveSessionsForInterruption ||
          finishAgentSpanForInterruption
        ) {
          state._currentAgentSpan.end();
        }
      } finally {
        resetCurrentSpan();
      }
    }
  }
}

export async function rehydrateInterruptedTurnExecutionTools<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(args: {
  startingAgent: TAgent;
  state: RunState<TContext, TAgent>;
  sandboxRuntime: SandboxRuntimeManager<TContext>;
  runConfigModel?: SandboxRuntimeModel;
  force?: boolean;
  tracingParent?: Span<any> | Trace;
}): Promise<void> {
  const {
    startingAgent,
    state,
    sandboxRuntime,
    runConfigModel,
    force,
    tracingParent,
  } = args;
  if (
    !force &&
    !processedResponseRequiresExecutionToolRehydration(
      state._lastProcessedResponse,
    )
  ) {
    return;
  }

  const preparedSandboxAgent = await sandboxRuntime.prepareAgent({
    currentAgent: state._currentAgent,
    turnInput: [],
    runConfigModel,
    tracingParent,
  });
  const artifacts = await prepareAgentArtifacts(
    state,
    preparedSandboxAgent.executionAgent,
  );
  await rehydrateProcessedResponseTools(startingAgent, state, artifacts.tools);
}

export function isSandboxRuntimeAgent<TContext>(
  agent: Agent<TContext, AgentOutputType>,
): boolean {
  return isSandboxAgent(agent);
}
