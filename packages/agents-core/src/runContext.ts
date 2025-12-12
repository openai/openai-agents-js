import { RunToolApprovalItem } from './items';
import logger from './logger';
import { UnknownContext } from './types';
import { Usage } from './usage';

type ApprovalRecord = {
  approved: boolean | string[];
  rejected: boolean | string[];
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
   * A map of tool names to whether they have been approved.
   */
  #approvals: Map<string, ApprovalRecord>;

  constructor(context: TContext = {} as TContext) {
    this.context = context;
    this.usage = new Usage();
    this.#approvals = new Map();
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
      // function tool has call_id, hosted tool call has id
      const callId =
        'callId' in approvalItem.rawItem
          ? approvalItem.rawItem.callId // function tools
          : approvalItem.rawItem.id!; // hosted tools
      approvalEntry.approved.push(callId);
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
    { alwaysReject = false }: { alwaysReject?: boolean } = {},
  ) {
    const toolName =
      approvalItem.toolName ?? (approvalItem.rawItem as any).name;
    if (alwaysReject) {
      this.#approvals.set(toolName, {
        approved: false,
        rejected: true,
      });
      return;
    }

    const approvalEntry = this.#approvals.get(toolName) ?? {
      approved: [] as string[],
      rejected: [] as string[],
    };

    if (Array.isArray(approvalEntry.rejected)) {
      // function tool has call_id, hosted tool call has id
      const callId =
        'callId' in approvalItem.rawItem
          ? approvalItem.rawItem.callId // function tools
          : approvalItem.rawItem.id!; // hosted tools
      approvalEntry.rejected.push(callId);
    }
    this.#approvals.set(toolName, approvalEntry);
  }

  toJSON(): {
    context: any;
    usage: Usage;
    approvals: Record<string, ApprovalRecord>;
  } {
    return {
      context: this.context,
      usage: this.usage,
      approvals: Object.fromEntries(this.#approvals.entries()),
    };
  }
}
