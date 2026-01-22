import type {
  AgentInputItem,
  ApplyPatchCallItem,
  ApplyPatchCallResultItem,
  ComputerCallResultItem,
  ComputerUseCallItem,
  FunctionCallItem,
  FunctionCallResultItem,
  HostedToolCallItem,
  ReasoningItem,
  ShellCallItem,
  ShellCallResultItem,
} from '@openai/agents-core';

export type OpenAIResponsesFallbackMode = 'repair' | 'last_resort';

export type SanitizeOpenAIResponsesInputItemsOptions = {
  store?: boolean;
  mode?: OpenAIResponsesFallbackMode;
};

type ToolOutputSummary = {
  callId: string;
  output: unknown;
};

/**
 * Sanitize Responses API input items for replay when strict ordering or missing items trigger 400s.
 * Use this to drop unstable fields, correct reasoning placement, or remove tool items as a fallback.
 *
 * Typical usage: call once with mode "repair", and retry with "last_resort" if the request still fails.
 * Pass `store: false` when replaying stateless responses so reasoning items are removed.
 *
 * Known error patterns this helps with:
 * - 400s from strict ordering: reasoning must precede tool calls and outputs.
 * - 400s from mismatched tool call/output pairs or duplicate reasoning items.
 * - 400s from non-function tool items (hosted/computer/shell/apply_patch) that are out of order.
 * - 404s on store=false replays when item IDs or reasoning references are present.
 */
export function sanitizeOpenAIResponsesInputItems(
  items: AgentInputItem[],
  options: SanitizeOpenAIResponsesInputItemsOptions = {},
): AgentInputItem[] {
  const mode = options.mode ?? 'repair';
  const store = options.store ?? true;
  // Strip IDs to avoid coupling to prior response item identity.
  const stripped = items.map(stripItemId);
  // Evaluate tool call/output pairing so we can decide whether to keep tool items.
  const analysis = analyzeToolPairs(stripped);

  if (mode === 'last_resort' || !analysis.paired) {
    // Drop tool items and reasoning, then inject a fallback user summary if available.
    const withoutTools = dropToolItems(stripped);
    const withoutReasoning = dropReasoning(withoutTools);
    return appendFallbackUserMessage(withoutReasoning, analysis.outputs);
  }

  let repaired = stripped;
  if (store === false) {
    // Stateless replay is more tolerant when reasoning items are removed.
    repaired = dropReasoning(repaired);
    return repaired;
  }

  // Keep encrypted reasoning only and move it before tool calls if ordering is off.
  repaired = minimizeReasoning(repaired);
  if (shouldMoveReasoning(repaired)) {
    repaired = moveReasoningBeforeFirstToolCall(repaired);
  }
  return repaired;
}

function stripItemId(item: AgentInputItem): AgentInputItem {
  // Remove IDs to avoid invalid references across retries.
  const clone = { ...(item as Record<string, unknown>) };
  delete (clone as { id?: string }).id;
  const providerData = (clone as { providerData?: unknown }).providerData;
  if (providerData && typeof providerData === 'object') {
    const providerClone = { ...(providerData as Record<string, unknown>) };
    delete providerClone.id;
    delete providerClone.itemId;
    delete providerClone.item_id;
    (clone as { providerData?: unknown }).providerData = providerClone;
  }
  return clone as AgentInputItem;
}

function isFunctionCall(item: AgentInputItem): item is FunctionCallItem {
  return (item as { type?: string }).type === 'function_call';
}

function isFunctionCallResult(
  item: AgentInputItem,
): item is FunctionCallResultItem {
  return (item as { type?: string }).type === 'function_call_result';
}

function isComputerCall(item: AgentInputItem): item is ComputerUseCallItem {
  return (item as { type?: string }).type === 'computer_call';
}

function isComputerCallResult(
  item: AgentInputItem,
): item is ComputerCallResultItem {
  return (item as { type?: string }).type === 'computer_call_result';
}

function isShellCall(item: AgentInputItem): item is ShellCallItem {
  return (item as { type?: string }).type === 'shell_call';
}

function isShellCallResult(item: AgentInputItem): item is ShellCallResultItem {
  return (item as { type?: string }).type === 'shell_call_output';
}

function isApplyPatchCall(item: AgentInputItem): item is ApplyPatchCallItem {
  return (item as { type?: string }).type === 'apply_patch_call';
}

function isApplyPatchCallResult(
  item: AgentInputItem,
): item is ApplyPatchCallResultItem {
  return (item as { type?: string }).type === 'apply_patch_call_output';
}

function isHostedToolCall(item: AgentInputItem): item is HostedToolCallItem {
  return (item as { type?: string }).type === 'hosted_tool_call';
}

function isToolCall(
  item: AgentInputItem,
): item is
  | FunctionCallItem
  | ComputerUseCallItem
  | ShellCallItem
  | ApplyPatchCallItem
  | HostedToolCallItem {
  return (
    isFunctionCall(item) ||
    isComputerCall(item) ||
    isShellCall(item) ||
    isApplyPatchCall(item) ||
    isHostedToolCall(item)
  );
}

function isToolOutput(
  item: AgentInputItem,
): item is
  | FunctionCallResultItem
  | ComputerCallResultItem
  | ShellCallResultItem
  | ApplyPatchCallResultItem {
  return (
    isFunctionCallResult(item) ||
    isComputerCallResult(item) ||
    isShellCallResult(item) ||
    isApplyPatchCallResult(item)
  );
}

function isCallIdToolCall(
  item: AgentInputItem,
): item is
  | FunctionCallItem
  | ComputerUseCallItem
  | ShellCallItem
  | ApplyPatchCallItem {
  return (
    isFunctionCall(item) ||
    isComputerCall(item) ||
    isShellCall(item) ||
    isApplyPatchCall(item)
  );
}

function isReasoning(item: AgentInputItem): item is ReasoningItem {
  return (item as { type?: string }).type === 'reasoning';
}

function getReasoningEncryptedContent(item: ReasoningItem): string | undefined {
  const providerData = item.providerData as
    | { encryptedContent?: unknown; encrypted_content?: unknown }
    | undefined;
  const encrypted =
    providerData?.encryptedContent ?? providerData?.encrypted_content;
  return typeof encrypted === 'string' && encrypted.length > 0
    ? encrypted
    : undefined;
}

function analyzeToolPairs(items: AgentInputItem[]) {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  const summaries: ToolOutputSummary[] = [];
  let sawToolItem = false;

  for (const item of items) {
    if (isToolCall(item)) {
      sawToolItem = true;
    }
    if (isCallIdToolCall(item)) {
      if (item.callId) {
        calls.add(item.callId);
      } else {
        calls.add('');
      }
    } else if (isToolOutput(item)) {
      sawToolItem = true;
      if (item.callId) {
        outputs.add(item.callId);
        summaries.push({ callId: item.callId, output: item.output });
      } else {
        outputs.add('');
        summaries.push({ callId: 'unknown', output: item.output });
      }
    }
  }

  // No tool activity means there is nothing to validate.
  if (!sawToolItem) {
    return { paired: true, outputs: summaries };
  }
  if (calls.size === 0 && outputs.size === 0) {
    // Tool items without call IDs (e.g., hosted_tool_call) do not require pairing.
    return { paired: true, outputs: summaries };
  }
  if (calls.size !== outputs.size) {
    return { paired: false, outputs: summaries };
  }
  for (const callId of calls) {
    if (!outputs.has(callId)) {
      return { paired: false, outputs: summaries };
    }
  }
  return { paired: true, outputs: summaries };
}

function dropToolItems(items: AgentInputItem[]): AgentInputItem[] {
  // Remove tool calls and tool results when they are inconsistent.
  return items.filter((item) => !isToolCall(item) && !isToolOutput(item));
}

function dropReasoning(items: AgentInputItem[]): AgentInputItem[] {
  // Strip reasoning to avoid strict ordering requirements in replay.
  return items.filter((item) => !isReasoning(item));
}

function minimizeReasoning(items: AgentInputItem[]): AgentInputItem[] {
  return items.map((item) => {
    if (!isReasoning(item)) {
      return item;
    }
    const encryptedContent = getReasoningEncryptedContent(item);
    if (!encryptedContent) {
      return item;
    }
    // Preserve encrypted reasoning but drop user-visible summaries.
    const { rawContent: _rawContent, ...rest } = item as ReasoningItem & {
      rawContent?: ReasoningItem['rawContent'];
    };
    return {
      ...rest,
      content: [],
    } as ReasoningItem;
  });
}

function shouldMoveReasoning(items: AgentInputItem[]): boolean {
  let sawToolItem = false;
  for (const item of items) {
    if (isToolCall(item) || isToolOutput(item)) {
      sawToolItem = true;
      continue;
    }
    if (isReasoning(item) && sawToolItem) {
      return true;
    }
  }
  return false;
}

function moveReasoningBeforeFirstToolCall(
  items: AgentInputItem[],
): AgentInputItem[] {
  // Ensure reasoning items appear immediately before tool calls for strict ordering.
  const reasoningItems = items.filter(isReasoning);
  if (reasoningItems.length === 0) {
    return items;
  }
  const remaining = items.filter((item) => !isReasoning(item));
  const index = remaining.findIndex(isToolCall);
  if (index === -1) {
    return items;
  }
  return [
    ...remaining.slice(0, index),
    ...reasoningItems,
    ...remaining.slice(index),
  ];
}

function appendFallbackUserMessage(
  items: AgentInputItem[],
  outputs: ToolOutputSummary[],
): AgentInputItem[] {
  if (outputs.length === 0) {
    return items;
  }
  // Convert tool outputs into a user message to salvage context.
  const lines = outputs.map((output) => {
    let serialized = '';
    try {
      serialized = JSON.stringify(output.output);
    } catch {
      serialized = String(output.output);
    }
    return `- ${output.callId}: ${serialized}`;
  });
  return [
    ...items,
    {
      role: 'user',
      content: `Tool outputs (fallback):\n${lines.join('\n')}`,
    },
  ];
}
