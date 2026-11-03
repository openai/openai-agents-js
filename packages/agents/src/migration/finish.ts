import type {
  FunctionToolResult,
  RunContext,
  ToolUseBehavior,
} from '@openai/agents-core';
import { toSmartString } from '@openai/agents-core/utils';

export interface ToolFinishCandidate {
  readonly finalOutput: string;
}

/** Validate configuration without invoking application policy. */
export function captureFinishBehavior(
  behavior: ToolUseBehavior,
): ToolUseBehavior {
  if (
    behavior === 'run_llm_again' ||
    behavior === 'stop_on_first_tool' ||
    typeof behavior === 'function'
  )
    return behavior;
  if (
    behavior !== null &&
    typeof behavior === 'object' &&
    Array.isArray(behavior.stopAtToolNames)
  ) {
    const names = [...behavior.stopAtToolNames];
    if (names.every((name) => typeof name === 'string'))
      return { stopAtToolNames: names };
  }
  throw new TypeError('Migration requires a supported tool-use behavior');
}

/** The caller supplies complete, acknowledged ordinary-function results in issued order. */
export async function resolveToolFinish(
  behavior: ToolUseBehavior,
  context: RunContext,
  results: FunctionToolResult[],
  signal: AbortSignal,
): Promise<ToolFinishCandidate | undefined> {
  signal.throwIfAborted();
  if (!results.length || behavior === 'run_llm_again') return undefined;
  if (behavior === 'stop_on_first_tool') {
    const first = results[0];
    if (first?.type !== 'function_output')
      throw new TypeError('Migration requires acknowledged function output');
    return {
      finalOutput: toSmartString(first.output),
    };
  }
  if (typeof behavior === 'object' && behavior !== null) {
    const selected = results.find((result) =>
      behavior.stopAtToolNames.includes(result.tool.name),
    );
    if (!selected) return undefined;
    if (selected.type !== 'function_output')
      throw new TypeError('Migration requires acknowledged function output');
    return {
      finalOutput: toSmartString(selected.output),
    };
  }
  if (typeof behavior !== 'function')
    throw new TypeError('Migration requires a supported tool-use behavior');
  const decision = await behavior(context, results);
  signal.throwIfAborted();
  if (
    !decision ||
    typeof decision.isFinalOutput !== 'boolean' ||
    decision.isInterrupted !== undefined ||
    (decision.isFinalOutput && typeof decision.finalOutput !== 'string')
  )
    throw new TypeError(
      'Migration requires a noninterrupted final-output decision',
    );
  return decision.isFinalOutput
    ? { finalOutput: decision.finalOutput }
    : undefined;
}
