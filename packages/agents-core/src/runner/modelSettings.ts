import { Agent } from '../agent';
import { gpt5ReasoningSettingsRequired, isGpt5Default } from '../defaultModel';
import { Model, ModelSettings, ModelTracing } from '../model';
import { AgentToolUseTracker } from './toolUseTracker';

/**
 * Resolves the effective model for the next turn by giving precedence to the agent-specific
 * configuration when present, otherwise falling back to the runner-level default.
 */
export function selectModel(
  agentModel: string | Model,
  runConfigModel: string | Model | undefined,
): string | Model {
  if (
    (typeof agentModel === 'string' &&
      agentModel !== Agent.DEFAULT_MODEL_PLACEHOLDER) ||
    agentModel
  ) {
    return agentModel;
  }
  return runConfigModel ?? agentModel ?? Agent.DEFAULT_MODEL_PLACEHOLDER;
}

/**
 * Normalizes tracing configuration into the format expected by model providers.
 * Returns `false` to disable tracing, `true` to include full payload data, or
 * `'enabled_without_data'` to omit sensitive content while still emitting spans.
 */
export function getTracing(
  tracingDisabled: boolean,
  traceIncludeSensitiveData: boolean,
): ModelTracing {
  if (tracingDisabled) {
    return false;
  }

  if (traceIncludeSensitiveData) {
    return true;
  }

  return 'enabled_without_data';
}

/**
 * Resets the tool choice when the agent is configured to prefer a fresh tool selection after
 * any tool usage. This prevents the provider from reusing stale tool hints across turns.
 */
export function maybeResetToolChoice(
  agent: Agent<any, any>,
  toolUseTracker: AgentToolUseTracker,
  modelSettings: ModelSettings,
) {
  if (agent.resetToolChoice && toolUseTracker.hasUsedTools(agent)) {
    return { ...modelSettings, toolChoice: undefined };
  }
  return modelSettings;
}

/**
 * When the default model is a GPT-5 variant, agents may carry GPT-5-specific providerData
 * (e.g., reasoning effort, text verbosity). If a run resolves to a non-GPT-5 model and the
 * agent relied on the default model (i.e., no explicit model set), these GPT-5-only settings
 * are incompatible and should be stripped to avoid runtime errors.
 */
export function adjustModelSettingsForNonGPT5RunnerModel(
  explictlyModelSet: boolean,
  agentModelSettings: ModelSettings,
  runnerModel: string | Model,
  modelSettings: ModelSettings,
  resolvedModelName?: string,
): ModelSettings {
  const modelName =
    resolvedModelName ??
    (typeof runnerModel === 'string'
      ? runnerModel
      : ((runnerModel as { model?: string; name?: string } | undefined)
          ?.model ?? (runnerModel as { name?: string } | undefined)?.name));
  const isNonGpt5RunnerModel =
    typeof modelName === 'string'
      ? !gpt5ReasoningSettingsRequired(modelName)
      : true;

  if (
    isGpt5Default() &&
    explictlyModelSet &&
    isNonGpt5RunnerModel &&
    (agentModelSettings.providerData?.reasoning ||
      agentModelSettings.providerData?.text?.verbosity ||
      (agentModelSettings.providerData as any)?.reasoning_effort)
  ) {
    const copiedModelSettings: ModelSettings = {
      ...modelSettings,
      providerData: modelSettings.providerData
        ? structuredClone(modelSettings.providerData)
        : undefined,
    };
    if (modelSettings.reasoning) {
      copiedModelSettings.reasoning = { ...modelSettings.reasoning };
    }
    if (modelSettings.text) {
      copiedModelSettings.text = { ...modelSettings.text };
    }

    delete copiedModelSettings.providerData?.reasoning;
    delete (copiedModelSettings.providerData as any)?.text?.verbosity;
    delete (copiedModelSettings.providerData as any)?.reasoning_effort;
    if (copiedModelSettings.reasoning) {
      delete copiedModelSettings.reasoning.effort;
      delete copiedModelSettings.reasoning.summary;
    }
    if (copiedModelSettings.text) {
      delete copiedModelSettings.text.verbosity;
    }
    return copiedModelSettings;
  }
  return modelSettings;
}
