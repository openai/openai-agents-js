import {
  OutputGuardrailResult,
  defineOutputGuardrail,
  OutputGuardrail,
  OutputGuardrailDefinition,
  OutputGuardrailMetadata,
  OutputGuardrailFunctionArgs,
} from '@chollier/agents-core';

export interface RealtimeOutputGuardrailSettings {
  /**
   * The number of characters in the text transcript to trigger the next guardrail execution.
   * Executes every `debounceTextLength` characters.
   * Defaults to 100.
   * Set to -1 if you want to only run the guardrail when the entire transcript is available.
   *
   * @default 100
   */
  debounceTextLength: number;
}

export function getRealtimeGuardrailSettings(
  settings: Partial<RealtimeOutputGuardrailSettings>,
): RealtimeOutputGuardrailSettings {
  return {
    debounceTextLength: settings.debounceTextLength ?? 100,
  };
}

export interface RealtimeOutputGuardrail extends OutputGuardrail {
  /**
   * This will be passed to the model to inform it about why the guardrail was triggered and to
   * correct the behavior. If it's not specified the name of your guardrail will be passed instead.
   */
  policyHint?: string;
}

export interface RealtimeGuardrailMetadata extends OutputGuardrailMetadata {
  policyHint?: string;
}

export interface RealtimeOutputGuardrailDefinition
  extends OutputGuardrailDefinition<RealtimeGuardrailMetadata>,
    RealtimeGuardrailMetadata {
  run(
    args: OutputGuardrailFunctionArgs<unknown>,
  ): Promise<OutputGuardrailResult<RealtimeGuardrailMetadata>>;
}

export function defineRealtimeOutputGuardrail({
  policyHint: policyHintInput,
  ...options
}: RealtimeOutputGuardrail): RealtimeOutputGuardrailDefinition {
  const baseGuardrail = defineOutputGuardrail(options);
  const policyHint = policyHintInput ?? baseGuardrail.name;
  return {
    ...baseGuardrail,
    policyHint,
    run: async (args) => {
      const result = await baseGuardrail.run(args);
      return {
        ...result,
        guardrail: { ...result.guardrail, policyHint },
      };
    },
  };
}

/**
 * Generates a message that informs the model about why the guardrail was triggered and to
 * correct the behavior.
 */
export function getRealtimeGuardrailFeedbackMessage(
  result: OutputGuardrailResult<RealtimeGuardrailMetadata>,
) {
  return `
⚠️ Your last answer was blocked. 
Failed Guardrail Reason: ${result.guardrail.policyHint}. 
Failure Details: ${JSON.stringify(result.output.outputInfo ?? {})}. 
Please respond again following policy. Apologize for not being able to answer the question (while avoiding the specific reason) and divert discussion back to an approved topic immediately and not invite more discussion.
`.trim();
}
