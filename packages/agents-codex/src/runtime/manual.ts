import { z } from 'zod';
import {
  copyJsonValue,
  decode,
  jsonValue,
  losslessJsonValueSchema,
  type JsonValue,
} from './binding';
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

/** A result for an exact live manual request. Deliver it with Session.respond. */
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
  { identity: object; value: unknown; consumed?: true }
>();
const preparedResults = new WeakMap<
  object,
  { definition: Definition; output: ToolResponse }
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
    !!threadOptions._hosted_tools?.length ||
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

type JsonData =
  | null
  | boolean
  | number
  | string
  | readonly JsonData[]
  | { readonly [key: string]: JsonData };

/** Declare a manual function with JSON-compatible parsed arguments, including readonly data. */
export function manualTool<
  P extends z.ZodType<JsonData>,
  R extends z.ZodType,
>(options: {
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
    parseResult: (value) =>
      outputOf(losslessJsonValueSchema.parse(result.parse(value))),
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

/** @internal Parse once; only a live request for this declaration may consume the result. */
export function prepareManualResult(tool: ManualTool, value: unknown): unknown {
  try {
    const definition = tool[manualDefinition];
    const output = definition.parseResult(value);
    const prepared = Object.freeze({});
    preparedResults.set(prepared, { definition, output });
    return prepared;
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
  const replyIdentity = {};
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
  let parsed: JsonValue;
  try {
    parsed = copyJsonValue(definition.parseInput(args));
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
          return copyJsonValue(parsed) as Input;
        },
        reply(value: Result): ManualToolReply<Result> {
          const reply = Object.freeze({}) as ManualToolReply<Result>;
          replies.set(reply, { identity: replyIdentity, value });
          return reply;
        },
      });
      requests.set(request, authority);
      cachedRequest = request;
      return request;
    },
    ownsReply(reply: unknown): boolean {
      return isObject(reply) && replies.get(reply)?.identity === replyIdentity;
    },
    matchesReply(reply: unknown): boolean {
      return (
        authority.current() &&
        isObject(reply) &&
        replies.get(reply)?.identity === replyIdentity
      );
    },
    takeReply(
      reply: unknown,
      beforeConsume?: (output: ToolResponse) => void,
    ): ToolResponse | undefined {
      if (!authority.current() || !isObject(reply)) return undefined;
      const found = replies.get(reply);
      if (found?.identity !== replyIdentity) return undefined;
      let output: ToolResponse;
      try {
        const prepared = isObject(found.value)
          ? preparedResults.get(found.value)
          : undefined;
        if (prepared && prepared.definition !== definition)
          throw new TypeError('Manual result declaration does not match');
        output = prepared?.output ?? definition.parseResult(found.value);
      } catch {
        throw new TypeError('Manual tool result failed validation');
      }
      beforeConsume?.(output);
      checkCurrent();
      active = false;
      // Keep only binding identity so a retained handler can return this reply.
      found.value = undefined;
      found.consumed = true;
      return output;
    },
    deactivate(): void {
      active = false;
    },
  };
}

/** @internal Only candidates issued by this runtime carry reply authority. */
export function isManualReply(value: unknown): value is ManualToolReply {
  return isObject(value) && replies.has(value) && !replies.get(value)!.consumed;
}
