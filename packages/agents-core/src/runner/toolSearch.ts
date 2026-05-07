import type { Agent } from '../agent';
import { UserError } from '../errors';
import type { RunContext } from '../runContext';
import {
  getClientToolSearchExecutor,
  getToolSearchRuntimeToolKey,
  type FunctionTool,
  type HostedMCPTool,
  type Tool,
} from '../tool';
import type * as protocol from '../types/protocol';
import * as ProviderData from '../types/providerData';
import {
  getExplicitFunctionToolNamespace,
  getFunctionToolNamespaceDescription,
  getFunctionToolQualifiedName,
  toolQualifiedName,
} from '../toolIdentity';
import { serializeTool } from '../utils/serialize';
import { normalizeHostedMcpRequireApproval } from '../utils/mcpApproval';
import { resolveToolSearchCallId } from '../utils/toolSearch';

type BuiltInClientToolSearchArguments = {
  paths: string[];
};

type DeferredNamespaceTools = {
  description: string;
  tools: FunctionTool<any>[];
};

function isDeferredFunctionTool(tool: Tool<any>): tool is FunctionTool<any> {
  return tool.type === 'function' && tool.deferLoading === true;
}

function isTopLevelDeferredFunctionTool(
  tool: Tool<any>,
): tool is FunctionTool<any> {
  return (
    isDeferredFunctionTool(tool) && !getExplicitFunctionToolNamespace(tool)
  );
}

function isDeferredHostedMcpTool(tool: Tool<any>): tool is HostedMCPTool<any> {
  return (
    tool.type === 'hosted_tool' &&
    tool.providerData?.type === 'mcp' &&
    tool.providerData.defer_loading === true
  );
}

function getBuiltInClientToolSearchArguments(
  value: unknown,
): BuiltInClientToolSearchArguments | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const paths = (value as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) {
    return undefined;
  }

  return {
    paths: paths.filter(
      (path): path is string => typeof path === 'string' && path.length > 0,
    ),
  };
}

function getDeferredFunctionToolsByName(
  tools: Tool<any>[],
): Map<string, FunctionTool<any>> {
  return new Map(
    tools
      .filter(isTopLevelDeferredFunctionTool)
      .map((tool) => [tool.name, tool] as const),
  );
}

function getDeferredNamespaceToolsByName(
  tools: Tool<any>[],
): Map<string, DeferredNamespaceTools> {
  const namespaces = new Map<string, DeferredNamespaceTools>();

  for (const tool of tools) {
    if (!isDeferredFunctionTool(tool)) {
      continue;
    }

    const namespace = getExplicitFunctionToolNamespace(tool);
    if (!namespace) {
      continue;
    }

    const description = getFunctionToolNamespaceDescription(tool);
    if (!description) {
      throw new UserError(
        `Deferred namespace "${namespace}" must provide a description for built-in client tool_search.`,
      );
    }

    const existing = namespaces.get(namespace);
    if (!existing) {
      namespaces.set(namespace, { description, tools: [tool] });
      continue;
    }

    existing.tools.push(tool);
  }

  return namespaces;
}

function getDeferredHostedMcpToolsByServerLabel(
  tools: Tool<any>[],
): Map<string, HostedMCPTool<any>> {
  return new Map(
    tools
      .filter(isDeferredHostedMcpTool)
      .map((tool) => [tool.providerData.server_label, tool] as const),
  );
}

function getDeferredNamespacedFunctionToolsByQualifiedName(
  tools: Tool<any>[],
): Map<
  string,
  { namespace: string; description: string; tool: FunctionTool<any> }
> {
  const qualifiedTools = new Map<
    string,
    { namespace: string; description: string; tool: FunctionTool<any> }
  >();

  for (const tool of tools) {
    if (!isDeferredFunctionTool(tool)) {
      continue;
    }

    const namespace = getExplicitFunctionToolNamespace(tool);
    if (!namespace) {
      continue;
    }

    const description = getFunctionToolNamespaceDescription(tool);
    const qualifiedName = getFunctionToolQualifiedName(tool);
    if (!description || !qualifiedName) {
      continue;
    }

    qualifiedTools.set(qualifiedName, { namespace, description, tool });
  }

  return qualifiedTools;
}

function serializeFunctionToolForToolSearchOutput(
  tool: FunctionTool<any>,
): protocol.ToolSearchOutputTool {
  const serialized = serializeTool(tool) as Record<string, unknown>;
  const namespace = getExplicitFunctionToolNamespace(tool);

  if (!namespace) {
    return serialized as protocol.ToolSearchOutputTool;
  }

  const {
    namespace: _namespace,
    namespaceDescription,
    ...toolPayload
  } = serialized;
  void namespaceDescription;
  return toolPayload as protocol.ToolSearchOutputTool;
}

function serializeHostedMcpToolForToolSearchOutput(
  tool: HostedMCPTool<any>,
): protocol.ToolSearchOutputTool {
  const { on_approval: _onApproval, ...providerData } = tool.providerData;
  void _onApproval;
  return providerData as protocol.ToolSearchOutputTool;
}

function appendNamespaceMemberToolSearchOutput(args: {
  namespace: string;
  description: string;
  tool: FunctionTool<any>;
  namespaceOutputIndexByName: Map<string, number>;
  resolvedTools: protocol.ToolSearchOutputTool[];
}): void {
  const {
    namespace,
    description,
    tool,
    namespaceOutputIndexByName,
    resolvedTools,
  } = args;
  const existingIndex = namespaceOutputIndexByName.get(namespace);
  const serializedTool = serializeFunctionToolForToolSearchOutput(tool);

  if (typeof existingIndex === 'number') {
    const existingNamespace = resolvedTools[existingIndex] as
      | (protocol.ToolSearchOutputTool & {
          type?: unknown;
          description?: unknown;
          tools?: unknown;
        })
      | undefined;
    if (
      existingNamespace?.type === 'namespace' &&
      Array.isArray(existingNamespace.tools)
    ) {
      existingNamespace.tools.push(serializedTool);
      return;
    }
  }

  namespaceOutputIndexByName.set(namespace, resolvedTools.length);
  resolvedTools.push({
    type: 'namespace',
    name: namespace,
    description,
    tools: [serializedTool],
  });
}

function isClientToolSearchToolWithCustomParameters(tool: Tool<any>): boolean {
  return (
    tool.type === 'hosted_tool' &&
    tool.providerData?.type === 'tool_search' &&
    tool.providerData.execution === 'client' &&
    tool.providerData.parameters != null
  );
}

function isClientToolSearchTool(tool: Tool<any>): boolean {
  return (
    tool.type === 'hosted_tool' &&
    tool.providerData?.type === 'tool_search' &&
    tool.providerData.execution === 'client'
  );
}

function normalizeClientToolSearchExecutorResult<TContext>(
  result: Tool<TContext> | Tool<TContext>[] | null | undefined,
): Tool<TContext>[] {
  if (typeof result === 'undefined' || result === null) {
    return [];
  }

  return Array.isArray(result) ? result : [result];
}

function addLoadedToolName(
  loadedToolNames: Set<string>,
  name: unknown,
  namespace?: unknown,
): void {
  if (typeof name !== 'string' || name.length === 0) {
    return;
  }

  const explicitNamespace =
    typeof namespace === 'string' && namespace.length > 0
      ? namespace
      : undefined;
  const qualifiedName = toolQualifiedName(name, explicitNamespace);
  if (qualifiedName) {
    loadedToolNames.add(qualifiedName);
  }

  if (!explicitNamespace || explicitNamespace === name) {
    loadedToolNames.add(name);
  }
}

function collectLoadedToolNamesFromSearchResult(
  searchResult: unknown,
  loadedToolNames: Set<string>,
  namespace?: string,
): void {
  if (!searchResult || typeof searchResult !== 'object') {
    return;
  }

  const candidate = searchResult as {
    type?: unknown;
    name?: unknown;
    namespace?: unknown;
    functionName?: unknown;
    tools?: unknown;
  };

  if (candidate.type === 'tool_reference') {
    addLoadedToolName(
      loadedToolNames,
      candidate.functionName,
      candidate.namespace ?? namespace,
    );
    return;
  }

  if (candidate.type === 'function') {
    addLoadedToolName(
      loadedToolNames,
      candidate.name,
      candidate.namespace ?? namespace,
    );
    return;
  }

  const mcpProviderData = getHostedMcpProviderDataFromSearchResult(candidate);
  if (mcpProviderData) {
    addLoadedToolName(loadedToolNames, mcpProviderData.server_label);
    return;
  }

  if (candidate.type === 'namespace' && Array.isArray(candidate.tools)) {
    const nestedNamespace =
      typeof candidate.name === 'string' && candidate.name.length > 0
        ? candidate.name
        : namespace;
    for (const nestedTool of candidate.tools) {
      collectLoadedToolNamesFromSearchResult(
        nestedTool,
        loadedToolNames,
        nestedNamespace,
      );
    }
  }
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    ([key, entryValue]) =>
      typeof key === 'string' && typeof entryValue === 'string',
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeHostedMcpProviderData(
  value: unknown,
): ProviderData.HostedMCPTool<any> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as {
    type?: unknown;
    server_label?: unknown;
    server_url?: unknown;
    connector_id?: unknown;
    authorization?: unknown;
    allowed_tools?: unknown;
    defer_loading?: unknown;
    headers?: unknown;
    require_approval?: unknown;
    server_description?: unknown;
  };

  if (
    candidate.type !== 'mcp' ||
    typeof candidate.server_label !== 'string' ||
    candidate.server_label.length === 0
  ) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {
    type: 'mcp',
    server_label: candidate.server_label,
    require_approval: normalizeHostedMcpRequireApproval(
      candidate.require_approval,
    ),
  };

  if (typeof candidate.server_url === 'string') {
    normalized.server_url = candidate.server_url;
  }
  if (typeof candidate.connector_id === 'string') {
    normalized.connector_id = candidate.connector_id;
  }
  if (typeof candidate.authorization === 'string') {
    normalized.authorization = candidate.authorization;
  }
  if (candidate.allowed_tools !== undefined) {
    normalized.allowed_tools =
      candidate.allowed_tools as ProviderData.HostedMCPTool<any>['allowed_tools'];
  }
  if (candidate.defer_loading === true) {
    normalized.defer_loading = true;
  }
  const headers = normalizeStringRecord(candidate.headers);
  if (headers) {
    normalized.headers = headers;
  }
  if (typeof candidate.server_description === 'string') {
    normalized.server_description = candidate.server_description;
  }

  return normalized as ProviderData.HostedMCPTool<any>;
}

function getHostedMcpProviderDataFromSearchResult(
  searchResult: unknown,
): ProviderData.HostedMCPTool<any> | undefined {
  const directProviderData = normalizeHostedMcpProviderData(searchResult);
  if (directProviderData) {
    return directProviderData;
  }

  if (!searchResult || typeof searchResult !== 'object') {
    return undefined;
  }

  const hostedCandidate = searchResult as {
    type?: unknown;
    providerData?: unknown;
  };
  if (hostedCandidate.type !== 'hosted_tool') {
    return undefined;
  }

  return normalizeHostedMcpProviderData(hostedCandidate.providerData);
}

export function addLoadedToolNamesFromToolSearchOutput(
  toolSearchOutput: protocol.ToolSearchOutputItem,
  loadedToolNames: Set<string>,
): void {
  for (const tool of toolSearchOutput.tools) {
    collectLoadedToolNamesFromSearchResult(tool, loadedToolNames);
  }
}

export function addHostedMcpToolsFromToolSearchOutput(
  toolSearchOutput: protocol.ToolSearchOutputItem,
  hostedMcpToolsByServerLabel: Map<string, HostedMCPTool<any>>,
  options?: {
    preserveExistingServerLabels?: Set<string>;
  },
): void {
  const preserveExistingServerLabels = options?.preserveExistingServerLabels;
  for (const tool of toolSearchOutput.tools) {
    const providerData = getHostedMcpProviderDataFromSearchResult(tool);
    if (!providerData) {
      continue;
    }

    if (
      preserveExistingServerLabels?.has(providerData.server_label) &&
      hostedMcpToolsByServerLabel.has(providerData.server_label)
    ) {
      continue;
    }

    hostedMcpToolsByServerLabel.set(providerData.server_label, {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData,
    });
  }
}

export function validateClientToolSearchSupport(tools: Tool<any>[]): void {
  if (
    !tools.some(
      (tool) =>
        isClientToolSearchToolWithCustomParameters(tool) &&
        !getClientToolSearchExecutor(tool),
    )
  ) {
    return;
  }

  throw new UserError(
    'Runner.run() and Runner.runStreamed() require toolSearchTool({ execution: "client", execute }) when custom client tool_search parameters are provided. Leave parameters unset to use the default built-in { paths: string[] } loader, or use server execution / a custom model loop instead.',
  );
}

export function resolveBuiltInClientToolSearchTools(
  paths: string[],
  tools: Tool<any>[],
): Tool<any>[] {
  const deferredToolsByName = getDeferredFunctionToolsByName(tools);
  const deferredNamespaceToolsByName = getDeferredNamespaceToolsByName(tools);
  const deferredNamespacedToolsByQualifiedName =
    getDeferredNamespacedFunctionToolsByQualifiedName(tools);
  const deferredHostedMcpToolsByServerLabel =
    getDeferredHostedMcpToolsByServerLabel(tools);
  const ambiguousPath = paths.find(
    (path) =>
      Number(deferredToolsByName.has(path)) +
        Number(deferredNamespaceToolsByName.has(path)) +
        Number(deferredNamespacedToolsByQualifiedName.has(path)) +
        Number(deferredHostedMcpToolsByServerLabel.has(path)) >
      1,
  );
  if (ambiguousPath) {
    throw new UserError(
      `Runner.run() and Runner.runStreamed() cannot disambiguate built-in client tool_search path "${ambiguousPath}" because it matches multiple deferred tool_search surfaces. Rename one of them or use server tool_search execution.`,
    );
  }
  const requestedNamespacePaths = new Set(
    paths.filter((path) => deferredNamespaceToolsByName.has(path)),
  );
  const resolvedTools: Tool<any>[] = [];
  const seenPaths = new Set<string>();
  const resolvedQualifiedNames = new Set<string>();

  for (const path of paths) {
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);

    const tool = deferredToolsByName.get(path);
    if (!tool) {
      const namespaceTools = deferredNamespaceToolsByName.get(path);
      if (namespaceTools) {
        const unresolvedTools = namespaceTools.tools.filter((tool) => {
          const qualifiedName = getFunctionToolQualifiedName(tool);
          return !qualifiedName || !resolvedQualifiedNames.has(qualifiedName);
        });
        if (unresolvedTools.length === 0) {
          continue;
        }

        for (const namespaceTool of unresolvedTools) {
          const qualifiedName = getFunctionToolQualifiedName(namespaceTool);
          if (qualifiedName) {
            resolvedQualifiedNames.add(qualifiedName);
          }
        }

        resolvedTools.push(...unresolvedTools);
        continue;
      }

      const namespacedTool = deferredNamespacedToolsByQualifiedName.get(path);
      if (namespacedTool) {
        if (requestedNamespacePaths.has(namespacedTool.namespace)) {
          continue;
        }

        if (resolvedQualifiedNames.has(path)) {
          continue;
        }

        resolvedQualifiedNames.add(path);
        resolvedTools.push(namespacedTool.tool);
        continue;
      }
    }

    if (tool) {
      resolvedTools.push(tool);
      continue;
    }

    const hostedMcpTool = deferredHostedMcpToolsByServerLabel.get(path);
    if (hostedMcpTool) {
      resolvedTools.push(hostedMcpTool);
    }
  }

  return resolvedTools;
}

export function createClientToolSearchOutputFromTools(
  toolSearchCall: protocol.ToolSearchCallItem,
  tools: Tool<any>[],
): protocol.ToolSearchOutputItem {
  const callId = resolveToolSearchCallId(toolSearchCall);
  const resolvedTools: protocol.ToolSearchOutputTool[] = [];
  const namespaceOutputIndexByName = new Map<string, number>();
  const seenToolKeys = new Set<string>();

  for (const tool of tools) {
    const runtimeToolKey = getToolSearchRuntimeToolKey(tool);
    if (runtimeToolKey && seenToolKeys.has(runtimeToolKey)) {
      continue;
    }
    if (runtimeToolKey) {
      seenToolKeys.add(runtimeToolKey);
    }

    if (tool.type === 'function') {
      const namespace = getExplicitFunctionToolNamespace(tool);
      if (namespace) {
        const description = getFunctionToolNamespaceDescription(tool);
        if (!description) {
          throw new UserError(
            `Client tool_search execute() returned namespace member "${namespace}.${tool.name}" without a namespace description.`,
          );
        }
        appendNamespaceMemberToolSearchOutput({
          namespace,
          description,
          tool,
          namespaceOutputIndexByName,
          resolvedTools,
        });
        continue;
      }

      resolvedTools.push(serializeFunctionToolForToolSearchOutput(tool));
      continue;
    }

    if (isDeferredHostedMcpTool(tool) || tool.type === 'hosted_tool') {
      if (tool.type === 'hosted_tool' && tool.providerData?.type === 'mcp') {
        resolvedTools.push(
          serializeHostedMcpToolForToolSearchOutput(tool as HostedMCPTool<any>),
        );
        continue;
      }
    }

    throw new UserError(
      'Client tool_search execute() may only return function tools or hosted MCP tools.',
    );
  }

  return {
    type: 'tool_search_output',
    status: 'completed',
    tools: resolvedTools,
    providerData: {
      call_id: callId,
      execution: 'client',
    },
  };
}

export function createBuiltInClientToolSearchOutput(
  toolSearchCall: protocol.ToolSearchCallItem,
  tools: Tool<any>[],
): protocol.ToolSearchOutputItem {
  const callId = resolveToolSearchCallId(toolSearchCall);
  const builtInArgs = getBuiltInClientToolSearchArguments(
    toolSearchCall.arguments,
  );

  if (!builtInArgs) {
    throw new UserError(
      `Runner.run() and Runner.runStreamed() only auto-execute built-in client tool_search calls with { paths: string[] }. Custom client tool_search schemas require toolSearchTool({ execution: "client", execute }) or a custom model loop before re-processing call ${callId}.`,
    );
  }

  return createClientToolSearchOutputFromTools(
    toolSearchCall,
    resolveBuiltInClientToolSearchTools(builtInArgs.paths, tools),
  );
}

export async function executeCustomClientToolSearch<TContext>(args: {
  agent: Agent<TContext, any>;
  runContext: RunContext<TContext>;
  toolSearchCall: protocol.ToolSearchCallItem;
  toolSearchTool: Tool<TContext>;
  tools: Tool<TContext>[];
}): Promise<{
  output: protocol.ToolSearchOutputItem;
  runtimeTools: Tool<TContext>[];
}> {
  const { agent, runContext, toolSearchCall, toolSearchTool, tools } = args;
  const executor = getClientToolSearchExecutor(toolSearchTool);
  if (!executor) {
    throw new UserError(
      'Client tool_search execution requires a registered execute callback.',
    );
  }

  const runtimeTools = normalizeClientToolSearchExecutorResult(
    await executor({
      agent,
      availableTools: [...tools],
      loadDefault: (paths) => resolveBuiltInClientToolSearchTools(paths, tools),
      runContext,
      toolCall: toolSearchCall,
    }),
  );

  return {
    output: createClientToolSearchOutputFromTools(toolSearchCall, runtimeTools),
    runtimeTools,
  };
}

export function getClientToolSearchHelper<TContext>(
  tools: Tool<TContext>[],
): Tool<TContext> | undefined {
  return tools.find(isClientToolSearchTool);
}
