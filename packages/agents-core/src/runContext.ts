import { RunToolApprovalItem } from './items';
import logger from './logger';
import { UnknownContext } from './types';
import { Usage } from './usage';

type ApprovalRecord = {
  approved: boolean | string[];
  rejected: boolean | string[];
  messages?: Record<string, string>;
  stickyRejectMessage?: string;
};

const COMPUTER_APPROVAL_TOOL_NAMES = new Set([
  'computer',
  'computer_use_preview',
]);

function getApprovalToolNameCandidates(toolName: string): string[] {
  if (!COMPUTER_APPROVAL_TOOL_NAMES.has(toolName)) {
    return [toolName];
  }

  return toolName === 'computer'
    ? ['computer', 'computer_use_preview']
    : ['computer_use_preview', 'computer'];
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

  constructor(context: TContext = {} as TContext) {
    this.context = context;
    this.usage = new Usage();
    this.#approvals = new Map();
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
   * Retrieve the caller-provided rejection message for a specific tool call.
   *
   * @param toolName - The name of the tool.
   * @param callId - The call ID of the tool invocation.
   * @returns The message string if one was provided, `undefined` otherwise.
   */
  getRejectionMessage(toolName: string, callId: string): string | undefined {
    for (const approvalEntry of this.#getApprovalEntries(toolName)) {
      if (typeof approvalEntry.messages?.[callId] === 'string') {
        return approvalEntry.messages[callId];
      }
    }

    for (const approvalEntry of this.#getApprovalEntries(toolName)) {
      if (approvalEntry.rejected === true) {
        return approvalEntry.stickyRejectMessage;
      }
    }

    return undefined;
  }

  #getCallId(approvalItem: RunToolApprovalItem): string {
    if ('callId' in approvalItem.rawItem) {
      return approvalItem.rawItem.callId;
    }

    const providerData = approvalItem.rawItem.providerData as
      | { itemId?: string; id?: string }
      | undefined;
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
  isToolApproved(approval: { toolName: string; callId: string }) {
    const { toolName, callId } = approval;
    const approvalEntries = this.#getApprovalEntries(toolName);
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
    const toolName =
      approvalItem.toolName ?? (approvalItem.rawItem as any).name;
    const approvalKey = this.#getApprovalStorageKey(toolName);
    if (alwaysApprove) {
      this.#approvals.set(approvalKey, {
        approved: true,
        rejected: [],
      });
      return;
    }

    const approvalEntry = this.#approvals.get(approvalKey) ?? {
      approved: [],
      rejected: [],
    };
    if (Array.isArray(approvalEntry.approved)) {
      approvalEntry.approved.push(this.#getCallId(approvalItem));
    }
    this.#approvals.set(approvalKey, approvalEntry);
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
    const toolName =
      approvalItem.toolName ?? (approvalItem.rawItem as any).name;
    const approvalKey = this.#getApprovalStorageKey(toolName);
    if (alwaysReject) {
      const callId = this.#getCallId(approvalItem);
      this.#approvals.set(approvalKey, {
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

    const approvalEntry = this.#approvals.get(approvalKey) ?? {
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
    this.#approvals.set(approvalKey, approvalEntry);
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

  toJSON(): RunContextJson {
    const json: RunContextJson = {
      context: this.context,
      usage: this.usage,
      approvals: Object.fromEntries(this.#approvals.entries()),
    };
    if (typeof this.toolInput !== 'undefined') {
      json.toolInput = this.toolInput;
    }
    return json;
  }

  #getApprovalEntries(toolName: string): ApprovalRecord[] {
    return getApprovalToolNameCandidates(toolName)
      .map((candidate) => this.#approvals.get(candidate))
      .filter((approval): approval is ApprovalRecord => approval !== undefined);
  }

  #getApprovalStorageKey(toolName: string): string {
    return (
      getApprovalToolNameCandidates(toolName).find((candidate) =>
        this.#approvals.has(candidate),
      ) ?? toolName
    );
  }

  #setApprovalRecord(toolName: string, incoming: ApprovalRecord): void {
    const candidates = getApprovalToolNameCandidates(toolName);
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
