import logger from '../logger';
import { RunItemStreamEvent, RunItemStreamEventName } from '../events';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../items';
import { StreamedRunResult } from '../result';

export const isAbortError = (error: unknown): boolean => {
  if (!error) {
    return false;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const DomExceptionCtor =
    typeof DOMException !== 'undefined' ? DOMException : undefined;
  if (
    DomExceptionCtor &&
    error instanceof DomExceptionCtor &&
    error.name === 'AbortError'
  ) {
    return true;
  }
  return false;
};

function getRunItemStreamEventName(
  item: RunItem,
): RunItemStreamEventName | undefined {
  if (item instanceof RunMessageOutputItem) {
    return 'message_output_created';
  }
  if (item instanceof RunHandoffCallItem) {
    return 'handoff_requested';
  }
  if (item instanceof RunHandoffOutputItem) {
    return 'handoff_occurred';
  }
  if (item instanceof RunToolCallItem) {
    return 'tool_called';
  }
  if (item instanceof RunToolCallOutputItem) {
    return 'tool_output';
  }
  if (item instanceof RunReasoningItem) {
    return 'reasoning_item_created';
  }
  if (item instanceof RunToolApprovalItem) {
    return 'tool_approval_requested';
  }
  return undefined;
}

function enqueueRunItemStreamEvent(
  result: StreamedRunResult<any, any>,
  item: RunItem,
): void {
  const itemName = getRunItemStreamEventName(item);
  if (!itemName) {
    logger.warn('Unknown item type: ', item);
    return;
  }
  result._addItem(new RunItemStreamEvent(itemName, item));
}

export function streamStepItemsToRunResult(
  result: StreamedRunResult<any, any>,
  items: RunItem[],
): void {
  for (const item of items) {
    enqueueRunItemStreamEvent(result, item);
  }
}

export function addStepToRunResult(
  result: StreamedRunResult<any, any>,
  step: { newStepItems: RunItem[] },
  options?: { skipItems?: Set<RunItem> },
): void {
  const skippedItems = options?.skipItems;
  for (const item of step.newStepItems) {
    if (skippedItems?.has(item)) {
      continue;
    }
    enqueueRunItemStreamEvent(result, item);
  }
}
