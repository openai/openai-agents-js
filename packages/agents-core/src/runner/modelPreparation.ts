import { Agent, AgentOutputType } from '../agent';
import { createAgentSpan } from '../tracing';
import { setCurrentSpan } from '../tracing/context';
import { serializeHandoff, serializeTool } from '../utils/serialize';
import { RunState } from '../runState';
import { ComputerTool, Tool, resolveComputer } from '../tool';
import { AgentArtifacts } from './types';

/**
 * Collects tools and handoffs for the current agent so model calls and tracing share the same
 * snapshot of enabled capabilities.
 */
export async function prepareAgentArtifacts<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(state: RunState<TContext, TAgent>): Promise<AgentArtifacts<TContext>> {
  const handoffs = await state._currentAgent.getEnabledHandoffs(state._context);
  const tools = (await state._currentAgent.getAllTools(
    state._context,
  )) as Tool<TContext>[];

  const computerTools = tools.filter(
    (tool) => tool.type === 'computer',
  ) as ComputerTool<TContext, any>[];

  if (computerTools.length > 0) {
    await Promise.all(
      computerTools.map(async (tool) => {
        await resolveComputer({ tool, runContext: state._context });
      }),
    );
  }

  if (!state._currentAgentSpan) {
    const handoffNames = handoffs.map((h) => h.agentName);
    state._currentAgentSpan = createAgentSpan({
      data: {
        name: state._currentAgent.name,
        handoffs: handoffNames,
        tools: tools.map((t) => t.name),
        output_type: state._currentAgent.outputSchemaName,
      },
    });
    state._currentAgentSpan.start();
    setCurrentSpan(state._currentAgentSpan);
  } else {
    state._currentAgentSpan.spanData.tools = tools.map((t) => t.name);
  }

  return {
    handoffs,
    tools,
    serializedHandoffs: handoffs.map((handoff) => serializeHandoff(handoff)),
    serializedTools: tools.map((tool) => serializeTool(tool)),
    toolsExplicitlyProvided: state._currentAgent.hasExplicitToolConfig(),
  };
}
