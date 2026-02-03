import type { Agent } from './agent';
import type { RunResult, StreamedRunResult } from './result';
import type * as protocol from './types/protocol';

type AnyAgentRunResult =
  | RunResult<any, Agent<any, any>>
  | StreamedRunResult<any, Agent<any, any>>;

// Per-process, ephemeral map linking a function tool call to its nested
// agent run result within the same run; entry is removed after consumption.
const agentToolRunResults = new WeakMap<
  protocol.FunctionCallItem,
  AnyAgentRunResult
>();

export function saveAgentToolRunResult(
  toolCall: protocol.FunctionCallItem | undefined,
  runResult: AnyAgentRunResult,
): void {
  if (toolCall) {
    agentToolRunResults.set(toolCall, runResult);
  }
}

export function consumeAgentToolRunResult(
  toolCall: protocol.FunctionCallItem,
): AnyAgentRunResult | undefined {
  const runResult = agentToolRunResults.get(toolCall);
  if (runResult) {
    agentToolRunResults.delete(toolCall);
  }

  return runResult;
}
