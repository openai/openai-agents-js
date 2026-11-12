import { projectMcpToolNames } from './mcp-names';
import type {
  MCPToolStartObservation,
  MCPToolEndObservation,
} from '@openai/agents-core';
import type { MCPServer, MCPToolFilterContext } from '@openai/agents-core';
import {
  losslessJsonObjectSchema as jsonObject,
  losslessJsonValueSchema as jsonValue,
  type JsonValue,
} from './binding';
import {
  createNamespacedFunctionTool,
  ToolOutput,
  type FunctionTool,
} from './tools';

/** A caller-owned SDK MCP connection selected before a native Session opens. */
export interface McpNamespace<Context = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly server: MCPServer;
  readonly authenticate?: (
    context: Context,
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

export interface SelectMcpToolsOptions<Context = unknown> {
  readonly context: Context;
  /**
   * Per-call approval, awaited before either observer or the borrowed client.
   * Only true allows execution. Rejection, decline or cancellation prevents
   * dispatch; entered approval callbacks must settle or cooperate with the signal.
   */
  readonly approval?: (
    event: MCPToolStartObservation,
  ) => boolean | Promise<boolean>;
  /** Omit to select every discovered tool that passes the server's filter. */
  readonly toolNames?: readonly string[];
  /** Required for callable classic filters; supply the actual classic objects. */
  readonly filterContext?: Pick<
    MCPToolFilterContext<Context>,
    'runContext' | 'agent'
  >;
  readonly signal?: AbortSignal;
}

const invalidProviderNameCharacter = /[^A-Za-z0-9_-]/;
const maxDiscoveredTools = 16_384;
const maxDiscoveredNameBytes = 4_096;
const maxDiscoveredNameBudget = 1_048_576;

function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

// Keep native observations independent of the classic package at runtime.
function detachedMcpObservation<T extends MCPToolStartObservation>(
  event: T,
): T {
  const { signal, ...data } = event;
  return Object.freeze({
    ...structuredClone(data),
    ...(signal === undefined ? {} : { signal }),
  }) as T;
}

// Read legacy array metadata before copying content. Full fields take precedence.
function normalizeMcpResult(
  raw: unknown,
  fullResult: boolean,
): MCPToolEndObservation['result'] {
  if (
    fullResult &&
    (raw === null || typeof raw !== 'object' || Array.isArray(raw))
  )
    throw new TypeError('MCP callToolResult must return an object');
  const result = fullResult ? (raw as Record<string, unknown>) : undefined;
  const content = result ? result.content : raw;
  if (!Array.isArray(content))
    throw new TypeError('MCP content must be an array');
  const attached = content as unknown as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...result,
    content: [...content],
  };
  for (const key of ['isError', 'structuredContent', '_meta']) {
    const primary = result?.[key];
    const value = primary !== undefined ? primary : attached[key];
    if (value !== undefined) normalized[key] = value;
  }
  if (
    normalized.isError !== undefined &&
    typeof normalized.isError !== 'boolean'
  )
    throw new TypeError('MCP isError must be a boolean');
  return structuredClone(
    normalized,
  ) as unknown as MCPToolEndObservation['result'];
}

function outputOfMcp(
  result: MCPToolEndObservation['result'],
  useStructuredContent: boolean,
): ToolOutput {
  const { content, isError, structuredContent: structured } = result;
  if (useStructuredContent && isError !== true && structured !== undefined)
    return new ToolOutput([
      { type: 'inputText', text: JSON.stringify(jsonObject.parse(structured)) },
    ]);
  return new ToolOutput(
    content.map((value) => {
      const block = jsonObject.parse(value);
      if (block.type === 'text') {
        if (typeof block.text !== 'string')
          throw new TypeError('MCP text must be a string');
        return { type: 'inputText' as const, text: block.text };
      }
      if (block.type === 'image') {
        if (
          typeof block.mimeType !== 'string' ||
          typeof block.data !== 'string'
        )
          throw new TypeError('MCP image requires mimeType and data');
        return {
          type: 'inputImage' as const,
          imageUrl: `data:${block.mimeType};base64,${block.data}`,
        };
      }
      // Preserve content as JSON without protocol metadata; never fetch URIs.
      delete block._meta;
      if (
        block.type === 'resource' &&
        block.resource !== null &&
        typeof block.resource === 'object' &&
        !Array.isArray(block.resource)
      )
        delete block.resource._meta;
      return { type: 'inputText' as const, text: JSON.stringify(block) };
    }),
    isError !== true,
  );
}

/**
 * Authenticate and materialize one selected namespace for a future Session.
 * Native projected names for model-facing tools; each returned tool's `ref`
 * for native selection. Original peer names for `toolNames` and borrowed
 * dispatch. Namespace characters: ASCII letters, digits, underscores, and
 * hyphens; namespace `tool_search` reserved.
 * Call again for refresh; existing snapshots and Sessions remain unchanged.
 * Discovery limits before filtering: 16,384 tools, 4,096 UTF-8 bytes per tool
 * name, and 1 MiB of tool-name bytes in total.
 * The caller owns connect/close and must serialize unsafe reauthentication of
 * a shared mutable client, or use separate clients for different auth scopes.
 * Cancellation joins entered discovery; it never closes the borrowed server.
 */
export async function selectMcpTools<Context = unknown>(
  namespace: McpNamespace<Context>,
  options: SelectMcpToolsOptions<Context>,
): Promise<readonly FunctionTool<Context>[]> {
  const { name, description, server, authenticate } = namespace;
  const { context, signal, approval } = options;
  if (approval !== undefined && typeof approval !== 'function')
    throw new TypeError('MCP approval must be callable');
  const { onToolStart, onToolEnd } = server;
  for (const callback of [onToolStart, onToolEnd])
    if (callback !== undefined && typeof callback !== 'function')
      throw new TypeError('MCP observers must be callable');
  const observers = Object.freeze({ onToolStart, onToolEnd });
  const serverName = server.name;
  const check = () => signal?.throwIfAborted();
  check();
  if (
    typeof name !== 'string' ||
    !name ||
    (description !== undefined && typeof description !== 'string')
  )
    throw new TypeError(
      'MCP namespace requires a name and optional string description',
    );
  if (invalidProviderNameCharacter.test(name))
    throw new TypeError(
      'MCP namespace name must use only ASCII letters, digits, underscores, and hyphens',
    );
  if (name === 'tool_search')
    throw new TypeError('MCP namespace tool_search is reserved');
  if (authenticate !== undefined && typeof authenticate !== 'function')
    throw new TypeError('MCP authenticate must be a function');
  if (
    server.toolMetaResolver != null ||
    server.customDataExtractor != null ||
    server.errorFunction != null ||
    (server.toolInputGuardrails?.length ?? 0) > 0 ||
    (server.toolOutputGuardrails?.length ?? 0) > 0
  )
    throw new TypeError(
      'Selected MCP tools do not support custom metadata, extractors, error handlers, or guardrails',
    );
  const filter =
    typeof server.toolFilter === 'function' ? server.toolFilter : undefined;
  const allowed =
    server.toolFilter && typeof server.toolFilter !== 'function'
      ? [...(server.toolFilter.allowedToolNames ?? [])]
      : [];
  const blocked =
    server.toolFilter && typeof server.toolFilter !== 'function'
      ? [...(server.toolFilter.blockedToolNames ?? [])]
      : [];
  // Classic discovery also accepts Agent<any, any>. Keep the actual typed Agent
  // reference across its nongeneric MCPServer filter boundary; do not fabricate one.
  const filterContext: MCPToolFilterContext<any> | undefined =
    options.filterContext && {
      runContext: options.filterContext.runContext,
      agent: options.filterContext.agent,
      serverName: server.name,
    };
  if (
    filter &&
    (!filterContext || filterContext.runContext.context !== context)
  )
    throw new TypeError(
      'A callable MCP filter requires captured classic context matching the authentication context',
    );
  const requested =
    options.toolNames === undefined ? undefined : [...options.toolNames];
  if (
    requested &&
    (requested.some((name) => typeof name !== 'string' || !name) ||
      new Set(requested).size !== requested.length)
  )
    throw new TypeError('MCP toolNames must contain unique nonempty names');
  const list = server.listTools.bind(server);
  const invalidate = server.invalidateToolsCache.bind(server);
  const fullCall = server.callToolResult?.bind(server);
  const legacyCall = server.callTool.bind(server);
  const structured = server.useStructuredContent === true;
  const capturedNamespace = Object.freeze({ name, description });

  await authenticate?.(context, signal);
  check();
  await invalidate();
  check();
  const listed = await list();
  check();
  if (listed.length > maxDiscoveredTools)
    throw new TypeError('MCP discovery exceeds the 16384-tool limit');
  const names = new Set<string>();
  let nameBudget = 0;
  for (const declaration of listed) {
    if (
      typeof declaration.name !== 'string' ||
      !declaration.name ||
      names.has(declaration.name)
    )
      throw new TypeError(
        'MCP discovery must contain unique nonempty tool names',
      );
    const nameBytes = Buffer.byteLength(declaration.name, 'utf8');
    if (nameBytes > maxDiscoveredNameBytes)
      throw new TypeError(
        'MCP discovery exceeds the 4096-byte tool name limit',
      );
    nameBudget += nameBytes;
    if (nameBudget > maxDiscoveredNameBudget)
      throw new TypeError('MCP discovery exceeds the 1048576-byte name budget');
    names.add(declaration.name);
  }
  const discovered = structuredClone(listed);
  const projected = projectMcpToolNames([{ name, tools: [...names] }], false);
  const selectedRawNames = new Set<string>();
  const tools: FunctionTool<Context>[] = [];
  for (const declaration of discovered) {
    if (
      (allowed.length && !allowed.includes(declaration.name)) ||
      blocked.includes(declaration.name)
    )
      continue;
    if (filter) {
      const accepted = await filter(
        filterContext!,
        structuredClone(declaration),
      );
      check();
      if (!accepted) continue;
    }
    if (requested && !requested.includes(declaration.name)) continue;
    const rawName = declaration.name;
    const model = projected.get(JSON.stringify([name, rawName]))!;
    const schema = jsonObject.parse(declaration.inputSchema);
    if (
      schema.type !== 'object' ||
      (declaration.description !== undefined &&
        typeof declaration.description !== 'string')
    )
      throw new TypeError(
        'MCP declarations require an object input schema and optional string description',
      );
    const parameters = freezeJson(jsonValue.parse(schema));
    selectedRawNames.add(rawName);
    tools.push(
      createNamespacedFunctionTool<Context>({
        namespace: { ...capturedNamespace, name: model.namespace },
        name: model.name,
        description: declaration.description ?? '',
        parameters,
        async execute(args, callContext, admit) {
          const event: MCPToolStartObservation = {
            serverName,
            toolName: rawName,
            callId: callContext.callId,
            arguments: args,
            signal: callContext.signal,
          };
          admit();
          if (approval) {
            const accepted = await approval(detachedMcpObservation(event));
            admit();
            if (accepted !== true)
              throw new Error('Selected MCP call was not approved');
          }
          await observers.onToolStart?.(detachedMcpObservation(event));
          admit();
          const raw = fullCall
            ? await fullCall(rawName, args, undefined, {
                signal: callContext.signal,
              })
            : await legacyCall(rawName, args, undefined, {
                signal: callContext.signal,
              });
          admit();
          const result = normalizeMcpResult(raw, fullCall !== undefined);
          await observers.onToolEnd?.(
            detachedMcpObservation({ ...event, result }),
          );
          admit();
          return outputOfMcp(result, structured);
        },
      }),
    );
  }
  if (requested && requested.some((name) => !selectedRawNames.has(name)))
    throw new TypeError(
      'Requested MCP tools were not discovered or were filtered out',
    );
  check();
  return Object.freeze(tools);
}
