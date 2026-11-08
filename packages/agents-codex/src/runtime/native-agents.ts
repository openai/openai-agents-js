import { jsonObject, type JsonValue, type JsonObject } from './binding';
import type { ToolContext, ToolCallContext } from './tools';
import { interceptedCallInfo } from './call-metadata';
import type { BeforeStepContext, OperationOptions } from './session';
import type { ChildTurn } from './subagents';

/** Identity of a native child's callback; it does not grant execution authority. */
export interface ChildInvocation {
  readonly sessionId: string;
  readonly childId: string;
  readonly instanceId: string;
  readonly turnId: string;
  readonly submissionId: string;
}

/** One preparation of the original, independently owned native child Turn. */
export interface ChildBeforeStepContext<Context = unknown> extends Omit<
  BeforeStepContext<Context>,
  'submission'
> {
  readonly submission: ChildTurn;
  readonly child: ChildInvocation;
}

export interface NativeToolCall {
  readonly agentRole?: string | null;
  readonly model?: string | null;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string | null;
  readonly name: string;
  readonly namespace: string | null;
  readonly phase: 'before' | 'after';
  readonly route: 'direct' | 'extension' | 'programmatic_tool_calling' | 'mcp';
  readonly boundary:
    'pre_dispatch' | 'executor_return' | 'nested_return' | 'cell_return';
  readonly toolKind: 'function_json' | 'function' | 'freeform' | 'tool_search';
  readonly input: JsonValue;
  readonly result: JsonValue;
  readonly outerCallId?: string | null;
  readonly cellId?: string | null;
  readonly runtimeToolCallId?: string | null;
}

export interface NativeRoleOptions {
  name: string;
  instructions: string;
  description: string;
  model?: string;
  modelSettings?: { reasoningEffort?: string };
}

export class NativeRole {
  readonly name: string;
  readonly instructions: string;
  readonly description: string;
  readonly model?: string;
  readonly modelSettings?: Readonly<{ reasoningEffort?: string }>;

  constructor(options: NativeRoleOptions) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(options.name) ||
      ['default', 'explorer', 'worker'].includes(options.name)
    )
      throw new TypeError('Choose a distinct native role name');
    for (const value of [
      options.instructions,
      options.description,
      options.model,
      options.modelSettings?.reasoningEffort,
    ])
      if (value !== undefined && !value.trim())
        throw new TypeError('Native role text must not be blank');
    this.name = options.name;
    this.instructions = options.instructions;
    this.description = options.description;
    this.model = options.model;
    this.modelSettings =
      options.modelSettings && Object.freeze({ ...options.modelSettings });
    Object.freeze(this);
  }
}

export interface NativeAgentsOptions<Context = unknown> {
  additionalRoles?: readonly NativeRole[];
  maxChildren?: number;
  maxDepth?: number;
  /** Permit owned child questions through the Session's interaction API. */
  interactions?: boolean;
  /**
   * Select tools independently before each native child's model preparation.
   * Returning undefined keeps that child's defaults; [] selects no tools.
   * Each original child Turn starts its own stepIndex at zero.
   */
  beforeStep?: (
    context: ChildBeforeStepContext<Context>,
  ) => ReturnType<NonNullable<OperationOptions<Context>['beforeStep']>>;
  approval?: (
    context: ToolContext<Context>,
    call: NativeToolCall,
  ) => boolean | Promise<boolean>;
}

/** Declare model-selected native children sharing the Session's tools and context. */
export class NativeAgents<Context = unknown> {
  readonly kind = 'native_agents' as const;
  readonly additionalRoles: readonly NativeRole[];
  readonly maxChildren?: number;
  readonly maxDepth: number;
  readonly interactions: boolean;
  readonly beforeStep?: NativeAgentsOptions<Context>['beforeStep'];
  readonly approval?: NativeAgentsOptions<Context>['approval'];

  constructor(options: NativeAgentsOptions<Context> = {}) {
    const roles = [...(options.additionalRoles ?? [])];
    if (
      roles.some((role) => !(role instanceof NativeRole)) ||
      new Set(roles.map((role) => role.name)).size !== roles.length
    )
      throw new TypeError(
        'Additional roles must have distinct NativeRole declarations',
      );
    for (const value of [options.maxChildren, options.maxDepth])
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new TypeError('Native child limits must be positive integers');
    if (
      options.interactions !== undefined &&
      typeof options.interactions !== 'boolean'
    )
      throw new TypeError('Native child interactions must be a boolean');
    if (
      options.beforeStep !== undefined &&
      typeof options.beforeStep !== 'function'
    )
      throw new TypeError('Native child beforeStep must be callable');
    if (
      options.approval !== undefined &&
      typeof options.approval !== 'function'
    )
      throw new TypeError('Native child approval must be callable');
    this.additionalRoles = Object.freeze(roles);
    this.maxChildren = options.maxChildren;
    this.maxDepth = options.maxDepth ?? 1;
    this.interactions = options.interactions ?? false;
    this.beforeStep = options.beforeStep;
    this.approval = options.approval;
    Object.freeze(this);
  }
}

/** @internal Core's collaboration tools share one admission and approval boundary. */
export const collaborationTools = Object.freeze([
  'spawn_agent',
  'wait_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
] as const);

/** @internal Approval covers root and descendant collaboration dispatch. */
export function nativeAgentsPolicyRules(
  declaration: NativeAgents,
): JsonObject[] {
  return declaration.approval
    ? collaborationTools.map((name) => ({
        name,
        namespace: 'collaboration',
        timeout: null,
        scope: 'thread_tree',
      }))
    : [];
}

/** @internal The Session retains callback ownership until this decision settles. */
export async function applyNativeAgentsApproval<Context>(
  declaration: NativeAgents<Context>,
  context: Context,
  submission: ToolCallContext<Context>['submission'],
  request: JsonObject,
  signal: AbortSignal,
  decide: ToolContext<Context>['decide'],
): Promise<JsonObject> {
  const tool = jsonObject.parse(request.tool_name);
  if (
    !declaration.approval ||
    request.phase !== 'before' ||
    tool.namespace !== 'collaboration' ||
    !collaborationTools.some((name) => name === tool.name)
  )
    return { action: 'continue' };
  if (request.call_id == null) return { action: 'deny' };
  try {
    signal.throwIfAborted();
    const call: NativeToolCall = Object.freeze({
      threadId: request.thread_id as string,
      turnId: request.turn_id as string,
      callId: request.call_id as string | null,
      name: tool.name as string,
      namespace: 'collaboration',
      phase: 'before',
      route:
        request.route === 'code_mode'
          ? 'programmatic_tool_calling'
          : (request.route as NativeToolCall['route']),
      boundary: request.boundary as NativeToolCall['boundary'],
      toolKind: request.tool_kind as NativeToolCall['toolKind'],
      input: structuredClone(request.input),
      result: request.result ?? null,
      outerCallId: request.outer_call_id as string | null,
      cellId: request.cell_id as string | null,
      runtimeToolCallId: request.runtime_tool_call_id as string | null,
      agentRole: (request.agent_role as string | null) ?? null,
      model: (request.model as string | null) ?? null,
    });
    const approved = await declaration.approval(
      Object.freeze({
        context,
        submission,
        decide,
        call: interceptedCallInfo(submission, request),
        threadId: call.threadId,
        turnId: call.turnId,
        callId: call.callId!,
        signal,
        originalArguments: Object.freeze({}),
        effectiveArguments: Object.freeze({}),
      }),
      call,
    );
    signal.throwIfAborted();
    return { action: approved === true ? 'continue' : 'deny' };
  } catch {
    return { action: 'deny' };
  }
}
