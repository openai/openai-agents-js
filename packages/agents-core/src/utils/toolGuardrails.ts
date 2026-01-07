import type {
  ToolGuardrailFunctionOutput,
  ToolInputGuardrailDefinition,
  ToolInputGuardrailResult,
  ToolOutputGuardrailDefinition,
  ToolOutputGuardrailResult,
} from '../toolGuardrail';
import type { Agent } from '../agent';
import type { RunContext } from '../runContext';
import type * as protocol from '../types/protocol';
import {
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from '../errors';

function normalizeBehavior(
  output: ToolGuardrailFunctionOutput,
): ToolGuardrailFunctionOutput['behavior'] {
  return output.behavior ?? { type: 'allow' };
}

export async function runToolInputGuardrails<
  TContext,
  TAgent extends Agent<any, any>,
>({
  guardrails,
  context,
  agent,
  toolCall,
  onResult,
}: {
  guardrails?: ToolInputGuardrailDefinition<TContext>[];
  context: RunContext<TContext>;
  agent: TAgent;
  toolCall: protocol.FunctionCallItem;
  onResult?: (result: ToolInputGuardrailResult) => void;
}): Promise<{ type: 'allow' } | { type: 'reject'; message: string }> {
  const list = guardrails ?? [];
  for (const guardrail of list) {
    const output = await guardrail.run({
      context,
      agent,
      toolCall,
    });
    const behavior = normalizeBehavior(output);
    const result: ToolInputGuardrailResult = {
      guardrail: { type: 'tool_input', name: guardrail.name },
      output: { ...output, behavior },
    };
    onResult?.(result);
    if (behavior.type === 'rejectContent') {
      return { type: 'reject', message: behavior.message };
    }
    if (behavior.type === 'throwException') {
      throw new ToolInputGuardrailTripwireTriggered(
        `Tool input guardrail triggered: ${guardrail.name}`,
        result,
      );
    }
  }
  return { type: 'allow' };
}

export async function runToolOutputGuardrails<
  TContext,
  TAgent extends Agent<any, any>,
>({
  guardrails,
  context,
  agent,
  toolCall,
  toolOutput,
  onResult,
}: {
  guardrails?: ToolOutputGuardrailDefinition<TContext>[];
  context: RunContext<TContext>;
  agent: TAgent;
  toolCall: protocol.FunctionCallItem;
  toolOutput: unknown;
  onResult?: (result: ToolOutputGuardrailResult) => void;
}): Promise<unknown> {
  const list = guardrails ?? [];
  let finalOutput = toolOutput;
  for (const guardrail of list) {
    const output = await guardrail.run({
      context,
      agent,
      toolCall,
      output: toolOutput,
    });
    const behavior = normalizeBehavior(output);
    const result: ToolOutputGuardrailResult = {
      guardrail: { type: 'tool_output', name: guardrail.name },
      output: { ...output, behavior },
    };
    onResult?.(result);
    if (behavior.type === 'rejectContent') {
      finalOutput = behavior.message;
      break;
    }
    if (behavior.type === 'throwException') {
      throw new ToolOutputGuardrailTripwireTriggered(
        `Tool output guardrail triggered: ${guardrail.name}`,
        result,
      );
    }
  }
  return finalOutput;
}
