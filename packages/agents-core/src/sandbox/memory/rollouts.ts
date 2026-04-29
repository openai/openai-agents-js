import type { Agent, AgentOutputType } from '../../agent';
import {
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  OutputGuardrailTripwireTriggered,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '../../errors';
import type { RunToolApprovalItem } from '../../items';
import type { RunState } from '../../runState';
import type { AgentInputItem } from '../../types';
import {
  extractOutputItemsFromRunItems,
  toAgentInputList,
} from '../../runner/items';
import { stableJsonPrettyStringify } from '../shared/stableJson';

const EXCLUDED_MEMORY_ITEM_TYPES = new Set([
  'compaction',
  'image_generation_call',
  'reasoning',
]);

const INCLUDED_MEMORY_ITEM_TYPES = new Set([
  'apply_patch_call',
  'apply_patch_call_output',
  'computer_call',
  'computer_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'function_call',
  'function_call_output',
  'function_call_result',
  'hosted_tool_call',
  'local_shell_call',
  'local_shell_call_output',
  'mcp_approval_request',
  'mcp_approval_response',
  'mcp_call',
  'shell_call',
  'shell_call_output',
  'tool_search_call',
  'tool_search_output',
  'web_search_call',
]);

export type SandboxMemoryTerminalMetadata = {
  terminal_state:
    | 'completed'
    | 'interrupted'
    | 'cancelled'
    | 'failed'
    | 'max_turns_exceeded'
    | 'guardrail_tripped';
  exception_type: string | null;
  exception_message: string | null;
  has_final_output: boolean;
};

export type SandboxMemoryRolloutPayload = {
  updated_at: string;
  rollout_id: string;
  input: unknown;
  generated_items: unknown;
  interruptions?: unknown;
  terminal_metadata: SandboxMemoryTerminalMetadata;
  final_output?: unknown;
};

export type MemoryRolloutIdentity = {
  conversationId?: string;
  sdkSessionId?: string;
  groupId?: string;
  fallbackId: string;
};

export function resolveMemoryRolloutId(
  identity: MemoryRolloutIdentity,
): string {
  return validateRolloutId(
    identity.conversationId ??
      identity.sdkSessionId ??
      identity.groupId ??
      identity.fallbackId,
  );
}

export function buildMemoryRolloutPayload<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
  args: {
    rolloutId: string;
    exception?: unknown;
    inputOverride?: string | AgentInputItem[];
  },
): SandboxMemoryRolloutPayload {
  const finalOutput = finalOutputForMemory(state);
  const interruptions = interruptionsForMemory(state).map((item) =>
    sanitizeForMemoryJson(item.rawItem),
  );
  const payload: SandboxMemoryRolloutPayload = {
    updated_at: utcIsoTimestamp(),
    rollout_id: args.rolloutId,
    input: sanitizeForMemoryJson(
      sanitizeMemoryItems(
        toAgentInputList(args.inputOverride ?? state._originalInput),
      ),
    ),
    generated_items: sanitizeForMemoryJson(
      sanitizeMemoryItems(
        extractOutputItemsFromRunItems(
          state._generatedItems,
          state._reasoningItemIdPolicy,
        ),
      ),
    ),
    terminal_metadata: terminalMetadataForMemory(
      state,
      args.exception,
      finalOutput,
    ),
  };
  if (interruptions.length > 0) {
    payload.interruptions = interruptions;
  }
  if (finalOutput !== null) {
    payload.final_output = sanitizeForMemoryJson(finalOutput);
  }
  return payload;
}

export function validateRolloutId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(
      "Sandbox memory rollout ID must be a file-safe ID containing only letters, numbers, '.', '_', or '-'.",
    );
  }
  return normalized;
}

export function normalizeRolloutSlug(value: string): string {
  const slug = value.trim().endsWith('.md')
    ? value.trim().slice(0, -3)
    : value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug)) {
    throw new Error(`Invalid rollout_slug: ${value}`);
  }
  return slug;
}

export function renderPhaseOnePrompt(rolloutContents: string): string {
  const payloads = rolloutContents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
  if (payloads.length === 0) {
    throw new Error('rollout_contents must contain at least one JSONL record');
  }
  const lastPayload = payloads[payloads.length - 1];
  const terminalMetadata =
    payloads.length === 1
      ? (lastPayload.terminal_metadata ?? {})
      : {
          segment_count: payloads.length,
          final_terminal_metadata: lastPayload.terminal_metadata ?? {},
          terminal_states: payloads.map((payload) => {
            const terminal = payload.terminal_metadata;
            return terminal && typeof terminal === 'object'
              ? ((terminal as Record<string, unknown>).terminal_state ??
                  'unknown')
              : 'unknown';
          }),
        };
  return stringifySortedJson(terminalMetadata);
}

function sanitizeMemoryItems(items: AgentInputItem[]): AgentInputItem[] {
  return items.filter((item) => shouldIncludeMemoryItem(item));
}

function shouldIncludeMemoryItem(item: AgentInputItem): boolean {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const role = (item as { role?: unknown }).role;
  if (role === 'developer' || role === 'system') {
    return false;
  }
  if (role === 'assistant' || role === 'tool' || role === 'user') {
    return true;
  }
  const type = (item as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return false;
  }
  if (EXCLUDED_MEMORY_ITEM_TYPES.has(type)) {
    return false;
  }
  return INCLUDED_MEMORY_ITEM_TYPES.has(type);
}

function finalOutputForMemory<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): unknown {
  if (state._currentStep?.type !== 'next_step_final_output') {
    return null;
  }
  return state._currentStep.output;
}

function interruptionsForMemory<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): RunToolApprovalItem[] {
  return state.getInterruptions();
}

function terminalMetadataForMemory<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
  exception: unknown,
  finalOutput: unknown,
): SandboxMemoryTerminalMetadata {
  if (finalOutput !== null) {
    return {
      terminal_state: 'completed',
      exception_type: null,
      exception_message: null,
      has_final_output: true,
    };
  }
  if (state._currentStep?.type === 'next_step_interruption') {
    return {
      terminal_state: 'interrupted',
      exception_type: null,
      exception_message: null,
      has_final_output: false,
    };
  }
  if (exception !== undefined) {
    return terminalMetadataForException(exception);
  }
  return {
    terminal_state: 'failed',
    exception_type: null,
    exception_message: null,
    has_final_output: false,
  };
}

function terminalMetadataForException(
  exception: unknown,
): SandboxMemoryTerminalMetadata {
  const exceptionType = exceptionName(exception);
  let terminalState: SandboxMemoryTerminalMetadata['terminal_state'] = 'failed';
  if (exception instanceof MaxTurnsExceededError) {
    terminalState = 'max_turns_exceeded';
  } else if (
    exception instanceof InputGuardrailTripwireTriggered ||
    exception instanceof OutputGuardrailTripwireTriggered ||
    exception instanceof ToolInputGuardrailTripwireTriggered ||
    exception instanceof ToolOutputGuardrailTripwireTriggered ||
    exceptionType.includes('Guardrail')
  ) {
    terminalState = 'guardrail_tripped';
  } else if (
    exceptionType === 'AbortError' ||
    exceptionType === 'CancelledError'
  ) {
    terminalState = 'cancelled';
  }
  return {
    terminal_state: terminalState,
    exception_type: exceptionType,
    exception_message: exceptionMessage(exception),
    has_final_output: false,
  };
}

function exceptionName(exception: unknown): string {
  if (exception instanceof Error && exception.name) {
    return exception.name;
  }
  if (
    exception &&
    typeof exception === 'object' &&
    typeof (exception as { name?: unknown }).name === 'string'
  ) {
    return (exception as { name: string }).name;
  }
  return 'Error';
}

function exceptionMessage(exception: unknown): string | null {
  if (exception instanceof Error) {
    return exception.message || null;
  }
  const message = String(exception);
  return message ? message : null;
}

function stringifySortedJson(value: unknown): string {
  return stableJsonPrettyStringify(value, {
    encodeBytes: (entry) => Object.fromEntries(Object.entries(entry)),
  });
}

function utcIsoTimestamp(): string {
  return new Date().toISOString().replace(/Z$/, '+00:00');
}

function sanitizeForMemoryJson(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value, (_key, childValue) => {
      if (childValue instanceof Uint8Array) {
        return {
          type: 'Uint8Array',
          byteLength: childValue.byteLength,
        };
      }
      return childValue;
    });
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return String(value);
  }
}
