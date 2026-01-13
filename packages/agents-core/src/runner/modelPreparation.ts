import { Agent, AgentOutputType } from '../agent';
import { serializeHandoff, serializeTool } from '../utils/serialize';
import { RunState } from '../runState';
import { ComputerTool, Tool, resolveComputer } from '../tool';
import { AgentArtifacts } from './types';
import { Handoff } from '../handoff';
import { ensureAgentSpan } from './tracing';

/**
 * Collects tools and handoffs for the current agent so model calls and tracing share the same
 * snapshot of enabled capabilities.
 */
export async function prepareAgentArtifacts<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(state: RunState<TContext, TAgent>): Promise<AgentArtifacts<TContext>> {
  const capabilities = await collectAgentCapabilities(state);
  await warmUpComputerTools(capabilities.tools, state._context);
  state.setCurrentAgentSpan(
    ensureAgentSpan({
      agent: state._currentAgent,
      handoffs: capabilities.handoffs,
      tools: capabilities.tools,
      currentSpan: state._currentAgentSpan,
    }),
  );

  return {
    ...capabilities,
    serializedHandoffs: capabilities.handoffs.map((handoff) =>
      serializeHandoff(handoff),
    ),
    serializedTools: capabilities.tools.map((tool) => serializeTool(tool)),
    toolsExplicitlyProvided: state._currentAgent.hasExplicitToolConfig(),
  };
}

async function collectAgentCapabilities<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): Promise<{
  handoffs: Handoff<any, any>[];
  tools: Tool<TContext>[];
}> {
  const handoffs = await state._currentAgent.getEnabledHandoffs(state._context);
  const tools = (await state._currentAgent.getAllTools(
    state._context,
  )) as Tool<TContext>[];
  return { handoffs, tools };
}

async function warmUpComputerTools<TContext>(
  tools: Tool<TContext>[],
  runContext: RunState<TContext, Agent<TContext, AgentOutputType>>['_context'],
): Promise<void> {
  const computerTools = tools.filter(
    (tool) => tool.type === 'computer',
  ) as ComputerTool<TContext, any>[];

  if (computerTools.length === 0) {
    return;
  }

  await Promise.all(
    computerTools.map(async (tool) => {
      await resolveComputer({ tool, runContext });
    }),
  );
}
