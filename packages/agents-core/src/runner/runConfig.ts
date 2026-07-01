import { getDefaultModelSettings } from '../defaultModel';
import { UserError } from '../errors';
import type { ModelSettings } from '../model';

export type ToolExecutionConfig = {
  /**
   * Maximum number of local function tool calls to execute concurrently.
   * Set to `null` or leave unset to start all function tool calls emitted in a turn.
   * This does not change provider-side `parallelToolCalls` behavior.
   */
  maxFunctionToolConcurrency?: number | null;
  /**
   * Runs function tool input guardrails before emitting a pending human approval interruption.
   * The same guardrails still run again immediately before tool execution after approval.
   */
  preApprovalInputGuardrails?: boolean;
};

export function getImplicitModelSettingsForResolvedModel(
  explicitlyModelSet: boolean,
  resolvedModelName?: string,
): ModelSettings {
  if (resolvedModelName && resolvedModelName.trim().length > 0) {
    return getDefaultModelSettings(resolvedModelName);
  }
  if (explicitlyModelSet) {
    return {};
  }
  return getDefaultModelSettings();
}

export function validateToolExecutionConfig(
  config: ToolExecutionConfig | undefined,
): ToolExecutionConfig | undefined {
  const maxConcurrency = config?.maxFunctionToolConcurrency;
  const preApprovalInputGuardrails = config?.preApprovalInputGuardrails;
  if (
    typeof preApprovalInputGuardrails !== 'undefined' &&
    typeof preApprovalInputGuardrails !== 'boolean'
  ) {
    throw new UserError(
      'toolExecution.preApprovalInputGuardrails must be a boolean when provided.',
    );
  }
  if (maxConcurrency == null) {
    return config;
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new UserError(
      'toolExecution.maxFunctionToolConcurrency must be an integer greater than or equal to 1.',
    );
  }
  return config;
}
