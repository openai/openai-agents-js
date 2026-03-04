import { HandoffInputData } from '../handoff';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../items';
import { AgentInputItem } from '../types';

const TOOL_TYPES = new Set([
  'function_call',
  'function_call_result',
  'tool_search_call',
  'tool_search_output',
  'computer_call',
  'computer_call_result',
  'shell_call',
  'shell_call_output',
  'apply_patch_call',
  'apply_patch_call_output',
  'hosted_tool_call',
]);

/**
 * Filters out tool-related history and run items before a handoff.
 *
 * @param handoffInputData The collected handoff input to sanitize.
 * @returns Handoff input without tool calls, tool outputs, or tool search items.
 */
export function removeAllTools(
  handoffInputData: HandoffInputData,
): HandoffInputData {
  const { inputHistory, preHandoffItems, newItems, runContext } =
    handoffInputData;

  const filteredHistory = Array.isArray(inputHistory)
    ? removeToolTypesFromInput(inputHistory)
    : inputHistory;

  const filteredPreHandoffItems = removeToolsFromItems(preHandoffItems);
  const filteredNewItems = removeToolsFromItems(newItems);

  return {
    inputHistory: filteredHistory,
    preHandoffItems: filteredPreHandoffItems,
    newItems: filteredNewItems,
    runContext,
  };
}

function removeToolsFromItems(items: RunItem[]): RunItem[] {
  return items.filter(
    (item) =>
      !(item instanceof RunHandoffCallItem) &&
      !(item instanceof RunHandoffOutputItem) &&
      !(item instanceof RunToolSearchCallItem) &&
      !(item instanceof RunToolSearchOutputItem) &&
      !(item instanceof RunToolCallItem) &&
      !(item instanceof RunToolCallOutputItem),
  );
}

function removeToolTypesFromInput(items: AgentInputItem[]): AgentInputItem[] {
  return items.filter((item) => !TOOL_TYPES.has(item.type ?? ''));
}
