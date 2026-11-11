import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  copyJsonValue,
  decode,
  losslessJsonValueSchema,
  type JsonValue,
} from './binding';
import type { ThreadOptions } from './options';
import type { ToolCallInfo } from './call-metadata';
import { outputOf, type ToolDeclaration, type ToolResponse } from './tools';

// Parsed function inputs can contain opaque application values. Keep their
// semantics while detaching ordinary containers and dates from approval views.
function copyApprovalInput(
  value: unknown,
  copies = new Map<object, unknown>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value);
  if (value instanceof Date)
    return new Date(Date.prototype.getTime.call(value));
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return value;
  const result = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(prototype);
  copies.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    Object.defineProperty(result, key, {
      value: copyApprovalInput(Reflect.get(value, key), copies),
      enumerable: descriptor.enumerable,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

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

/** A managed function decision; deliver its reply through Session.respond or onInteraction. */
export interface FunctionApprovalRequest<
  Input = unknown,
> extends ManualToolRequest<Input, never> {
  readonly approvalRequired: true;
  /** Opaque identifier for matching an approval event to this live request. */
  readonly approvalId: string;
  /** Validated arguments after the pre-approval input policy.
   * Plain objects, arrays and dates are detached; opaque values retain application identity.
   */
  readonly effectiveArguments: Input;
  approve(options?: { always?: boolean }): ManualToolReply;
  reject(reason?: string, options?: { always?: boolean }): ManualToolReply;
}

/** Narrow an SDK-issued managed function approval. */
export function isFunctionApprovalRequest(
  value: unknown,
): value is FunctionApprovalRequest {
  return (
    isObject(value) &&
    requests.has(value) &&
    'approvalRequired' in value &&
    value.approvalRequired === true
  );
}

/** Data bound to a consumed grant, never an additional execution capability. */
export interface ApprovedArguments {
  readonly value: unknown;
  matches(value: unknown): boolean;
}

export interface ApprovalDecision {
  useDefaultReason?: boolean;
  approve: boolean;
  always: boolean;
  reason: string;
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
  approvalInput?: unknown;
}
const requests = new WeakMap<object, RequestAuthority>();

function copyApprovalJson(
  value: unknown,
  parents = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  )
    return value;
  if (typeof value !== 'object' || value === null)
    throw new TypeError('Approval input must be faithful JSON');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) ||
    parents.has(value)
  )
    throw new TypeError('Approval input must be faithful JSON');
  const property = (key: PropertyKey): JsonValue => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor?.enumerable ||
      !('value' in descriptor)
    )
      throw new TypeError('Approval input must be faithful JSON');
    return copyApprovalJson(descriptor.value, parents);
  };
  parents.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')!.value;
      if (keys.length !== length + 1)
        throw new TypeError('Approval input must be faithful JSON');
      return Array.from({ length }, (_, index) => property(String(index)));
    }
    return Object.fromEntries(keys.map((key) => [key, property(key)]));
  } finally {
    parents.delete(value);
  }
}

/** @internal Display only faithful JSON of the captured execution value. */
export function functionApprovalInput(
  request: FunctionApprovalRequest,
): JsonValue | undefined {
  const authority = requests.get(request);
  if (authority?.current() && authority.approvalInput !== undefined) {
    try {
      return copyApprovalJson(authority.approvalInput);
    } catch {
      // Opaque values retain native approval, without a browser projection.
    }
  }
}
const replies = new WeakMap<
  object,
  {
    identity: object;
    value?: unknown;
    approval?: ApprovalDecision;
    consumed?: true;
  }
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
      losslessJsonValueSchema,
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
        losslessJsonValueSchema,
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
  return losslessJsonValueSchema.parse(tool[manualDefinition].resultSchema);
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
  managedApproval = false,
  initialValidatedInput?: { value: unknown },
) {
  if (initialValidatedInput && !managedApproval)
    throw new TypeError('Validated initial input requires managed approval');
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
  const copyInput = managedApproval ? copyApprovalInput : copyJsonValue;
  let parsed: unknown;
  try {
    parsed = copyInput(
      initialValidatedInput
        ? initialValidatedInput.value
        : definition.parseInput(args),
    );
  } catch {
    throw new TypeError('Manual tool arguments failed validation');
  }
  checkCurrent();
  let effectiveArguments = parsed;
  let approvedArguments: { value: unknown } | undefined;
  let cachedRequest: ManualToolRequest<Input, Result> | undefined;
  const approvalReply = (
    approve: boolean,
    reason: string | undefined,
    always: boolean,
  ): ManualToolReply => {
    checkCurrent();
    if (
      (reason !== undefined && typeof reason !== 'string') ||
      typeof always !== 'boolean'
    )
      throw new TypeError(
        'Approval reason must be a string and always a boolean',
      );
    const reply = Object.freeze({}) as ManualToolReply;
    replies.set(reply, {
      identity: replyIdentity,
      approval: {
        approve,
        reason: reason ?? 'Tool execution was rejected',
        always,
        useDefaultReason: reason === undefined,
      },
    });
    return reply;
  };
  return {
    setEffectiveArguments(value: JsonValue): void {
      checkCurrent();
      effectiveArguments = copyInput(definition.parseInput(value));
      checkCurrent();
    },
    setValidatedEffectiveArguments(value: unknown): void {
      checkCurrent();
      effectiveArguments = copyInput(value);
      authority.approvalInput = effectiveArguments;
    },
    executionArguments(): ApprovedArguments | undefined {
      const approved = approvedArguments;
      if (!approved) return undefined;
      return {
        get value() {
          return copyInput(approved.value);
        },
        matches: (value) => isDeepStrictEqual(value, approved.value),
      };
    },
    takeApprovalReply(reply: unknown): ApprovalDecision | undefined {
      if (!managedApproval || !authority.current() || !isObject(reply))
        return undefined;
      const found = replies.get(reply);
      if (found?.identity !== replyIdentity || !found.approval)
        return undefined;
      if (found.approval.approve)
        approvedArguments = { value: copyInput(effectiveArguments) };
      active = false;
      return found.approval;
    },
    request(): ManualToolRequest<Input, Result> | undefined {
      if (!authority.current()) return undefined;
      if (cachedRequest) return cachedRequest;
      const request: ManualToolRequest<Input, Result> = {
        type: 'action_requested',
        ...(managedApproval
          ? {
              approvalRequired: true as const,
              approvalId: randomUUID(),
              approve: (options: { always?: boolean } = {}) =>
                approvalReply(
                  true,
                  'Tool execution was rejected',
                  options.always ?? false,
                ),
              reject: (reason?: string, options: { always?: boolean } = {}) =>
                approvalReply(false, reason, options.always ?? false),
            }
          : {}),
        sessionId: identity.sessionId,
        submissionId: identity.submissionId,
        subagentId: identity.subagentId,
        name: tool.name,
        namespace: null,
        turnId: identity.turnId,
        callId: identity.callId,
        call: identity.call,
        get arguments() {
          return copyInput(parsed) as Input;
        },
        reply(value: Result): ManualToolReply<Result> {
          if (managedApproval)
            throw new TypeError(
              'Use approve() or reject() for a managed function',
            );
          const reply = Object.freeze({}) as ManualToolReply<Result>;
          replies.set(reply, { identity: replyIdentity, value });
          return reply;
        },
      };
      if (managedApproval)
        Object.defineProperty(request, 'effectiveArguments', {
          enumerable: true,
          get: () => copyInput(effectiveArguments) as Input,
        });
      Object.freeze(request);
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
