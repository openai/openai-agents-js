import { Agent } from '../agent';
import { UserError } from '../errors';
import {
  isGpt5OrNewerReasoningModel,
  isGpt5OrNewerDefault,
} from '../defaultModel';
import { Model, ModelSettings } from '../model';
import { AgentToolUseTracker } from './toolUseTracker';
import { getImplicitModelSettingsForResolvedModel } from './runConfig';
import { mergeModelSettings } from './modelSettingsMerge';
export { mergeModelSettings } from './modelSettingsMerge';

const hasReasoningModelSettings = (settings?: ModelSettings): boolean => {
  const providerData = settings?.providerData as
    | {
        reasoning?: unknown;
        text?: { verbosity?: unknown };
        reasoning_effort?: unknown;
      }
    | undefined;
  return Boolean(
    providerData?.reasoning ||
    providerData?.text?.verbosity ||
    (providerData as { reasoning_effort?: unknown } | undefined)
      ?.reasoning_effort,
  );
};

/**
 * Resolves an explicit run override first, then the agent-specific model and runner default.
 */
export function selectModel(
  agentModel: string | Model,
  runConfigModel: string | Model | undefined,
  modelOverride?: string | Model,
): string | Model {
  if (modelOverride !== undefined) return modelOverride;
  if (
    (typeof agentModel === 'string' &&
      agentModel !== Agent.DEFAULT_MODEL_PLACEHOLDER) ||
    agentModel
  ) {
    return agentModel;
  }
  return runConfigModel ?? agentModel ?? Agent.DEFAULT_MODEL_PLACEHOLDER;
}

/** Validate the additive override without changing legacy model-default validation. */
export function validateModelOverride(
  value: unknown,
): string | Model | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'getResponse' in value &&
    typeof value.getResponse === 'function' &&
    'getStreamedResponse' in value &&
    typeof value.getStreamedResponse === 'function'
  ) {
    return value as Model;
  }
  throw new UserError(
    'modelOverride must be a nonempty model name or a Model implementation.',
  );
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
  if (
    agent.resetToolChoice &&
    toolUseTracker.hasUsedTools(agent) &&
    modelSettings.toolChoice !== 'none'
  ) {
    return { ...modelSettings, toolChoice: undefined };
  }
  return modelSettings;
}

/**
 * Preserves legacy settings cleanup for explicitly selected models outside the
 * GPT-5-and-newer reasoning family when the default model belongs to that family.
 */
export function adjustModelSettingsForLegacyModel(
  explicitlyModelSet: boolean,
  agentModelSettings: ModelSettings,
  modelSettings: ModelSettings,
  resolvedModelName?: string,
): ModelSettings {
  // Only a resolved string selection establishes model identity.
  const isLegacyModel =
    typeof resolvedModelName === 'string' &&
    !isGpt5OrNewerReasoningModel(resolvedModelName);
  const hasReasoningSettings =
    hasReasoningModelSettings(agentModelSettings) ||
    hasReasoningModelSettings(modelSettings);

  if (
    isGpt5OrNewerDefault() &&
    explicitlyModelSet &&
    isLegacyModel &&
    hasReasoningSettings
  ) {
    return stripReasoningModelSettings(modelSettings);
  }
  return modelSettings;
}

function stripReasoningModelSettings(
  modelSettings: ModelSettings,
): ModelSettings {
  const copiedProviderData = modelSettings.providerData
    ? { ...modelSettings.providerData }
    : undefined;

  if (copiedProviderData) {
    if (
      copiedProviderData.text &&
      typeof copiedProviderData.text === 'object'
    ) {
      copiedProviderData.text = { ...copiedProviderData.text };
      delete (copiedProviderData.text as any).verbosity;
    }
    delete (copiedProviderData as any).reasoning;
    delete (copiedProviderData as any).reasoning_effort;
  }

  const copiedModelSettings: ModelSettings = {
    ...modelSettings,
    providerData: copiedProviderData,
  };
  if (modelSettings.retry) {
    copiedModelSettings.retry = { ...modelSettings.retry };
    if (modelSettings.retry.backoff) {
      copiedModelSettings.retry.backoff = { ...modelSettings.retry.backoff };
    }
  }
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

/** Shared classic settings precedence, before turn-specific tool-choice reset. */
export function prepareModelSettings(
  agent: Agent<any, any>,
  invocationSettings: ModelSettings | undefined,
  explicitlyModelSet: boolean,
  resolvedModelName?: string,
  promptOwnsModel = false,
) {
  const explicit = agent.hasExplicitModelSettings();
  const agentModelSettings = explicit
    ? agent.modelSettings
    : Object.prototype.hasOwnProperty.call(agent.modelSettings, 'store')
      ? { store: agent.modelSettings.store }
      : undefined;
  const implicitModelSettings =
    explicit || promptOwnsModel
      ? undefined
      : getImplicitModelSettingsForResolvedModel(
          explicitlyModelSet,
          resolvedModelName,
        );
  const modelSettings = adjustModelSettingsForLegacyModel(
    explicitlyModelSet,
    agentModelSettings ?? implicitModelSettings ?? {},
    mergeModelSettings(
      mergeModelSettings(implicitModelSettings, invocationSettings),
      agentModelSettings,
    ),
    resolvedModelName,
  );
  return { modelSettings, agentModelSettings, implicitModelSettings };
}
