import { Agent, AgentOutputType } from '../agent';
import type { Computer } from '../computer';
import { UserError } from '../errors';
import { Handoff } from '../handoff';
import logger from '../logger';
import type { RunState } from '../runState';
import { ComputerTool, Tool, resolveComputer } from '../tool';
import {
  getFunctionToolNamespace,
  getFunctionToolQualifiedName,
} from '../toolIdentity';
import { serializeHandoff, serializeTool } from '../utils/serialize';
import { ensureAgentSpan } from './tracing';
import { validateClientToolSearchSupport } from './toolSearch';
import { AgentArtifacts } from './types';
import type { ToolNameCollisionPolicy } from './runConfig';

const computerInitPromisesByRunState = new WeakMap<
  RunState<any, any>,
  WeakMap<Computer, Promise<void>>
>();

function getComputerInitMap(
  state: RunState<any, any>,
): WeakMap<Computer, Promise<void>> {
  let initMap = computerInitPromisesByRunState.get(state);
  if (!initMap) {
    initMap = new WeakMap();
    computerInitPromisesByRunState.set(state, initMap);
  }
  return initMap;
}

async function initComputerOnce(
  computer: Computer,
  state: RunState<any, any>,
): Promise<void> {
  if (typeof computer.initRun !== 'function') {
    return;
  }
  const initMap = getComputerInitMap(state);
  const existing = initMap.get(computer);
  if (existing) {
    await existing;
    return;
  }
  const initPromise = (async () => {
    await computer.initRun?.(state._context);
  })();
  initMap.set(computer, initPromise);
  try {
    await initPromise;
  } catch (error) {
    initMap.delete(computer);
    throw error;
  }
}

/**
 * Collects tools and handoffs for the current agent so model calls and tracing share the same
 * snapshot of enabled capabilities.
 */
export async function prepareAgentArtifacts<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  state: RunState<TContext, TAgent>,
  executionAgent: Agent<TContext, AgentOutputType> = state._currentAgent,
  toolNameCollisionPolicy: ToolNameCollisionPolicy = 'warn',
): Promise<AgentArtifacts<TContext>> {
  const collectedCapabilities = await collectAgentCapabilities(
    state,
    executionAgent,
  );
  const capabilities = resolveModelVisibleToolNameCollisions(
    collectedCapabilities.tools,
    collectedCapabilities.handoffs,
    toolNameCollisionPolicy,
  );
  validateClientToolSearchSupport(capabilities.tools);
  await warmUpComputerTools(capabilities.tools, state._context);
  await initializeComputerTools(capabilities.tools, state);
  state.setCurrentAgentSpan(
    ensureAgentSpan({
      agent: executionAgent,
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
    toolsExplicitlyProvided: executionAgent.hasExplicitToolConfig(),
  };
}

async function collectAgentCapabilities<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
  executionAgent: Agent<TContext, AgentOutputType>,
): Promise<{
  handoffs: Handoff<any, any>[];
  tools: Tool<TContext>[];
}> {
  const handoffs = await executionAgent.getEnabledHandoffs(state._context);
  const configuredTools = (await executionAgent.getAllTools(
    state._context,
    state._currentAgentSpan,
  )) as Tool<TContext>[];
  const runtimeLoadedTools = state.getToolSearchRuntimeTools(
    state._currentAgent,
  ) as Tool<TContext>[];
  const enabledRuntimeTools = (
    await Promise.all(
      runtimeLoadedTools.map(async (tool) => ({
        tool,
        enabled:
          tool.type !== 'function' ||
          (await tool.isEnabled(state._context, state._currentAgent)),
      })),
    )
  )
    .filter(({ enabled }) => enabled)
    .map(({ tool }) => tool);
  return { handoffs, tools: [...configuredTools, ...enabledRuntimeTools] };
}

type ModelVisibleToolKind = 'function tool' | 'handoff';
type ModelVisibleFunctionCategory = 'top-level' | 'namespaced' | 'deferred';

type ModelVisibleToolEntry = {
  kind: ModelVisibleToolKind;
  index: number;
  functionCategory?: ModelVisibleFunctionCategory;
};

/** @internal */
export function resolveModelVisibleToolNameCollisions<TContext>(
  tools: Tool<TContext>[],
  handoffs: Handoff<any, any>[],
  collisionPolicy: ToolNameCollisionPolicy,
): { tools: Tool<TContext>[]; handoffs: Handoff<any, any>[] } {
  const topLevelEntriesByName = new Map<string, ModelVisibleToolEntry[]>();
  const namespacedFunctionEntriesByName = new Map<
    string,
    ModelVisibleToolEntry[]
  >();
  const deferredFunctionEntriesByName = new Map<
    string,
    ModelVisibleToolEntry[]
  >();
  const addName = (
    entriesByName: Map<string, ModelVisibleToolEntry[]>,
    name: string,
    entry: ModelVisibleToolEntry,
  ) => {
    const entries = entriesByName.get(name) ?? [];
    entries.push(entry);
    entriesByName.set(name, entries);
  };

  for (const [index, tool] of tools.entries()) {
    if (tool.type === 'function') {
      const namespace = getFunctionToolNamespace(tool);
      if (namespace === tool.name) {
        throw new UserError(
          'Responses tool search reserves same-name namespaces for deferred top-level function tools. Rename the namespace or tool name to avoid ambiguous dispatch.',
        );
      }
      const functionCategory: ModelVisibleFunctionCategory = namespace
        ? 'namespaced'
        : tool.deferLoading === true
          ? 'deferred'
          : 'top-level';
      const entry: ModelVisibleToolEntry = {
        kind: 'function tool',
        index,
        functionCategory,
      };
      const dispatchName = getFunctionToolQualifiedName(tool) ?? tool.name;
      addName(
        functionCategory === 'namespaced'
          ? namespacedFunctionEntriesByName
          : functionCategory === 'deferred'
            ? deferredFunctionEntriesByName
            : topLevelEntriesByName,
        dispatchName,
        entry,
      );
    }
  }
  for (const [index, handoff] of handoffs.entries()) {
    addName(topLevelEntriesByName, handoff.toolName, {
      kind: 'handoff',
      index,
    });
  }

  const namespacedDuplicates = [...namespacedFunctionEntriesByName.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  const deferredDuplicates = [...deferredFunctionEntriesByName.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  const strictDuplicatesByName = new Map<string, ModelVisibleToolEntry[]>([
    ...namespacedDuplicates,
    ...deferredDuplicates,
  ]);
  const strictDuplicates = [...strictDuplicatesByName.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (strictDuplicates.length > 0) {
    throwToolNameCollisionError(strictDuplicates);
  }

  const topLevelDuplicates = [...topLevelEntriesByName.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  if (topLevelDuplicates.length === 0) {
    return { tools, handoffs };
  }

  if (collisionPolicy === 'error') {
    throwToolNameCollisionError(topLevelDuplicates);
  }

  const retainedToolIndices = new Set(tools.map((_, index) => index));
  const retainedHandoffIndices = new Set(handoffs.map((_, index) => index));
  for (const [name, entries] of topLevelDuplicates) {
    warnToolNameCollision(name, entries);
    const handoffEntries = entries.filter((entry) => entry.kind === 'handoff');
    const winner = handoffEntries.at(-1) ?? entries.at(-1)!;
    for (const entry of entries) {
      if (entry === winner) {
        continue;
      }
      if (entry.kind === 'function tool') {
        retainedToolIndices.delete(entry.index);
      } else {
        retainedHandoffIndices.delete(entry.index);
      }
    }
  }

  return {
    tools: tools.filter((_, index) => retainedToolIndices.has(index)),
    handoffs: handoffs.filter((_, index) => retainedHandoffIndices.has(index)),
  };
}

const toolNameCollisionRemediation =
  'Function tools and handoffs must have unique routed names. Assign unique tool names or toolNameOverride values, or use a namespace.';

function throwToolNameCollisionError(
  duplicates: Array<[string, ModelVisibleToolEntry[]]>,
): never {
  if (logger.dontLogToolData) {
    throw new UserError(
      `Duplicate enabled function tool or handoff names found. ${toolNameCollisionRemediation}`,
    );
  }
  const label = duplicates.length === 1 ? 'name' : 'names';
  const details = duplicates
    .map(
      ([name, entries]) =>
        `'${name}' (${formatToolKinds(entries.map((entry) => entry.kind))})`,
    )
    .join(', ');
  throw new UserError(
    `Duplicate enabled tool ${label} found: ${details}. ${toolNameCollisionRemediation}`,
  );
}

function warnToolNameCollision(
  name: string,
  entries: readonly ModelVisibleToolEntry[],
): void {
  if (logger.dontLogToolData) {
    logger.warn(
      'Tool name collision detected. Assign unique routed tool names or enable tool data logging for details. Only the current dispatch winner will be exposed.',
    );
    return;
  }
  logger.warn(
    `Duplicate enabled tool name found: '${name}' (${formatToolKinds(entries.map((entry) => entry.kind))}). ${toolNameCollisionRemediation} Only the current dispatch winner will be exposed.`,
  );
}

function formatToolKinds(kinds: readonly ModelVisibleToolKind[]): string {
  const functionToolCount = kinds.filter(
    (kind) => kind === 'function tool',
  ).length;
  const handoffCount = kinds.length - functionToolCount;
  const descriptions: string[] = [];
  if (functionToolCount > 0) {
    descriptions.push(
      functionToolCount === 1
        ? 'function tool'
        : `${functionToolCount} function tools`,
    );
  }
  if (handoffCount > 0) {
    descriptions.push(
      handoffCount === 1 ? 'handoff' : `${handoffCount} handoffs`,
    );
  }
  return descriptions.join(' and ');
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

async function initializeComputerTools<TContext>(
  tools: Tool<TContext>[],
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): Promise<void> {
  const computerTools = tools.filter(
    (tool) => tool.type === 'computer',
  ) as ComputerTool<TContext, any>[];

  if (computerTools.length === 0) {
    return;
  }

  await Promise.all(
    computerTools.map(async (tool) => {
      const computer = await resolveComputer({
        tool,
        runContext: state._context,
      });
      await initComputerOnce(computer, state);
    }),
  );
}
