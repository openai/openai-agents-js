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
    this.#approvals = new Map(Object.entries(approvals));
  }

  /**
   * Merge approvals from a serialized state without discarding existing entries.
   * @internal
   *
   * @param approvals - The approvals map to merge.
   */
  _mergeApprovals(approvals: Record<string, ApprovalRecord>) {
    const mergeApproval = (
      current: ApprovalRecord['approved'],
      incoming: ApprovalRecord['approved'],
    ) => {
      if (current === true || incoming === true) {
        return true;
      }
      const currentList = Array.isArray(current) ? current : [];
      const incomingList = Array.isArray(incoming) ? incoming : [];
      return Array.from(new Set([...currentList, ...incomingList]));
    };

    const mergeMessages = (
      current: ApprovalRecord,
      incoming: ApprovalRecord,
    ) => {
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
    };

    const mergeStickyRejectMessage = (
      current: ApprovalRecord,
      incoming: ApprovalRecord,
    ) => {
      if (current.rejected === true) {
        return current.stickyRejectMessage;
      }
      return current.stickyRejectMessage ?? incoming.stickyRejectMessage;
    };

    for (const [toolName, incoming] of Object.entries(approvals)) {
      const existing = this.#approvals.get(toolName);
      if (!existing) {
        this.#approvals.set(toolName, incoming);
        continue;
      }
      const mergedMessages = mergeMessages(existing, incoming);
      const stickyRejectMessage = mergeStickyRejectMessage(existing, incoming);
      this.#approvals.set(toolName, {
        approved: mergeApproval(existing.approved, incoming.approved),
        rejected: mergeApproval(existing.rejected, incoming.rejected),
        ...(mergedMessages ? { messages: mergedMessages } : {}),
        ...(stickyRejectMessage !== undefined ? { stickyRejectMessage } : {}),
      });
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
    const approvalEntry = this.#approvals.get(toolName);
    return (
      approvalEntry?.messages?.[callId] ??
      (approvalEntry?.rejected === true
        ? approvalEntry.stickyRejectMessage
        : undefined)
    );
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
    const approvalEntry = this.#approvals.get(toolName);
    if (approvalEntry?.approved === true && approvalEntry.rejected === true) {
      logger.warn(
        'Tool is permanently approved and rejected at the same time. Approval takes precedence',
      );
      return true;
    }

    if (approvalEntry?.approved === true) {
      return true;
    }

    if (approvalEntry?.rejected === true) {
      return false;
    }

    const individualCallApproval = Array.isArray(approvalEntry?.approved)
      ? approvalEntry.approved.includes(callId)
      : false;
    const individualCallRejection = Array.isArray(approvalEntry?.rejected)
      ? approvalEntry.rejected.includes(callId)
      : false;

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
    if (alwaysApprove) {
      this.#approvals.set(toolName, {
        approved: true,
        rejected: [],
      });
      return;
    }

    const approvalEntry = this.#approvals.get(toolName) ?? {
      approved: [],
      rejected: [],
    };
    if (Array.isArray(approvalEntry.approved)) {
      approvalEntry.approved.push(this.#getCallId(approvalItem));
    }
    this.#approvals.set(toolName, approvalEntry);
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
    if (alwaysReject) {
      const callId = this.#getCallId(approvalItem);
      this.#approvals.set(toolName, {
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

    const approvalEntry = this.#approvals.get(toolName) ?? {
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
    this.#approvals.set(toolName, approvalEntry);
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
}
