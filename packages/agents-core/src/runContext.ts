import type { Agent } from './agent';
import { UserError } from './errors';
import { RunToolApprovalItem } from './items';
import logger from './logger';
import {
  getFunctionToolLookupKey,
  getFunctionToolStateKeyForCall,
} from './toolIdentity';
import { UnknownContext } from './types';
import { Usage } from './usage';

type ApprovalRecord = {
  approved: boolean | string[];
  rejected: boolean | string[];
  messages?: Record<string, string>;
  stickyRejectMessage?: string;
};

type SerializedFunctionApprovals = Array<{
  agentIdentity: string;
  approvals: Record<string, ApprovalRecord>;
}>;

type FunctionApprovalState = {
  approvalsByAgent: Map<Agent<any, any>, Map<string, ApprovalRecord>>;
  legacyFallback: boolean;
};

const COMPUTER_APPROVAL_TOOL_NAMES = new Set([
  'computer',
  'computer_use_preview',
]);

function getApprovalToolNameCandidates(
  toolName: string,
  includeFunctionAliases: boolean,
): string[] {
  if (COMPUTER_APPROVAL_TOOL_NAMES.has(toolName)) {
    return toolName === 'computer'
      ? ['computer', 'computer_use_preview']
      : ['computer_use_preview', 'computer'];
  }

  if (includeFunctionAliases) {
    const bareFunctionKey = toolName.startsWith('[')
      ? undefined
      : getFunctionToolLookupKey(toolName);
    return bareFunctionKey ? [toolName, bareFunctionKey] : [toolName];
  }

  return [toolName];
}

function mergeApprovalList(
  current: ApprovalRecord['approved'],
  incoming: ApprovalRecord['approved'],
) {
  if (current === true || incoming === true) {
    return true;
  }
  const currentList = Array.isArray(current) ? current : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];
  return Array.from(new Set([...currentList, ...incomingList]));
}

function mergeApprovalMessages(
  current: ApprovalRecord,
  incoming: ApprovalRecord,
) {
  if (current.rejected === true) {
    return current.messages;
  }

  const merged =
    current.messages || incoming.messages
      ? { ...incoming.messages, ...current.messages }
      : undefined;
  if (!merged) {
    return undefined;
  }

  if (Array.isArray(current.rejected)) {
    for (const callId of current.rejected) {
      if (
        !current.messages ||
        !Object.prototype.hasOwnProperty.call(current.messages, callId)
      ) {
        delete merged[callId];
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeStickyRejectMessage(
  current: ApprovalRecord,
  incoming: ApprovalRecord,
) {
  if (current.rejected === true) {
    return current.stickyRejectMessage;
  }
  return current.stickyRejectMessage ?? incoming.stickyRejectMessage;
}

function mergeApprovalRecords(
  current: ApprovalRecord,
  incoming: ApprovalRecord,
): ApprovalRecord {
  const mergedMessages = mergeApprovalMessages(current, incoming);
  const stickyRejectMessage = mergeStickyRejectMessage(current, incoming);
  return {
    approved: mergeApprovalList(current.approved, incoming.approved),
    rejected: mergeApprovalList(current.rejected, incoming.rejected),
    ...(mergedMessages ? { messages: mergedMessages } : {}),
    ...(stickyRejectMessage !== undefined ? { stickyRejectMessage } : {}),
  };
}

type RunContextJson = {
  context: any;
  usage: Usage;
  approvals: Record<string, ApprovalRecord>;
  toolInput?: unknown;
};

type SerializedRunContextJson = RunContextJson & {
  functionApprovals?: SerializedFunctionApprovals;
  legacyFunctionApprovalFallback?: boolean;
};

/**
 * A context object that is passed to the `Runner.run()` method.
 */
export class RunContext<TContext = UnknownContext> {
  /**
   * The context object you passed to the `Runner.run()` method.
   */
  context: TContext;

  /**
   * The usage of the agent run so far. For streamed responses, the usage will be updated in real-time
   */
  usage: Usage;

  /**
   * Structured input for the current agent tool run, when available.
   */
  toolInput?: unknown;

  /**
   * A map of tool names to whether they have been approved.
   */
  #approvals: Map<string, ApprovalRecord>;

  /**
   * Function-tool approvals scoped to the public agent that owns the call.
   */
  #functionApprovalState: FunctionApprovalState;

  constructor(context: TContext = {} as TContext) {
    this.context = context;
    this.usage = new Usage();
    this.#approvals = new Map();
    this.#functionApprovalState = {
      approvalsByAgent: new Map(),
      legacyFallback: false,
    };
  }

  /**
   * Creates a child context instance for forked runs.
   * Subclasses should override this to preserve custom instance state safely.
   * @internal
   */
  protected _createFork(): RunContext<TContext> {
    return new RunContext(this.context);
  }

  /**
   * Copies shared runtime state into a child context.
   * @internal
   */
  protected _cloneSharedState<TTarget extends RunContext<TContext>>(
    target: TTarget,
  ): TTarget {
    target.context = this.context;
    target.usage = this.usage;
    target.#approvals = this.#approvals;
    target.#functionApprovalState = this.#functionApprovalState;
    return target;
  }

  /**
   * Rebuild the approvals map from a serialized state.
   * @internal
   *
   * @param approvals - The approvals map to rebuild.
   */
  _rebuildApprovals(approvals: Record<string, ApprovalRecord>) {
    this.#approvals = new Map();
    for (const [toolName, approval] of Object.entries(approvals)) {
      this.#setApprovalRecord(toolName, approval);
    }
  }

  /**
   * Merge approvals from a serialized state without discarding existing entries.
   * @internal
   *
   * @param approvals - The approvals map to merge.
   */
  _mergeApprovals(approvals: Record<string, ApprovalRecord>) {
    for (const [toolName, incoming] of Object.entries(approvals)) {
      this.#setApprovalRecord(toolName, incoming);
    }
  }

  /**
   * Rebuild owner-scoped function approvals from serialized RunState data.
   * @internal
   */
  _rebuildFunctionApprovals(
    approvals: SerializedFunctionApprovals,
    agentsByIdentity: ReadonlyMap<string, Agent<any, any>>,
  ): void {
    this.#functionApprovalState.approvalsByAgent = new Map();
    this._mergeFunctionApprovals(approvals, agentsByIdentity);
  }

  /**
   * Merge owner-scoped function approvals from serialized RunState data.
   * @internal
   */
  _mergeFunctionApprovals(
    approvals: SerializedFunctionApprovals,
    agentsByIdentity: ReadonlyMap<string, Agent<any, any>>,
  ): void {
    this._validateFunctionApprovalOwners(approvals, agentsByIdentity);
    for (const { agentIdentity, approvals: approvalsByTool } of approvals) {
      const agent = agentsByIdentity.get(agentIdentity)!;
      for (const [toolName, incoming] of Object.entries(approvalsByTool)) {
        this.#setFunctionApprovalRecord(agent, toolName, incoming);
      }
    }
  }

  /**
   * Validate serialized function-approval owners without mutating this context.
   * @internal
   */
  _validateFunctionApprovalOwners(
    approvals: SerializedFunctionApprovals,
    agentsByIdentity: ReadonlyMap<string, Agent<any, any>>,
  ): void {
    const seenAgentIdentities = new Set<string>();
    for (const { agentIdentity } of approvals) {
      if (
        seenAgentIdentities.has(agentIdentity) ||
        !agentsByIdentity.has(agentIdentity)
      ) {
        throw new UserError(
          'RunState contains invalid function approval ownership for the current agent graph.',
        );
      }
      seenAgentIdentities.add(agentIdentity);
    }
  }

  /**
   * Merge all approval state from another live context.
   * @internal
   */
  _mergeApprovalState(source: RunContext<TContext>): void {
    for (const [toolName, incoming] of source.#approvals) {
      this.#setApprovalRecord(toolName, incoming);
    }
    for (const [agent, approvalsByTool] of source.#functionApprovalState
      .approvalsByAgent) {
      for (const [toolName, incoming] of approvalsByTool) {
        this.#setFunctionApprovalRecord(agent, toolName, incoming);
      }
    }
    this.#functionApprovalState.legacyFallback ||=
      source.#functionApprovalState.legacyFallback;
  }

  /**
   * Allow released unscoped approval records to remain authoritative while
   * resuming RunState schema versions that predate owner-scoped approvals.
   * @internal
   */
  _enableLegacyFunctionApprovalFallback(): void {
    this.#functionApprovalState.legacyFallback = true;
  }

  /**
   * Merges canonicalized legacy approvals without replacing existing exact
   * non-function records that use the same legacy name.
   * @internal
   */
  _mergeApprovalsPreservingExactKeys(
    approvals: Record<string, ApprovalRecord>,
    exactToolNames: ReadonlySet<string>,
  ) {
    for (const [toolName, incoming] of Object.entries(approvals)) {
      if (exactToolNames.has(toolName) && this.#approvals.has(toolName)) {
        continue;
      }
      this.#setApprovalRecord(toolName, incoming);
    }
  }

  /**
   * Moves a legacy function-tool approval to an exact category-aware key.
   * @internal
   */
  _migrateToolApproval(
    legacyToolName: string,
    canonicalToolName: string,
    callIds: readonly string[],
    migratePermanentDecision: boolean,
  ): void {
    if (legacyToolName === canonicalToolName) {
      return;
    }
    const legacy = this.#approvals.get(legacyToolName);
    if (!legacy) {
      return;
    }

    const callIdSet = new Set(callIds);
    const movedApproved =
      legacy.approved === true
        ? migratePermanentDecision
          ? true
          : [...callIdSet]
        : Array.isArray(legacy.approved)
          ? legacy.approved.filter((callId) => callIdSet.has(callId))
          : [];
    const movedRejected =
      legacy.rejected === true
        ? migratePermanentDecision
          ? true
          : [...callIdSet]
        : Array.isArray(legacy.rejected)
          ? legacy.rejected.filter((callId) => callIdSet.has(callId))
          : [];
    let movedMessages = legacy.messages
      ? Object.fromEntries(
          Object.entries(legacy.messages).filter(([callId]) =>
            callIdSet.has(callId),
          ),
        )
      : undefined;
    if (
      legacy.rejected === true &&
      !migratePermanentDecision &&
      legacy.stickyRejectMessage !== undefined
    ) {
      for (const callId of callIdSet) {
        (movedMessages ??= {})[callId] ??= legacy.stickyRejectMessage;
      }
    }
    const moved: ApprovalRecord = {
      approved: movedApproved,
      rejected: movedRejected,
      ...(movedMessages && Object.keys(movedMessages).length > 0
        ? { messages: movedMessages }
        : {}),
      ...(migratePermanentDecision && legacy.stickyRejectMessage !== undefined
        ? { stickyRejectMessage: legacy.stickyRejectMessage }
        : {}),
    };
    const hasMovedDecision =
      moved.approved === true ||
      moved.rejected === true ||
      (Array.isArray(moved.approved) && moved.approved.length > 0) ||
      (Array.isArray(moved.rejected) && moved.rejected.length > 0);
    if (!hasMovedDecision) {
      return;
    }
    this.#setApprovalRecord(canonicalToolName, moved);

    const remainingApproved =
      legacy.approved === true
        ? migratePermanentDecision
          ? []
          : true
        : Array.isArray(legacy.approved)
          ? legacy.approved.filter((callId) => !callIdSet.has(callId))
          : [];
    const remainingRejected =
      legacy.rejected === true
        ? migratePermanentDecision
          ? []
          : true
        : Array.isArray(legacy.rejected)
          ? legacy.rejected.filter((callId) => !callIdSet.has(callId))
          : [];
    const remainingMessages = legacy.messages
      ? Object.fromEntries(
          Object.entries(legacy.messages).filter(
            ([callId]) => !callIdSet.has(callId),
          ),
        )
      : undefined;
    const remaining: ApprovalRecord = {
      approved: remainingApproved,
      rejected: remainingRejected,
      ...(remainingMessages && Object.keys(remainingMessages).length > 0
        ? { messages: remainingMessages }
        : {}),
      ...(!migratePermanentDecision && legacy.stickyRejectMessage !== undefined
        ? { stickyRejectMessage: legacy.stickyRejectMessage }
        : {}),
    };
    const hasRemainingDecision =
      remaining.approved === true ||
      remaining.rejected === true ||
      (Array.isArray(remaining.approved) && remaining.approved.length > 0) ||
      (Array.isArray(remaining.rejected) && remaining.rejected.length > 0);
    if (hasRemainingDecision) {
      this.#approvals.set(legacyToolName, remaining);
    } else {
      this.#approvals.delete(legacyToolName);
    }
  }

  /**
   * Retrieve the caller-provided rejection message for a specific tool call.
   *
   * @param toolName - The name of the tool.
   * @param callId - The call ID of the tool invocation.
   * @returns The message string if one was provided, `undefined` otherwise.
   */
  getRejectionMessage(
    toolName: string,
    callId: string,
    options: { functionTool?: boolean } = {},
  ): string | undefined {
    const functionTool = options.functionTool ?? true;
    return this.#getRejectionMessageFromEntries(
      [
        ...this.#getApprovalEntries(toolName, functionTool),
        ...this.#getFunctionApprovalEntries(toolName, functionTool),
      ],
      callId,
    );
  }

  /**
   * Retrieve a rejection message for the agent that owns a function call.
   * @internal
   */
  _getFunctionRejectionMessage(
    toolName: string,
    callId: string,
    agent: Agent<any, any>,
  ): string | undefined {
    const scopedEntries = this.#getFunctionApprovalEntries(
      toolName,
      false,
      agent,
    );
    const scopedDecision = this.#resolveApprovalEntries(scopedEntries, callId);
    const scopedMessage = this.#getRejectionMessageFromEntries(
      scopedEntries,
      callId,
    );
    if (scopedMessage !== undefined) {
      return scopedMessage;
    }
    if (
      scopedDecision === undefined &&
      this.#functionApprovalState.legacyFallback
    ) {
      return this.#getRejectionMessageFromEntries(
        this.#getApprovalEntries(toolName, false),
        callId,
      );
    }
    return undefined;
  }

  /**
   * Serialize public RunContext state using the released aggregate shape.
   */
  toJSON(): RunContextJson {
    return this.#serialize();
  }

  /**
   * Serialize RunContext state with stable function-approval ownership.
   * @internal
   */
  _toJSONForRunState(
    agentIdentityKeys: ReadonlyMap<Agent<any, any>, string>,
  ): SerializedRunContextJson {
    return this.#serialize(agentIdentityKeys);
  }

  #serialize(
    agentIdentityKeys?: ReadonlyMap<Agent<any, any>, string>,
  ): SerializedRunContextJson {
    const approvals = new Map(this.#approvals);
    if (!agentIdentityKeys) {
      for (const approvalsByTool of this.#functionApprovalState.approvalsByAgent.values()) {
        for (const [toolName, incoming] of approvalsByTool) {
          const current = approvals.get(toolName);
          approvals.set(
            toolName,
            current ? mergeApprovalRecords(current, incoming) : incoming,
          );
        }
      }
    }
    const json: SerializedRunContextJson = {
      context: this.context,
      usage: this.usage,
      approvals: Object.fromEntries(approvals.entries()),
    };
    if (agentIdentityKeys) {
      const functionApprovals: SerializedFunctionApprovals = [];
      for (const [agent, approvalsByTool] of this.#functionApprovalState
        .approvalsByAgent) {
        const agentIdentity = agentIdentityKeys.get(agent);
        if (!agentIdentity) {
          // Nested agent runs share their parent's context. Only persist
          // approvals owned by agents reachable from this RunState graph.
          continue;
        }
        functionApprovals.push({
          agentIdentity,
          approvals: Object.fromEntries(approvalsByTool),
        });
      }
      if (functionApprovals.length > 0) {
        json.functionApprovals = functionApprovals;
      }
      if (this.#functionApprovalState.legacyFallback) {
        json.legacyFunctionApprovalFallback = true;
      }
    }
    if (typeof this.toolInput !== 'undefined') {
      json.toolInput = this.toolInput;
    }
    return json;
  }

  #getCallId(approvalItem: RunToolApprovalItem): string {
    if ('callId' in approvalItem.rawItem) {
      return approvalItem.rawItem.callId;
    }

    const providerData = approvalItem.rawItem.providerData as
      { itemId?: string; id?: string } | undefined;
    return (
      approvalItem.rawItem.id ?? providerData?.itemId ?? providerData?.id ?? ''
    );
  }

  /**
   * Check if a tool call has been approved.
   *
   * @param approval - Details about the tool call being evaluated.
   * @returns `true` if the tool call has been approved, `false` if blocked and `undefined` if not yet approved or rejected.
   */
  isToolApproved(approval: {
    toolName: string;
    callId: string;
    /** @internal Whether legacy function-tool aliases should be considered. */
    functionTool?: boolean;
    /** @internal Public agent that owns a function-tool approval. */
    agent?: Agent<any, any>;
  }) {
    const { toolName, callId, functionTool = true, agent } = approval;
    if (agent) {
      const scopedDecision = this.#resolveApprovalEntries(
        this.#getFunctionApprovalEntries(toolName, functionTool, agent),
        callId,
      );
      if (scopedDecision !== undefined) {
        return scopedDecision;
      }
      if (!this.#functionApprovalState.legacyFallback) {
        return undefined;
      }
    }

    return this.#resolveApprovalEntries(
      [
        ...this.#getApprovalEntries(toolName, functionTool),
        ...(!agent
          ? this.#getFunctionApprovalEntries(toolName, functionTool)
          : []),
      ],
      callId,
    );
  }

  #resolveApprovalEntries(
    approvalEntries: readonly ApprovalRecord[],
    callId: string,
  ): boolean | undefined {
    const hasPermanentApproval = approvalEntries.some(
      (approvalEntry) => approvalEntry.approved === true,
    );
    const hasPermanentRejection = approvalEntries.some(
      (approvalEntry) => approvalEntry.rejected === true,
    );

    if (hasPermanentApproval && hasPermanentRejection) {
      logger.warn(
        'Tool is permanently approved and rejected at the same time. Approval takes precedence',
      );
      return true;
    }

    if (hasPermanentApproval) {
      return true;
    }

    if (hasPermanentRejection) {
      return false;
    }

    const individualCallApproval = approvalEntries.some((approvalEntry) =>
      Array.isArray(approvalEntry.approved)
        ? approvalEntry.approved.includes(callId)
        : false,
    );
    const individualCallRejection = approvalEntries.some((approvalEntry) =>
      Array.isArray(approvalEntry.rejected)
        ? approvalEntry.rejected.includes(callId)
        : false,
    );

    if (individualCallApproval && individualCallRejection) {
      logger.warn(
        `Tool call ${callId} is both approved and rejected at the same time. Approval takes precedence`,
      );
      return true;
    }

    if (individualCallApproval) {
      return true;
    }

    if (individualCallRejection) {
      return false;
    }

    return undefined;
  }

  #getRejectionMessageFromEntries(
    approvalEntries: readonly ApprovalRecord[],
    callId: string,
  ): string | undefined {
    for (const approvalEntry of approvalEntries) {
      if (typeof approvalEntry.messages?.[callId] === 'string') {
        return approvalEntry.messages[callId];
      }
    }
    for (const approvalEntry of approvalEntries) {
      if (approvalEntry.rejected === true) {
        return approvalEntry.stickyRejectMessage;
      }
    }
    return undefined;
  }

  /**
   * Approve a tool call.
   *
   * @param approvalItem - The tool approval item to approve.
   * @param options - Additional approval behavior options.
   */
  approveTool(
    approvalItem: RunToolApprovalItem,
    { alwaysApprove = false }: { alwaysApprove?: boolean } = {},
  ) {
    const toolName = this.#getApprovalItemToolName(approvalItem);
    const approvals =
      approvalItem.rawItem.type === 'function_call'
        ? this.#getFunctionApprovalMap(approvalItem.agent)
        : this.#approvals;
    const approvalKey = this.#getApprovalStorageKey(
      toolName,
      approvalItem.rawItem.type === 'function_call',
      approvals,
    );
    if (alwaysApprove) {
      approvals.set(approvalKey, {
        approved: true,
        rejected: [],
      });
      return;
    }

    const approvalEntry = approvals.get(approvalKey) ?? {
      approved: [],
      rejected: [],
    };
    if (Array.isArray(approvalEntry.approved)) {
      approvalEntry.approved.push(this.#getCallId(approvalItem));
    }
    approvals.set(approvalKey, approvalEntry);
  }

  /**
   * Reject a tool call.
   *
   * @param approvalItem - The tool approval item to reject.
   */
  rejectTool(
    approvalItem: RunToolApprovalItem,
    {
      alwaysReject = false,
      message,
    }: { alwaysReject?: boolean; message?: string } = {},
  ) {
    const toolName = this.#getApprovalItemToolName(approvalItem);
    const approvals =
      approvalItem.rawItem.type === 'function_call'
        ? this.#getFunctionApprovalMap(approvalItem.agent)
        : this.#approvals;
    const approvalKey = this.#getApprovalStorageKey(
      toolName,
      approvalItem.rawItem.type === 'function_call',
      approvals,
    );
    if (alwaysReject) {
      const callId = this.#getCallId(approvalItem);
      approvals.set(approvalKey, {
        approved: false,
        rejected: true,
        ...(message !== undefined
          ? {
              messages: { [callId]: message },
              stickyRejectMessage: message,
            }
          : {}),
      });
      return;
    }

    const approvalEntry = approvals.get(approvalKey) ?? {
      approved: [] as string[],
      rejected: [] as string[],
    };

    if (Array.isArray(approvalEntry.rejected)) {
      const callId = this.#getCallId(approvalItem);
      approvalEntry.rejected.push(callId);
      if (message !== undefined) {
        approvalEntry.messages = approvalEntry.messages ?? {};
        approvalEntry.messages[callId] = message;
      }
    }
    approvals.set(approvalKey, approvalEntry);
  }

  /**
   * Creates a child context that shares approvals and usage, with tool input set.
   * @internal
   */
  _forkWithToolInput(toolInput: unknown): RunContext<TContext> {
    const fork = this._cloneSharedState(this._createFork());
    fork.toolInput = toolInput;
    return fork;
  }

  /**
   * Creates a child context that shares approvals and usage, without tool input.
   * @internal
   */
  _forkWithoutToolInput(): RunContext<TContext> {
    const fork = this._cloneSharedState(this._createFork());
    fork.toolInput = undefined;
    return fork;
  }

  #getApprovalEntries(
    toolName: string,
    includeFunctionAliases: boolean,
  ): ApprovalRecord[] {
    return getApprovalToolNameCandidates(toolName, includeFunctionAliases)
      .map((candidate) => this.#approvals.get(candidate))
      .filter((approval): approval is ApprovalRecord => approval !== undefined);
  }

  #getFunctionApprovalEntries(
    toolName: string,
    includeFunctionAliases: boolean,
    agent?: Agent<any, any>,
  ): ApprovalRecord[] {
    const candidates = getApprovalToolNameCandidates(
      toolName,
      includeFunctionAliases,
    );
    const approvalMaps = agent
      ? [this.#functionApprovalState.approvalsByAgent.get(agent)]
      : [...this.#functionApprovalState.approvalsByAgent.values()];
    return approvalMaps.flatMap((approvalsByTool) =>
      approvalsByTool
        ? candidates
            .map((candidate) => approvalsByTool.get(candidate))
            .filter(
              (approval): approval is ApprovalRecord => approval !== undefined,
            )
        : [],
    );
  }

  #getFunctionApprovalMap(agent: Agent<any, any>): Map<string, ApprovalRecord> {
    const existing = this.#functionApprovalState.approvalsByAgent.get(agent);
    if (existing) {
      return existing;
    }
    const approvals = new Map<string, ApprovalRecord>();
    this.#functionApprovalState.approvalsByAgent.set(agent, approvals);
    return approvals;
  }

  #getApprovalItemToolName(approvalItem: RunToolApprovalItem): string {
    const fallbackName =
      approvalItem.toolName ?? (approvalItem.rawItem as any).name;
    if (approvalItem.rawItem.type !== 'function_call') {
      return fallbackName;
    }
    return (
      approvalItem.functionToolStateKey ??
      getFunctionToolStateKeyForCall(approvalItem.rawItem, fallbackName) ??
      fallbackName
    );
  }

  #getApprovalStorageKey(
    toolName: string,
    includeFunctionAliases: boolean,
    approvals: ReadonlyMap<string, ApprovalRecord> = this.#approvals,
  ): string {
    return (
      getApprovalToolNameCandidates(toolName, includeFunctionAliases).find(
        (candidate) => approvals.has(candidate),
      ) ?? toolName
    );
  }

  #setFunctionApprovalRecord(
    agent: Agent<any, any>,
    toolName: string,
    incoming: ApprovalRecord,
  ): void {
    const approvalsByTool = this.#getFunctionApprovalMap(agent);
    const current = approvalsByTool.get(toolName);
    approvalsByTool.set(
      toolName,
      current ? mergeApprovalRecords(current, incoming) : incoming,
    );
  }

  #setApprovalRecord(toolName: string, incoming: ApprovalRecord): void {
    const candidates = getApprovalToolNameCandidates(toolName, false);
    const existingEntries = candidates
      .map((candidate) => this.#approvals.get(candidate))
      .filter((approval): approval is ApprovalRecord => approval !== undefined);
    const mergedExisting = existingEntries.reduce<ApprovalRecord | undefined>(
      (current, approval) =>
        current ? mergeApprovalRecords(current, approval) : approval,
      undefined,
    );
    const merged = mergedExisting
      ? mergeApprovalRecords(mergedExisting, incoming)
      : incoming;
    const targetKey =
      candidates.find((candidate) => this.#approvals.has(candidate)) ??
      toolName;

    this.#approvals.set(targetKey, merged);
    for (const candidate of candidates) {
      if (candidate !== targetKey) {
        this.#approvals.delete(candidate);
      }
    }
  }
}
