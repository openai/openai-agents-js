import {
  AudioContentSchema,
  CallToolResultSchema,
  CreateMessageRequestParamsSchema,
  DiscoverResultSchema,
  ElicitRequestFormParamsSchema,
  ElicitRequestURLParamsSchema,
  ImageContentSchema,
  ListToolsResultSchema,
  SamplingMessageSchema,
  TextContentSchema,
  ToolResultContentSchema,
  ToolSchema,
  ToolUseContentSchema,
} from '@modelcontextprotocol/core';
import { z } from 'zod/v4';

export const VERSION = '2026-07-28';
export const EXTENSION = 'io.modelcontextprotocol/tasks';

// Public payload members are shared where revision-identical. Only the modern
// Tool and sampling tool-result forks differ from the public neutral schemas.
const modernTool = ToolSchema.omit({ execution: true }).extend({
  inputSchema: z.looseObject({
    $schema: z.string().optional(),
    type: z.literal('object'),
  }),
});
const modernListing = ListToolsResultSchema.extend({
  tools: z.array(modernTool),
});
const samplingContent = z.union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema.extend({ structuredContent: z.unknown().optional() }),
]);
const samplingParams = CreateMessageRequestParamsSchema.extend({
  messages: z.array(
    SamplingMessageSchema.extend({
      content: z.union([samplingContent, z.array(samplingContent)]),
    }),
  ),
  tools: z.array(modernTool).optional(),
});
const inputRequest = z.union([
  z.object({
    method: z.literal('elicitation/create'),
    params: z.union([
      ElicitRequestFormParamsSchema,
      ElicitRequestURLParamsSchema.omit({ elicitationId: true }),
    ]),
  }),
  z.object({
    method: z.literal('sampling/createMessage'),
    params: samplingParams,
  }),
  z.object({
    method: z.literal('roots/list'),
    params: z
      .object({
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
]);

const methods = [
  'server/discover',
  'tools/list',
  'tools/call',
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
] as const;
export type TasksMethod = (typeof methods)[number];

export interface TaskFields extends Record<string, unknown> {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed';
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
}
export interface CompleteToolResult extends Record<string, unknown> {
  resultType: 'complete';
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}
export interface TaskCreated extends TaskFields {
  resultType: 'task';
}
export interface InputRequest extends Record<string, unknown> {
  method: string;
  params?: Record<string, unknown>;
}
export interface TaskDetail extends TaskFields {
  resultType: 'complete';
  result?: CompleteToolResult;
  inputRequests?: Record<string, InputRequest>;
}
export interface ElicitResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}
export interface ToolDeclaration extends Record<string, unknown> {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
export interface ToolListing extends Record<string, unknown> {
  resultType: 'complete';
  tools: ToolDeclaration[];
  nextCursor?: string;
}
export interface Discovery extends Record<string, unknown> {
  resultType: 'complete';
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
}
export interface Acknowledgment extends Record<string, unknown> {
  resultType: 'complete';
}
export interface Results {
  'server/discover': Discovery;
  'tools/list': ToolListing;
  'tools/call': TaskCreated | CompleteToolResult;
  'tasks/get': TaskDetail;
  'tasks/update': Acknowledgment;
  'tasks/cancel': Acknowledgment;
}

/** Never include a peer value or a schema library's raw validation error. */
function unsupported(): never {
  throw new Error(
    'MCP peer or operation is outside the selected Tasks profile',
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function makeRequest(
  id: string,
  method: TasksMethod,
  params: Record<string, unknown> = {},
) {
  if (!methods.includes(method)) unsupported();
  return {
    jsonrpc: '2.0' as const,
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': {
          name: 'openai-agents-mcp-tasks',
          version: '1.0.0',
        },
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [EXTENSION]: {} },
        },
      },
    },
  };
}

function complete(raw: unknown): asserts raw is Record<string, unknown> {
  if (!object(raw) || raw.resultType !== 'complete') unsupported();
}

function toolResult(raw: unknown): CompleteToolResult {
  complete(raw);
  // The public schema supplies core content validation, but its legacy default
  // would permit omitted content. Modern complete tool results require it.
  if (
    !Array.isArray(raw.content) ||
    !CallToolResultSchema.safeParse(raw).success
  ) {
    unsupported();
  }
  return raw as CompleteToolResult;
}

function taskFields(raw: Record<string, unknown>): TaskFields {
  if (
    typeof raw.taskId !== 'string' ||
    raw.taskId.length === 0 ||
    !['working', 'input_required', 'completed', 'cancelled', 'failed'].includes(
      raw.status as string,
    ) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.lastUpdatedAt !== 'string' ||
    (raw.ttlMs !== null && !Number.isSafeInteger(raw.ttlMs)) ||
    (raw.pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(raw.pollIntervalMs) ||
        (raw.pollIntervalMs as number) < 0))
  ) {
    unsupported();
  }
  return { ...raw, pollIntervalMs: raw.pollIntervalMs ?? 0 } as TaskFields;
}

export function validateDiscovery(raw: unknown): Discovery {
  complete(raw);
  if (!DiscoverResultSchema.safeParse(raw).success) unsupported();
  const caps = raw.capabilities;
  if (
    !(raw.supportedVersions as string[]).includes(VERSION) ||
    !object(caps) ||
    !object(caps.tools) ||
    !object(caps.extensions) ||
    !object(caps.extensions[EXTENSION]) ||
    Object.keys(caps.extensions[EXTENSION]).length !== 0
  ) {
    unsupported();
  }
  return raw as Discovery;
}

/** Validate without lifting, stripping unknown form constraints, or compiling schemas. */
export function parseResult<M extends TasksMethod>(
  method: M,
  raw: unknown,
): Results[M] {
  if (!object(raw)) unsupported();
  if (method === 'tools/call' && raw.resultType === 'task') {
    return { ...taskFields(raw), resultType: 'task' } as Results[M];
  }
  // Raw discrimination precedes tolerant core schemas: malformed task replies
  // cannot become immediate success merely because they also contain content.
  complete(raw);
  switch (method) {
    case 'server/discover':
      return validateDiscovery(raw) as Results[M];
    case 'tools/list':
      if (
        !modernListing.safeParse(raw).success ||
        !Number.isSafeInteger(raw.ttlMs) ||
        (raw.ttlMs as number) < 0 ||
        !['public', 'private'].includes(raw.cacheScope as string)
      ) {
        unsupported();
      }
      return raw as Results[M];
    case 'tools/call':
      return toolResult(raw) as Results[M];
    case 'tasks/get': {
      const task = taskFields(raw);
      if (raw.result !== undefined && raw.result !== null)
        toolResult(raw.result);
      if (raw.inputRequests !== undefined && raw.inputRequests !== null) {
        if (!object(raw.inputRequests)) unsupported();
        for (const request of Object.values(raw.inputRequests)) {
          // Validate the modern embedded vocabulary, retaining the original
          // request for complete admission and challenge hashing.
          if (!inputRequest.safeParse(request).success) unsupported();
        }
      }
      return task as Results[M];
    }
    case 'tasks/update':
    case 'tasks/cancel':
      return raw as Results[M];
    default:
      return unsupported();
  }
}

/** MCP field-value encoding, including sentinel collision avoidance. */
export function encodeMcpName(value: string): string {
  if (
    value.length > 0 &&
    value === value.trim() &&
    !(value.startsWith('=?base64?') && value.endsWith('?=')) &&
    /^[\t\x20-\x7e]*$/.test(value)
  ) {
    return value;
  }
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

const headerToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const nonReachable = new Set([
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'patternProperties',
  'dependentSchemas',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$defs',
  'definitions',
]);
const maps = new Set([
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

function hasReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReference);
  return (
    object(value) &&
    Object.entries(value).some(
      ([key, child]) =>
        ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) ||
        hasReference(child),
    )
  );
}

/** Check only the selected declaration, never execute its JSON Schema. */
export function admitSelectedTool(
  tool: ToolDeclaration,
  args: Record<string, unknown>,
): void {
  if (hasReference(tool.outputSchema)) unsupported();
  const headers = new Set<string>();
  function visit(node: unknown, path: string[], reachable: boolean): void {
    if (!object(node)) return;
    if ('x-mcp-header' in node) {
      const header = node['x-mcp-header'];
      if (
        !reachable ||
        path.length === 0 ||
        typeof header !== 'string' ||
        !headerToken.test(header) ||
        !['string', 'integer', 'boolean', 'number'].includes(
          node.type as string,
        ) ||
        headers.has(header.toLowerCase())
      )
        unsupported();
      headers.add(header.toLowerCase());
      let value: unknown = args;
      for (const key of path) {
        value =
          object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
      }
      // Match the pinned client's actual mirror predicate, including false/0/''.
      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' &&
          Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value)))
      )
        unsupported();
    }
    if (object(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, [...path, key], reachable);
      }
    }
    for (const key of nonReachable) {
      const sub = node[key];
      const branches = Array.isArray(sub)
        ? sub
        : object(sub) && maps.has(key)
          ? Object.values(sub)
          : [sub];
      for (const child of branches) visit(child, path, false);
    }
  }
  visit(tool.inputSchema, [], true);
}
