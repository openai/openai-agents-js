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
  UserError,
} from '../errors';

function normalizeBehavior(
  output: ToolGuardrailFunctionOutput,
  guardrailName: string,
): ToolGuardrailFunctionOutput['behavior'] {
  const behavior = output.behavior as unknown;
  if (behavior == null) {
    return { type: 'allow' };
  }
  if (typeof behavior !== 'object') {
    throw new UserError(
      `Tool guardrail ${guardrailName} returned an invalid behavior`,
    );
  }
  return behavior as ToolGuardrailFunctionOutput['behavior'];
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
    const behavior = normalizeBehavior(output, guardrail.name);
    const result: ToolInputGuardrailResult = {
      guardrail: { type: 'tool_input', name: guardrail.name },
      output: { ...output, behavior },
    };
    onResult?.(result);
    const firstBehaviorType = behavior.type;
    if (firstBehaviorType === 'rejectContent') {
      if (typeof behavior.message !== 'string') {
        throw new UserError(
          `Tool guardrail ${guardrail.name} returned an invalid behavior`,
        );
      }
      return { type: 'reject', message: behavior.message };
    }
    const secondBehaviorType = behavior.type;
    if (secondBehaviorType === 'throwException') {
      throw new ToolInputGuardrailTripwireTriggered(
        `Tool input guardrail triggered: ${guardrail.name}`,
        result,
      );
    }
    if (firstBehaviorType !== 'allow' || secondBehaviorType !== 'allow') {
      throw new UserError(
        `Tool guardrail ${guardrail.name} returned an invalid behavior`,
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
    const behavior = normalizeBehavior(output, guardrail.name);
    const result: ToolOutputGuardrailResult = {
      guardrail: { type: 'tool_output', name: guardrail.name },
      output: { ...output, behavior },
    };
    onResult?.(result);
    const firstBehaviorType = behavior.type;
    if (firstBehaviorType === 'rejectContent') {
      if (typeof behavior.message !== 'string') {
        throw new UserError(
          `Tool guardrail ${guardrail.name} returned an invalid behavior`,
        );
      }
      finalOutput = behavior.message;
      break;
    }
    const secondBehaviorType = behavior.type;
    if (secondBehaviorType === 'throwException') {
      throw new ToolOutputGuardrailTripwireTriggered(
        `Tool output guardrail triggered: ${guardrail.name}`,
        result,
      );
    }
    if (firstBehaviorType !== 'allow' || secondBehaviorType !== 'allow') {
      throw new UserError(
        `Tool guardrail ${guardrail.name} returned an invalid behavior`,
      );
    }
  }
  return finalOutput;
}
