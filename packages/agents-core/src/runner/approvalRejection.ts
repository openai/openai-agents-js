import logger, { getSafeErrorType } from '../logger';
import type { Agent } from '../agent';
import { RunContext } from '../runContext';
import type { ToolErrorFormatter, ToolErrorFormatterArgs } from '../run';

export const TOOL_APPROVAL_REJECTION_MESSAGE =
  'Tool execution was not approved.';

type ApprovalRejectedToolType = ToolErrorFormatterArgs['toolType'];

type ApprovalRejectionMessageOptions<TContext = unknown> = {
  runContext: RunContext<TContext>;
  toolType: ApprovalRejectedToolType;
  toolName: string;
  approvalToolNames?: readonly string[];
  approvalAgent?: Agent<any, any>;
  callId: string;
  toolErrorFormatter?: ToolErrorFormatter<TContext>;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveApprovalRejectionMessage<TContext>({
  runContext,
  toolType,
  toolName,
  approvalToolNames = [toolName],
  approvalAgent,
  callId,
  toolErrorFormatter,
}: ApprovalRejectionMessageOptions<TContext>): Promise<string> {
  // Per-call message from state.reject(item, { message }) takes precedence over
  // the global toolErrorFormatter callback and the SDK default.
  const perCallMessage = approvalToolNames
    .map((approvalToolName) =>
      approvalAgent
        ? runContext._getFunctionRejectionMessage(
            approvalToolName,
            callId,
            approvalAgent,
          )
        : runContext.getRejectionMessage(approvalToolName, callId, {
            functionTool: false,
          }),
    )
    .find((message): message is string => typeof message === 'string');
  if (typeof perCallMessage === 'string') {
    return perCallMessage;
  }

  if (!toolErrorFormatter) {
    return TOOL_APPROVAL_REJECTION_MESSAGE;
  }

  try {
    const formattedMessage = await toolErrorFormatter({
      kind: 'approval_rejected',
      toolType,
      toolName,
      callId,
      defaultMessage: TOOL_APPROVAL_REJECTION_MESSAGE,
      runContext,
    });

    if (typeof formattedMessage === 'string') {
      return formattedMessage;
    }
    if (typeof formattedMessage !== 'undefined') {
      logger.warn(
        'toolErrorFormatter returned a non-string value. Falling back to the default tool approval rejection message.',
      );
    }
  } catch (error) {
    const errorDetails = logger.dontLogToolData
      ? getSafeErrorType(error)
      : toErrorMessage(error);
    logger.warn(
      `toolErrorFormatter threw while formatting approval rejection: ${errorDetails}`,
    );
  }

  return TOOL_APPROVAL_REJECTION_MESSAGE;
}
