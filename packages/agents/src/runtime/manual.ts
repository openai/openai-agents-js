import { z } from 'zod';
import { decode, jsonValue, type JsonValue } from './binding';
import type { ThreadOptions } from './options';
import type { ToolCallInfo } from './call-metadata';
import { outputOf, type ToolDeclaration, type ToolResponse } from './tools';

const manualDefinition = Symbol('manual tool declaration');
declare const manualReplyType: unique symbol;

interface Definition {
  resultSchema: JsonValue;
  parseInput(args: JsonValue): unknown;
  parseResult(value: unknown): ToolResponse;
}

/** A result for an exact live manual request. Submit it with Session.submit. */
export interface ManualToolReply<Result = unknown> {
  readonly [manualReplyType]: Result;
}

export interface ManualToolRequest<Input = unknown, Result = unknown> {
  /** SDK-issued requests include frozen observed metadata, separate from reply authority. */
  readonly call?: ToolCallInfo;
  readonly type: 'action_requested';
  readonly sessionId: string;
  readonly submissionId: string;
  readonly subagentId: string | null;
  readonly name: string;
  readonly namespace: string | null;
  readonly turnId: string;
  readonly callId: string;
  readonly arguments: Input;
  reply(value: Result): ManualToolReply<Result>;
}

export interface ManualTool<
  Input = unknown,
  Result = unknown,
> extends ToolDeclaration {
  readonly kind: 'manual';
  readonly [manualDefinition]: Definition;
  match(action: unknown): ManualToolRequest<Input, Result> | undefined;
}

interface RequestAuthority {
  definition: Definition;
  current(): boolean;
}
const requests = new WeakMap<object, RequestAuthority>();
const replies = new WeakMap<
  object,
  { authority: RequestAuthority; value: unknown }
>();

function isObject(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

/** @internal Conservative no-handler preflight before any model work. */
export function supportsManualCheckpoint(
  threadOptions: ThreadOptions,
  hasEnvironment: boolean,
): boolean {
  const config = threadOptions.config ?? {};
  const runtime = threadOptions.runtime;
  const mcp = config.mcp_servers;
  const codeMode = config['features.code_mode'];
  return !(
    hasEnvironment ||
    runtime?.environment ||
    config['agents.enabled'] === true ||
    codeMode === true ||
    (isObject(codeMode) &&
      'enabled' in codeMode &&
      codeMode.enabled === true) ||
    (isObject(mcp) && Object.keys(mcp).length) ||
    Object.keys(config).some((key) => key.startsWith('mcp_servers.'))
  );
}

/** Declare a function whose result the application supplies, without an execution callback. */
export function manualTool<P extends z.ZodType, R extends z.ZodType>(options: {
  name: string;
  description: string;
  parameters: P;
  result: R;
  deferLoading?: boolean;
}): ManualTool<z.output<P>, z.input<R>> {
  const { parameters, result } = options;
  const definition: Definition = {
    resultSchema: decode(
      jsonValue,
      JSON.stringify(z.toJSONSchema(result, { io: 'input' })),
    ),
    parseInput: (args) => parameters.parse(args),
    parseResult: (value) => outputOf(jsonValue.parse(result.parse(value))),
  };
  return assembleManualTool<z.output<P>, z.input<R>>(
    {
      name: options.name,
      description: options.description,
      deferLoading: options.deferLoading,
      parameters: decode(
        jsonValue,
        JSON.stringify(z.toJSONSchema(parameters, { io: 'input' })),
      ),
    },
    definition,
  );
}

/** @internal Share the existing manual owner; callers supply already captured JSON and parsers. */
export function assembleManualTool<Input, Result>(
  options: ToolDeclaration,
  definition: Definition,
): ManualTool<Input, Result> {
  const deferLoading = options.deferLoading;
  if (deferLoading !== undefined && typeof deferLoading !== 'boolean')
    throw new TypeError('deferLoading must be a boolean');
  return Object.freeze({
    kind: 'manual' as const,
    name: options.name,
    description: options.description,
    deferLoading: deferLoading ?? false,
    parameters: options.parameters,
    [manualDefinition]: definition,
    match(action: unknown) {
      if (!isObject(action)) return undefined;
      const authority = requests.get(action);
      if (authority?.definition !== definition) return undefined;
      return action as ManualToolRequest<Input, Result>;
    },
  });
}

/** @internal Current declarations describe restore compatibility, never persisted validators. */
export function manualResultSchema(tool: ManualTool): JsonValue {
  return jsonValue.parse(tool[manualDefinition].resultSchema);
}

/** @internal Validate against the current captured declaration before a durable claim. */
export function validateManualResult(tool: ManualTool, value: unknown): void {
  try {
    tool[manualDefinition].parseResult(value);
  } catch {
    throw new TypeError('Manual tool result failed validation');
  }
}

/** @internal Each Session owns and revokes these capabilities; no grant is serialized. */
export function createManualRequest<Input, Result>(
  tool: ManualTool<Input, Result>,
  identity: {
    sessionId: string;
    submissionId: string;
    subagentId: string | null;
    turnId: string;
    callId: string;
    call?: ToolCallInfo;
  },
  args: JsonValue,
  isCurrent: () => boolean,
) {
  let active = true;
  const definition = tool[manualDefinition];
  const authority: RequestAuthority = {
    definition,
    current: () => active && isCurrent(),
  };
  const checkCurrent = () => {
    if (!authority.current())
      throw new TypeError('Manual tool request is no longer active');
  };
  checkCurrent();
  let parsed: unknown;
  try {
    parsed = definition.parseInput(args);
  } catch {
    throw new TypeError('Manual tool arguments failed validation');
  }
  checkCurrent();
  let cachedRequest: ManualToolRequest<Input, Result> | undefined;
  return {
    request(): ManualToolRequest<Input, Result> | undefined {
      if (!authority.current()) return undefined;
      if (cachedRequest) return cachedRequest;
      const request: ManualToolRequest<Input, Result> = Object.freeze({
        type: 'action_requested',
        sessionId: identity.sessionId,
        submissionId: identity.submissionId,
        subagentId: identity.subagentId,
        name: tool.name,
        namespace: null,
        turnId: identity.turnId,
        callId: identity.callId,
        call: identity.call,
        get arguments() {
          return structuredClone(parsed) as Input;
        },
        reply(value: Result): ManualToolReply<Result> {
          const reply = Object.freeze({}) as ManualToolReply<Result>;
          replies.set(reply, { authority, value });
          return reply;
        },
      });
      requests.set(request, authority);
      cachedRequest = request;
      return request;
    },
    matchesReply(reply: unknown): boolean {
      return (
        authority.current() &&
        isObject(reply) &&
        replies.get(reply)?.authority === authority
      );
    },
    takeReply(
      reply: unknown,
      beforeConsume?: (output: ToolResponse) => void,
    ): ToolResponse | undefined {
      if (!authority.current() || !isObject(reply)) return undefined;
      const found = replies.get(reply);
      if (found?.authority !== authority) return undefined;
      let output: ToolResponse;
      try {
        output = definition.parseResult(found.value);
      } catch {
        throw new TypeError('Manual tool result failed validation');
      }
      beforeConsume?.(output);
      checkCurrent();
      active = false;
      replies.delete(reply);
      return output;
    },
    deactivate(): void {
      active = false;
    },
  };
}

/** @internal Only candidates issued by this runtime carry reply authority. */
export function isManualReply(value: unknown): value is ManualToolReply {
  return isObject(value) && replies.has(value);
}
