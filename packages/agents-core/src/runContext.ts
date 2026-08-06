import type { Agent } from './agent';
import { ModelBehaviorError, UserError } from './errors';
import { RunToolApprovalItem } from './items';
import logger from './logger';
import {
  getFunctionToolLookupKey,
  getFunctionToolLegacyStateKeyFromStateKey,
  getFunctionToolStateKeyForCall,
  getHostedMcpApprovalRequestIdentity,
  getHostedMcpApprovalIdentityFromStateKey,
  getHostedMcpApprovalStateKey,
} from './toolIdentity';
import { UnknownContext } from './types';
import { Usage } from './usage';
import {
  getToolInvocationCallId,
  getToolInvocationFingerprint,
  type ApprovalCapableToolCall,
} from './toolInvocation';

type ApprovalRecord = {
  approved: boolean | string[];
  rejected: boolean | string[];
  messages?: Record<string, string>;
  stickyRejectMessage?: string;
};

function cloneApprovalRecord(record: ApprovalRecord): ApprovalRecord {
  return {
    approved: Array.isArray(record.approved)
      ? [...record.approved]
      : record.approved,
    rejected: Array.isArray(record.rejected)
      ? [...record.rejected]
      : record.rejected,
    ...(record.messages ? { messages: { ...record.messages } } : {}),
    ...(record.stickyRejectMessage !== undefined
      ? { stickyRejectMessage: record.stickyRejectMessage }
      : {}),
  };
}

function cloneApprovalMap(
  records: ReadonlyMap<string, ApprovalRecord>,
): Map<string, ApprovalRecord> {
  return new Map(
    [...records].map(([toolName, record]) => [
      toolName,
      cloneApprovalRecord(record),
    ]),
  );
}

function cloneAgentApprovalMap(
  records: ReadonlyMap<Agent<any, any>, ReadonlyMap<string, ApprovalRecord>>,
): Map<Agent<any, any>, Map<string, ApprovalRecord>> {
  return new Map(
    [...records].map(([agent, approvals]) => [
      agent,
      cloneApprovalMap(approvals),
    ]),
  );
}

type SerializedFunctionApprovals = Array<{
  agentIdentity: string;
  approvals: Record<string, ApprovalRecord>;
}>;

type SerializedApprovalInvocations = Array<{
  agentIdentity: string;
  invocations: Record<string, string>;
  approvals: Record<string, ApprovalRecord>;
}>;

type FunctionApprovalState = {
  approvalsByAgent: Map<Agent<any, any>, Map<string, ApprovalRecord>>;
  legacyApprovals: Map<string, ApprovalRecord>;
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
  hostedMcpApprovals?: Record<string, ApprovalRecord>;
  functionApprovals?: SerializedFunctionApprovals;
  legacyFunctionApprovals?: Record<string, ApprovalRecord>;
  approvalInvocations?: SerializedApprovalInvocations;
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
   * Hosted MCP approvals scoped by server label and tool name.
   */
  #hostedMcpApprovals: Map<string, ApprovalRecord>;

  /**
   * Function-tool approvals scoped to the public agent that owns the call.
   */
  #functionApprovalState: FunctionApprovalState;

  /**
   * Canonical invocation fingerprints for per-call approval decisions.
   */
  #approvalInvocations: Map<Agent<any, any>, Map<string, string>>;

  /**
   * Non-function per-call decisions scoped to the public agent that owns them.
   */
  #toolApprovalsByAgent: Map<Agent<any, any>, Map<string, ApprovalRecord>>;

  constructor(context: TContext = {} as TContext) {
    this.context = context;
    this.usage = new Usage();
    this.#approvals = new Map();
    this.#hostedMcpApprovals = new Map();
    this.#functionApprovalState = {
      approvalsByAgent: new Map(),
      legacyApprovals: new Map(),
    };
    this.#approvalInvocations = new Map();
    this.#toolApprovalsByAgent = new Map();
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
    target.#hostedMcpApprovals = this.#hostedMcpApprovals;
    target.#functionApprovalState = this.#functionApprovalState;
    target.#approvalInvocations = this.#approvalInvocations;
    target.#toolApprovalsByAgent = this.#toolApprovalsByAgent;
    return target;
  }

  /**
   * Creates an isolated context copy for transactional RunState restoration.
   * @internal
   */
  _cloneForRunStateDeserialization(): RunContext<TContext> {
    const clone = this._createFork();
    clone.context = this.context;
    clone.usage = this.usage;
    clone.toolInput = this.toolInput;
    clone.#approvals = cloneApprovalMap(this.#approvals);
    clone.#hostedMcpApprovals = cloneApprovalMap(this.#hostedMcpApprovals);
    clone.#functionApprovalState = {
      approvalsByAgent: cloneAgentApprovalMap(
        this.#functionApprovalState.approvalsByAgent,
      ),
      legacyApprovals: cloneApprovalMap(
        this.#functionApprovalState.legacyApprovals,
      ),
    };
    clone.#approvalInvocations = new Map(
      [...this.#approvalInvocations].map(([agent, invocations]) => [
        agent,
        new Map(invocations),
      ]),
    );
    clone.#toolApprovalsByAgent = cloneAgentApprovalMap(
      this.#toolApprovalsByAgent,
    );
    return clone;
  }

  /**
   * Replaces approval state after a transactional RunState restoration passes.
   * @internal
   */
  _replaceApprovalState(source: RunContext<TContext>): void {
    this.#approvals.clear();
    for (const [toolName, approval] of source.#approvals) {
      this.#approvals.set(toolName, cloneApprovalRecord(approval));
    }
    this.#hostedMcpApprovals.clear();
    for (const [stateKey, approval] of source.#hostedMcpApprovals) {
      this.#hostedMcpApprovals.set(stateKey, cloneApprovalRecord(approval));
    }
    this.#functionApprovalState.approvalsByAgent.clear();
    for (const [agent, approvals] of source.#functionApprovalState
      .approvalsByAgent) {
      this.#functionApprovalState.approvalsByAgent.set(
        agent,
        cloneApprovalMap(approvals),
      );
    }
    this.#functionApprovalState.legacyApprovals.clear();
    for (const [toolName, approval] of source.#functionApprovalState
      .legacyApprovals) {
      this.#functionApprovalState.legacyApprovals.set(
        toolName,
        cloneApprovalRecord(approval),
      );
    }
    this.#approvalInvocations.clear();
    for (const [agent, invocations] of source.#approvalInvocations) {
      this.#approvalInvocations.set(agent, new Map(invocations));
    }
    this.#toolApprovalsByAgent.clear();
    for (const [agent, approvals] of source.#toolApprovalsByAgent) {
      this.#toolApprovalsByAgent.set(agent, cloneApprovalMap(approvals));
    }
  }

  /**
   * Rebuild per-call approval bindings from serialized RunState data.
   * @internal
   */
  _rebuildApprovalInvocations(
    invocations: SerializedApprovalInvocations,
    agentsByIdentity: ReadonlyMap<string, Agent<any, any>>,
  ): void {
    this.#approvalInvocations = new Map();
    this.#toolApprovalsByAgent = new Map();
    this._mergeApprovalInvocations(invocations, agentsByIdentity);
  }

  /**
   * Merge serialized per-call approval bindings into a live context.
   * @internal
   */
  _mergeApprovalInvocations(
    invocations: SerializedApprovalInvocations,
    agentsByIdentity: ReadonlyMap<string, Agent<any, any>>,
  ): void {
    this._validateApprovalInvocations(invocations, agentsByIdentity);
    for (const {
      agentIdentity,
      invocations: byCallId,
      approvals,
    } of invocations) {
      const agent = agentsByIdentity.get(agentIdentity)!;
      this.#mergeAgentApprovalInvocations(
        agent,
        new Map(Object.entries(byCallId)),
      );
      for (const [toolName, incoming] of Object.entries(approvals)) {
        this.#setToolApprovalRecord(agent, toolName, incoming);
      }
    }
  }

  /**
   * Validate serialized approval-invocation ownership and conflicts without
   * mutating this context.
   * @internal
   */
  _validateApprovalInvocations(
    invocations: SerializedApprovalInvocations,
    agentsByIdentity: ReadonlyMap<string, Agent<any, any>>,
  ): void {
    const seenAgentIdentities = new Set<string>();
    for (const { agentIdentity, invocations: byCallId } of invocations) {
      if (
        !agentsByIdentity.has(agentIdentity) ||
        seenAgentIdentities.has(agentIdentity)
      ) {
        throw new UserError(
          'RunState contains invalid approval invocation ownership for the current agent graph.',
        );
      }
      seenAgentIdentities.add(agentIdentity);
      const agent = agentsByIdentity.get(agentIdentity)!;
      for (const [callId, fingerprint] of Object.entries(byCallId)) {
        this._validateAgentApprovalInvocation(agent, callId, fingerprint);
      }
    }
  }

  /**
   * Bind a legacy per-call decision to its serialized approval item.
   * @internal
   */
  _bindLegacyApprovalInvocation(approvalItem: RunToolApprovalItem): void {
    const callId = getToolInvocationCallId(approvalItem.rawItem);
    const agentInvocations = this.#getApprovalInvocations(approvalItem.agent);
    if (!callId || agentInvocations.has(callId)) {
      return;
    }
    const toolName = this.#getApprovalItemToolName(approvalItem);
    const decision = this.isToolApproved({
      toolName,
      callId,
      functionTool: false,
      ...(approvalItem.rawItem.type === 'function_call'
        ? { agent: approvalItem.agent }
        : {}),
    });
    if (decision !== undefined) {
      agentInvocations.set(
        callId,
        getToolInvocationFingerprint(toolName, approvalItem.rawItem),
      );
      if (approvalItem.rawItem.type !== 'function_call') {
        this.#copyPerCallToolApproval(approvalItem.agent, toolName, callId);
      }
    }
  }

  /**
   * Fail closed when an agent-local call ID with a per-call decision is reused.
   * @internal
   */
  _validateAgentApprovalInvocation(
    agent: Agent<any, any>,
    callId: string,
    fingerprint: string,
  ): void {
    const approvedFingerprint = this.#approvalInvocations
      .get(agent)
      ?.get(callId);
    if (
      approvedFingerprint !== undefined &&
      approvedFingerprint !== fingerprint
    ) {
      throw new ModelBehaviorError(
        `Tool call ID ${callId} was reused for a different invocation after an approval decision.`,
      );
    }
  }

  /**
   * Validate a canonical tool invocation before approval lookup or execution.
   * @internal
   */
  _validateToolInvocation(
    agent: Agent<any, any>,
    toolName: string,
    rawItem: ApprovalCapableToolCall,
  ): { callId: string; fingerprint: string } {
    const callId = getToolInvocationCallId(rawItem);
    if (!callId) {
      throw new ModelBehaviorError(
        'Tool invocation is missing a non-empty call ID.',
      );
    }
    const fingerprint = getToolInvocationFingerprint(toolName, rawItem);
    this._validateAgentApprovalInvocation(agent, callId, fingerprint);
    return { callId, fingerprint };
  }

  /**
   * Resolve a decision only when its per-call binding belongs to this agent.
   * Sticky tool-wide decisions remain shared.
   * @internal
   */
  _resolveToolInvocationApproval(
    agent: Agent<any, any>,
    toolName: string,
    rawItem: ApprovalCapableToolCall,
  ): boolean | undefined {
    const { callId, fingerprint } = this._validateToolInvocation(
      agent,
      toolName,
      rawItem,
    );
    if (rawItem.type === 'function_call') {
      const scopedEntries = this.#getFunctionApprovalEntries(
        toolName,
        false,
        agent,
      );
      const stickyDecision = this.#resolveStickyApprovalEntries(scopedEntries);
      if (stickyDecision !== undefined) {
        return stickyDecision;
      }
      const legacyEntries = this.#getLegacyFunctionApprovalEntries(toolName);
      const legacyStickyDecision =
        this.#resolveStickyApprovalEntries(legacyEntries);
      if (legacyStickyDecision !== undefined) {
        return legacyStickyDecision;
      }
      if (this.#approvalInvocations.get(agent)?.get(callId) === fingerprint) {
        return (
          this.#resolveApprovalEntries(scopedEntries, callId) ??
          this.#resolveApprovalEntries(legacyEntries, callId)
        );
      }
      return undefined;
    }
    const entries = this.#getToolApprovalEntries(toolName, agent);
    if (this.#approvalInvocations.get(agent)?.get(callId) === fingerprint) {
      const scopedDecision = this.#resolveApprovalEntries(entries, callId);
      if (scopedDecision !== undefined) {
        return scopedDecision;
      }
    }
    const stickyEntries = getHostedMcpApprovalRequestIdentity(rawItem)
      ? this.#getHostedMcpApprovalEntries(toolName)
      : this.#getApprovalEntries(toolName, false);
    return this.#resolveStickyApprovalEntries(stickyEntries);
  }

  /**
   * Resolve a rejection message only from the owning per-call binding or a
   * sticky tool-wide rejection.
   * @internal
   */
  _getToolInvocationRejectionMessage(
    agent: Agent<any, any>,
    toolName: string,
    rawItem: ApprovalCapableToolCall,
  ): string | undefined {
    const { callId, fingerprint } = this._validateToolInvocation(
      agent,
      toolName,
      rawItem,
    );
    if (rawItem.type === 'function_call') {
      const scopedEntries = this.#getFunctionApprovalEntries(
        toolName,
        false,
        agent,
      );
      const stickyMessage = scopedEntries.find(
        (entry) => entry.rejected === true,
      )?.stickyRejectMessage;
      if (stickyMessage !== undefined) {
        return stickyMessage;
      }
      const legacyEntries = this.#getLegacyFunctionApprovalEntries(toolName);
      const legacyStickyMessage = legacyEntries.find(
        (entry) => entry.rejected === true,
      )?.stickyRejectMessage;
      if (legacyStickyMessage !== undefined) {
        return legacyStickyMessage;
      }
      if (this.#approvalInvocations.get(agent)?.get(callId) === fingerprint) {
        return (
          this.#getRejectionMessageFromEntries(scopedEntries, callId) ??
          this.#getRejectionMessageFromEntries(legacyEntries, callId)
        );
      }
      return undefined;
    }
    const entries = this.#getToolApprovalEntries(toolName, agent);
    if (this.#approvalInvocations.get(agent)?.get(callId) === fingerprint) {
      const scopedMessage = this.#getRejectionMessageFromEntries(
        entries,
        callId,
      );
      if (scopedMessage !== undefined) {
        return scopedMessage;
      }
    }
    const stickyEntries = getHostedMcpApprovalRequestIdentity(rawItem)
      ? this.#getHostedMcpApprovalEntries(toolName)
      : this.#getApprovalEntries(toolName, false);
    return stickyEntries.find((entry) => entry.rejected === true)
      ?.stickyRejectMessage;
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

  /** @internal */
  _rebuildHostedMcpApprovals(approvals: Record<string, ApprovalRecord>) {
    this.#hostedMcpApprovals = new Map();
    this._mergeHostedMcpApprovals(approvals);
  }

  /** @internal */
  _mergeHostedMcpApprovals(approvals: Record<string, ApprovalRecord>) {
    for (const [stateKey, incoming] of Object.entries(approvals)) {
      if (!getHostedMcpApprovalIdentityFromStateKey(stateKey)) {
        continue;
      }
      const current = this.#hostedMcpApprovals.get(stateKey);
      this.#hostedMcpApprovals.set(
        stateKey,
        current ? mergeApprovalRecords(current, incoming) : incoming,
      );
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
   * Rebuild legacy function-only approvals from serialized RunState data.
   * @internal
   */
  _rebuildLegacyFunctionApprovals(
    approvals: Record<string, ApprovalRecord>,
  ): void {
    this.#functionApprovalState.legacyApprovals = new Map();
    this._mergeLegacyFunctionApprovals(approvals);
  }

  /**
   * Merge legacy function-only approvals from serialized RunState data.
   * @internal
   */
  _mergeLegacyFunctionApprovals(
    approvals: Record<string, ApprovalRecord>,
  ): void {
    for (const [toolName, incoming] of Object.entries(approvals)) {
      this.#setLegacyFunctionApprovalRecord(toolName, incoming);
    }
  }

  /**
   * Retain only legacy approvals proven to belong to enabled function tools.
   * @internal
   */
  _retainLegacyFunctionApprovals(toolNames: ReadonlySet<string>): void {
    for (const toolName of this.#functionApprovalState.legacyApprovals.keys()) {
      if (!toolNames.has(toolName)) {
        this.#functionApprovalState.legacyApprovals.delete(toolName);
      }
    }
  }

  /**
   * Remove migrated function-only keys from the non-function aggregate map.
   * @internal
   */
  _removeMigratedFunctionApprovalsFromAggregate(
    functionToolNames: ReadonlySet<string>,
    exactNonFunctionToolNames: ReadonlySet<string>,
  ): void {
    for (const toolName of functionToolNames) {
      if (!exactNonFunctionToolNames.has(toolName)) {
        this.#approvals.delete(toolName);
      }
    }
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
    this.#mergeLiveApprovalInvocations(source.#approvalInvocations);
    this.#mergeLiveToolApprovals(source.#toolApprovalsByAgent);
    for (const [toolName, incoming] of source.#approvals) {
      this.#setApprovalRecord(toolName, incoming);
    }
    for (const [stateKey, incoming] of source.#hostedMcpApprovals) {
      this._mergeHostedMcpApprovals({ [stateKey]: incoming });
    }
    for (const [agent, approvalsByTool] of source.#functionApprovalState
      .approvalsByAgent) {
      for (const [toolName, incoming] of approvalsByTool) {
        this.#setFunctionApprovalRecord(agent, toolName, incoming);
      }
    }
    for (const [toolName, incoming] of source.#functionApprovalState
      .legacyApprovals) {
      this.#setLegacyFunctionApprovalRecord(toolName, incoming);
    }
  }

  /**
   * Merges canonicalized legacy approvals without replacing existing exact
   * non-function records that use the same legacy name.
   * @internal
   */
  _mergeApprovalStatePreservingExactKeys(
    source: RunContext<TContext>,
    exactToolNames: ReadonlySet<string>,
  ): void {
    this.#mergeLiveApprovalInvocations(source.#approvalInvocations);
    this.#mergeLiveToolApprovals(source.#toolApprovalsByAgent);
    for (const [toolName, incoming] of source.#approvals) {
      if (exactToolNames.has(toolName) && this.#approvals.has(toolName)) {
        continue;
      }
      this.#setApprovalRecord(toolName, incoming);
    }
    for (const [stateKey, incoming] of source.#hostedMcpApprovals) {
      this._mergeHostedMcpApprovals({ [stateKey]: incoming });
    }
    for (const [agent, approvalsByTool] of source.#functionApprovalState
      .approvalsByAgent) {
      for (const [toolName, incoming] of approvalsByTool) {
        this.#setFunctionApprovalRecord(agent, toolName, incoming);
      }
    }
    for (const [toolName, incoming] of source.#functionApprovalState
      .legacyApprovals) {
      this.#setLegacyFunctionApprovalRecord(toolName, incoming);
    }
  }

  /**
   * Moves a legacy function-tool approval to an exact category-aware key.
   * @internal
   */
  _migrateToolApproval(
    agent: Agent<any, any>,
    legacyToolName: string,
    canonicalToolName: string,
    callIds: readonly string[],
    migratePermanentDecision: boolean,
    preserveMovedCallDecisions = false,
  ): void {
    if (legacyToolName === canonicalToolName) {
      return;
    }
    const legacy =
      this.#functionApprovalState.legacyApprovals.get(legacyToolName);
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
    this.#setFunctionApprovalRecord(agent, canonicalToolName, moved);

    const remainingApproved =
      legacy.approved === true
        ? migratePermanentDecision
          ? []
          : true
        : Array.isArray(legacy.approved)
          ? legacy.approved.filter(
              (callId) => preserveMovedCallDecisions || !callIdSet.has(callId),
            )
          : [];
    const remainingRejected =
      legacy.rejected === true
        ? migratePermanentDecision
          ? []
          : true
        : Array.isArray(legacy.rejected)
          ? legacy.rejected.filter(
              (callId) => preserveMovedCallDecisions || !callIdSet.has(callId),
            )
          : [];
    const remainingMessages = legacy.messages
      ? Object.fromEntries(
          Object.entries(legacy.messages).filter(
            ([callId]) => preserveMovedCallDecisions || !callIdSet.has(callId),
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
      this.#functionApprovalState.legacyApprovals.set(
        legacyToolName,
        remaining,
      );
    } else {
      this.#functionApprovalState.legacyApprovals.delete(legacyToolName);
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
    const includeFunctionState =
      functionTool ||
      getFunctionToolLegacyStateKeyFromStateKey(toolName) !== undefined;
    return this.#getRejectionMessageFromEntries(
      [
        ...this.#getApprovalEntries(toolName, functionTool),
        ...(includeFunctionState
          ? [
              ...this.#getLegacyFunctionApprovalEntries(toolName),
              ...this.#getFunctionApprovalEntries(toolName, functionTool),
            ]
          : []),
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
      this.#functionApprovalState.legacyApprovals.size > 0
    ) {
      return this.#getRejectionMessageFromEntries(
        this.#getLegacyFunctionApprovalEntries(toolName),
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
      for (const [stateKey, incoming] of this.#hostedMcpApprovals) {
        const identity = getHostedMcpApprovalIdentityFromStateKey(stateKey);
        if (!identity?.toolName) {
          continue;
        }
        const current = approvals.get(identity.toolName);
        approvals.set(
          identity.toolName,
          current ? mergeApprovalRecords(current, incoming) : incoming,
        );
      }
      for (const [toolName, incoming] of this.#functionApprovalState
        .legacyApprovals) {
        const current = approvals.get(toolName);
        approvals.set(
          toolName,
          current ? mergeApprovalRecords(current, incoming) : incoming,
        );
      }
      for (const approvalsByTool of this.#functionApprovalState.approvalsByAgent.values()) {
        for (const [toolName, incoming] of approvalsByTool) {
          const publicToolName =
            getFunctionToolLegacyStateKeyFromStateKey(toolName) ?? toolName;
          const current = approvals.get(publicToolName);
          approvals.set(
            publicToolName,
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
    if (agentIdentityKeys && this.#hostedMcpApprovals.size > 0) {
      json.hostedMcpApprovals = Object.fromEntries(this.#hostedMcpApprovals);
    }
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
      if (this.#functionApprovalState.legacyApprovals.size > 0) {
        json.legacyFunctionApprovals = Object.fromEntries(
          this.#functionApprovalState.legacyApprovals,
        );
      }
      const approvalInvocations: SerializedApprovalInvocations = [];
      const approvalAgents = new Set([
        ...this.#approvalInvocations.keys(),
        ...this.#toolApprovalsByAgent.keys(),
      ]);
      for (const agent of approvalAgents) {
        const invocations = this.#approvalInvocations.get(agent) ?? new Map();
        const approvalsByTool =
          this.#toolApprovalsByAgent.get(agent) ?? new Map();
        const agentIdentity = agentIdentityKeys.get(agent);
        if (
          agentIdentity &&
          (invocations.size > 0 || approvalsByTool.size > 0)
        ) {
          approvalInvocations.push({
            agentIdentity,
            invocations: Object.fromEntries(invocations),
            approvals: Object.fromEntries(approvalsByTool),
          });
        }
      }
      json.approvalInvocations = approvalInvocations;
    }
    if (typeof this.toolInput !== 'undefined') {
      json.toolInput = this.toolInput;
    }
    return json;
  }

  #getCallId(approvalItem: RunToolApprovalItem): string {
    const hostedIdentity = getHostedMcpApprovalRequestIdentity(approvalItem);
    if (hostedIdentity?.requestId) {
      return hostedIdentity.requestId;
    }
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
      if (this.#functionApprovalState.legacyApprovals.size === 0) {
        return undefined;
      }
      return this.#resolveApprovalEntries(
        this.#getLegacyFunctionApprovalEntries(toolName),
        callId,
      );
    }

    const includeFunctionState =
      functionTool ||
      getFunctionToolLegacyStateKeyFromStateKey(toolName) !== undefined;
    return this.#resolveApprovalEntries(
      [
        ...this.#getApprovalEntries(toolName, functionTool),
        ...(includeFunctionState
          ? this.#getLegacyFunctionApprovalEntries(toolName)
          : []),
        ...(!agent && includeFunctionState
          ? this.#getFunctionApprovalEntries(toolName, functionTool)
          : []),
      ],
      callId,
    );
  }

  /** @internal */
  _getHostedMcpApprovalStatus(
    approvalItem: RunToolApprovalItem['rawItem'] | RunToolApprovalItem,
  ): boolean | undefined {
    const identity = getHostedMcpApprovalRequestIdentity(approvalItem);
    const stateKey = identity
      ? getHostedMcpApprovalStateKey(identity)
      : undefined;
    if (!identity?.requestId || !stateKey) {
      return undefined;
    }
    return this.#resolveApprovalEntries(
      this.#getHostedMcpApprovalEntries(stateKey),
      identity.requestId,
    );
  }

  /** @internal */
  _getHostedMcpRejectionMessage(
    approvalItem: RunToolApprovalItem['rawItem'] | RunToolApprovalItem,
  ): string | undefined {
    const identity = getHostedMcpApprovalRequestIdentity(approvalItem);
    const stateKey = identity
      ? getHostedMcpApprovalStateKey(identity)
      : undefined;
    if (!identity?.requestId || !stateKey) {
      return undefined;
    }
    return this.#getRejectionMessageFromEntries(
      this.#getHostedMcpApprovalEntries(stateKey),
      identity.requestId,
    );
  }

  #resolveApprovalEntries(
    approvalEntries: readonly ApprovalRecord[],
    callId: string,
  ): boolean | undefined {
    const stickyDecision = this.#resolveStickyApprovalEntries(approvalEntries);
    if (stickyDecision !== undefined) {
      return stickyDecision;
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

  #resolveStickyApprovalEntries(
    approvalEntries: readonly ApprovalRecord[],
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
    const toolName = this.#getApprovalItemStorageKey(
      approvalItem,
      alwaysApprove,
    );
    const isFunctionCall = approvalItem.rawItem.type === 'function_call';
    const approvals = isFunctionCall
      ? this.#getFunctionApprovalMap(approvalItem.agent)
      : getHostedMcpApprovalRequestIdentity(approvalItem)
        ? this.#hostedMcpApprovals
        : this.#approvals;
    const approvalKey = this.#getApprovalStorageKey(
      toolName,
      isFunctionCall,
      approvals,
    );
    const callId = this.#getCallId(approvalItem);
    this.#bindApprovalInvocation(toolName, approvalItem);
    if (alwaysApprove) {
      approvals.set(approvalKey, {
        approved: true,
        rejected: [],
      });
      return;
    }

    this.#recordPerCallApproval(approvals, approvalKey, callId, true);
    if (!isFunctionCall) {
      const scopedApprovals = this.#getToolApprovalMap(approvalItem.agent);
      const scopedKey = this.#getApprovalStorageKey(
        toolName,
        false,
        scopedApprovals,
      );
      this.#recordPerCallApproval(scopedApprovals, scopedKey, callId, true);
    }
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
    const toolName = this.#getApprovalItemStorageKey(
      approvalItem,
      alwaysReject,
    );
    const isFunctionCall = approvalItem.rawItem.type === 'function_call';
    const approvals = isFunctionCall
      ? this.#getFunctionApprovalMap(approvalItem.agent)
      : getHostedMcpApprovalRequestIdentity(approvalItem)
        ? this.#hostedMcpApprovals
        : this.#approvals;
    const approvalKey = this.#getApprovalStorageKey(
      toolName,
      isFunctionCall,
      approvals,
    );
    const callId = this.#getCallId(approvalItem);
    this.#bindApprovalInvocation(toolName, approvalItem);
    if (alwaysReject) {
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

    this.#recordPerCallApproval(approvals, approvalKey, callId, false, message);
    if (!isFunctionCall) {
      const scopedApprovals = this.#getToolApprovalMap(approvalItem.agent);
      const scopedKey = this.#getApprovalStorageKey(
        toolName,
        false,
        scopedApprovals,
      );
      this.#recordPerCallApproval(
        scopedApprovals,
        scopedKey,
        callId,
        false,
        message,
      );
    }
  }

  #recordPerCallApproval(
    approvals: Map<string, ApprovalRecord>,
    approvalKey: string,
    callId: string,
    approved: boolean,
    message?: string,
  ): void {
    const approvalEntry = approvals.get(approvalKey) ?? {
      approved: [] as string[],
      rejected: [] as string[],
    };
    const decisions = approved
      ? approvalEntry.approved
      : approvalEntry.rejected;
    if (Array.isArray(decisions) && !decisions.includes(callId)) {
      decisions.push(callId);
    }
    if (!approved && message !== undefined) {
      approvalEntry.messages = approvalEntry.messages ?? {};
      approvalEntry.messages[callId] = message;
    }
    approvals.set(approvalKey, approvalEntry);
  }

  #bindApprovalInvocation(
    toolName: string,
    approvalItem: RunToolApprovalItem,
  ): void {
    const { callId, fingerprint } = this._validateToolInvocation(
      approvalItem.agent,
      toolName,
      approvalItem.rawItem,
    );
    this.#getApprovalInvocations(approvalItem.agent).set(callId, fingerprint);
  }

  #getApprovalInvocations(agent: Agent<any, any>): Map<string, string> {
    const existing = this.#approvalInvocations.get(agent);
    if (existing) {
      return existing;
    }
    const invocations = new Map<string, string>();
    this.#approvalInvocations.set(agent, invocations);
    return invocations;
  }

  #mergeAgentApprovalInvocations(
    agent: Agent<any, any>,
    incoming: ReadonlyMap<string, string>,
  ): void {
    for (const [callId, fingerprint] of incoming) {
      this._validateAgentApprovalInvocation(agent, callId, fingerprint);
      this.#getApprovalInvocations(agent).set(callId, fingerprint);
    }
  }

  #mergeLiveApprovalInvocations(
    incoming: ReadonlyMap<Agent<any, any>, ReadonlyMap<string, string>>,
  ): void {
    for (const [agent, invocations] of incoming) {
      this.#mergeAgentApprovalInvocations(agent, invocations);
    }
  }

  #mergeLiveToolApprovals(
    incoming: ReadonlyMap<Agent<any, any>, ReadonlyMap<string, ApprovalRecord>>,
  ): void {
    for (const [agent, approvalsByTool] of incoming) {
      for (const [toolName, approval] of approvalsByTool) {
        this.#setToolApprovalRecord(agent, toolName, approval);
      }
    }
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

  #getToolApprovalEntries(
    toolName: string,
    agent: Agent<any, any>,
  ): ApprovalRecord[] {
    const approvalsByTool = this.#toolApprovalsByAgent.get(agent);
    if (!approvalsByTool) {
      return [];
    }
    return getApprovalToolNameCandidates(toolName, false)
      .map((candidate) => approvalsByTool.get(candidate))
      .filter((approval): approval is ApprovalRecord => approval !== undefined);
  }

  #getHostedMcpApprovalEntries(stateKey: string): ApprovalRecord[] {
    const approval = this.#hostedMcpApprovals.get(stateKey);
    return approval ? [approval] : [];
  }

  #getToolApprovalMap(agent: Agent<any, any>): Map<string, ApprovalRecord> {
    const existing = this.#toolApprovalsByAgent.get(agent);
    if (existing) {
      return existing;
    }
    const approvals = new Map<string, ApprovalRecord>();
    this.#toolApprovalsByAgent.set(agent, approvals);
    return approvals;
  }

  #copyPerCallToolApproval(
    agent: Agent<any, any>,
    toolName: string,
    callId: string,
  ): void {
    const sourceEntries = this.#getApprovalEntries(toolName, false);
    const approved = sourceEntries.some(
      (entry) =>
        Array.isArray(entry.approved) && entry.approved.includes(callId),
    );
    const rejected = sourceEntries.some(
      (entry) =>
        Array.isArray(entry.rejected) && entry.rejected.includes(callId),
    );
    if (!approved && !rejected) {
      return;
    }
    const approvals = this.#getToolApprovalMap(agent);
    const approvalKey = this.#getApprovalStorageKey(toolName, false, approvals);
    if (approved) {
      this.#recordPerCallApproval(approvals, approvalKey, callId, true);
    }
    if (rejected) {
      this.#recordPerCallApproval(
        approvals,
        approvalKey,
        callId,
        false,
        this.#getRejectionMessageFromEntries(sourceEntries, callId),
      );
    }
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

  #getLegacyFunctionApprovalEntries(toolName: string): ApprovalRecord[] {
    const legacyToolName =
      getFunctionToolLegacyStateKeyFromStateKey(toolName) ?? toolName;
    return getApprovalToolNameCandidates(legacyToolName, true)
      .map((candidate) =>
        this.#functionApprovalState.legacyApprovals.get(candidate),
      )
      .filter((approval): approval is ApprovalRecord => approval !== undefined);
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

  #getApprovalItemStorageKey(
    approvalItem: RunToolApprovalItem,
    persistent: boolean,
  ): string {
    const hostedIdentity = getHostedMcpApprovalRequestIdentity(approvalItem);
    if (!hostedIdentity) {
      if (approvalItem.rawItem.type === 'hosted_tool_call' && persistent) {
        throw new UserError(
          'Persistent hosted approval decisions require valid MCP approval request provider data.',
        );
      }
      return this.#getApprovalItemToolName(approvalItem);
    }
    if (!hostedIdentity.requestId) {
      throw new UserError(
        'Hosted MCP approval decisions require a non-empty request id.',
      );
    }
    if (!hostedIdentity.serverLabel || !hostedIdentity.toolName) {
      throw new UserError(
        'Hosted MCP approval decisions require a non-empty server label and tool name.',
      );
    }
    return getHostedMcpApprovalStateKey(hostedIdentity)!;
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

  #setToolApprovalRecord(
    agent: Agent<any, any>,
    toolName: string,
    incoming: ApprovalRecord,
  ): void {
    const approvalsByTool = this.#getToolApprovalMap(agent);
    const current = approvalsByTool.get(toolName);
    approvalsByTool.set(
      toolName,
      current ? mergeApprovalRecords(current, incoming) : incoming,
    );
  }

  #setLegacyFunctionApprovalRecord(
    toolName: string,
    incoming: ApprovalRecord,
  ): void {
    const current = this.#functionApprovalState.legacyApprovals.get(toolName);
    this.#functionApprovalState.legacyApprovals.set(
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
