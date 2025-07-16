import { HandoffInputData } from '../handoff';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../items';
import { AgentInputItem } from '../types';

const TOOL_TYPES = new Set([
  'function_call',
  'function_call_result',
  'computer_call',
  'computer_call_result',
  'hosted_tool_call',
]);

/**
 * Filters out all tool items: file search, web search and function calls+output
 * @param handoffInputData
 * @returns
 */
export function removeAllTools(
  handoffInputData: HandoffInputData,
): HandoffInputData {
  const { inputHistory, preHandoffItems, newItems } = handoffInputData;

  const filteredHistory = Array.isArray(inputHistory)
    ? removeToolTypesFromInput(inputHistory)
    : inputHistory;

  const filteredPreHandoffItems = removeToolsFromItems(preHandoffItems);
  const filteredNewItems = removeToolsFromItems(newItems);

  return {
    inputHistory: filteredHistory,
    preHandoffItems: filteredPreHandoffItems,
    newItems: filteredNewItems,
  };
}

function removeToolsFromItems(items: RunItem[]): RunItem[] {
  return items.filter(
    (item) =>
      !(item instanceof RunHandoffCallItem) &&
      !(item instanceof RunHandoffOutputItem) &&
      !(item instanceof RunToolCallItem) &&
      !(item instanceof RunToolCallOutputItem),
  );
}

function removeToolTypesFromInput(items: AgentInputItem[]): AgentInputItem[] {
  return items.filter((item) => !TOOL_TYPES.has(item.type ?? ''));
}
