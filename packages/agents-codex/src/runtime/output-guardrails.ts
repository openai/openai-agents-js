import type { Agent } from './public-agent';
import type { CompletionContext } from './model-callbacks';
import {
  captureGuardrailResult,
  GuardrailTripwire,
  type GuardrailRecord,
  type OutputGuardrail,
} from './guardrails';

/** @internal Settle captured output checks before the caller accepts a completion. */
export async function settleOutputGuardrails({
  guards,
  agent,
  request,
  guardrailResults,
  invoke,
  check,
}: {
  guards: readonly OutputGuardrail<any>[];
  agent: Agent<any, any>;
  request: Omit<CompletionContext<any, unknown>, 'decide'>;
  guardrailResults: GuardrailRecord[];
  invoke: (
    guard: OutputGuardrail<any>,
    finalOutput: unknown,
  ) => ReturnType<OutputGuardrail<any>['callback']>;
  check: () => void;
}): Promise<void> {
  const settled = await Promise.allSettled(
    guards.map(async (guard) => {
      check();
      const result = captureGuardrailResult(
        await invoke(guard, structuredClone(request.finalOutput)),
      );
      check();
      return Object.freeze({
        kind: 'output' as const,
        name: guard.name,
        result,
        agent,
        sessionId: request.sessionId,
        turnId: request.turnId,
        ...(request.subagentId ? { subagentId: request.subagentId } : {}),
        ...(request.toolCall ? { toolCall: request.toolCall } : {}),
        ...(request.toolBatchCallIds
          ? { toolBatchCallIds: request.toolBatchCallIds }
          : {}),
      });
    }),
  );
  const records = settled.flatMap((entry) =>
    entry.status === 'fulfilled' ? [entry.value] : [],
  );
  guardrailResults.push(...records);
  const failed = settled.find((entry) => entry.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  check();
  const tripped = records.find((record) => record.result.tripwireTriggered);
  if (tripped)
    throw new GuardrailTripwire(tripped, Object.freeze([...guardrailResults]));
}
