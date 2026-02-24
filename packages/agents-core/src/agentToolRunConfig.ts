import type { RunConfig } from './run';

const TRANSPORT_OVERRIDE_PROVIDER_DATA_ALIAS_KEYS = [
  ['extra_headers', 'extraHeaders'],
  ['extra_query', 'extraQuery'],
  ['extra_body', 'extraBody'],
] as const;
const NESTED_MODEL_SETTINGS_MERGE_KEYS = ['reasoning', 'text'] as const;
const AGENT_TOOL_PARENT_RUN_CONFIG_SYMBOL = Symbol(
  'openai.agents.agentToolParentRunConfig',
);

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function setAgentToolParentRunConfigOnDetails(
  details: object,
  parentRunConfig: Partial<RunConfig> | undefined,
): void {
  const safeParentRunConfig = getInheritedAgentToolRunConfig(
    parentRunConfig,
    undefined,
  );
  if (!safeParentRunConfig) {
    return;
  }

  Object.defineProperty(details, AGENT_TOOL_PARENT_RUN_CONFIG_SYMBOL, {
    value: safeParentRunConfig,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

export function getAgentToolParentRunConfigFromDetails(
  details: unknown,
): Partial<RunConfig> | undefined {
  if (!details || typeof details !== 'object') {
    return undefined;
  }

  const detailsRecord = details as Record<PropertyKey, unknown>;
  const internalParentRunConfig =
    detailsRecord[AGENT_TOOL_PARENT_RUN_CONFIG_SYMBOL];
  if (typeof internalParentRunConfig !== 'undefined') {
    return internalParentRunConfig as Partial<RunConfig>;
  }

  // Backward compatibility for direct/manual tool invocation tests and callers.
  const legacyParentRunConfig = detailsRecord.parentRunConfig;
  return isPlainObjectLike(legacyParentRunConfig)
    ? (legacyParentRunConfig as Partial<RunConfig>)
    : undefined;
}

function getSafeInheritedAgentToolModelSettings(
  modelSettings: Partial<RunConfig>['modelSettings'],
): Partial<RunConfig>['modelSettings'] | undefined {
  if (!modelSettings) {
    return undefined;
  }

  // Tool-selection settings are specific to the outer agent/tool set and can
  // break nested Agent.asTool runs when inherited blindly.
  const {
    toolChoice: _toolChoice,
    parallelToolCalls: _parallelToolCalls,
    ...safeModelSettings
  } = modelSettings;

  return Object.keys(safeModelSettings).length > 0
    ? safeModelSettings
    : undefined;
}

function mergeNestedObjectMap(
  targetRecord: Record<string, unknown>,
  inheritedRecord: Record<string, unknown>,
  overrideRecord: Record<string, unknown>,
  key: string,
): void {
  if (
    isPlainObjectLike(inheritedRecord[key]) &&
    isPlainObjectLike(overrideRecord[key])
  ) {
    targetRecord[key] = {
      ...inheritedRecord[key],
      ...overrideRecord[key],
    };
  }
}

function getMergedProviderDataAliasMap(
  providerData: Record<string, unknown>,
  firstKey: string,
  secondKey: string,
): Record<string, unknown> | undefined {
  const firstValue = providerData[firstKey];
  const secondValue = providerData[secondKey];
  const hasFirst = typeof firstValue !== 'undefined';
  const hasSecond = typeof secondValue !== 'undefined';

  if (!hasFirst && !hasSecond) {
    return undefined;
  }

  if (
    (hasFirst && !isPlainObjectLike(firstValue)) ||
    (hasSecond && !isPlainObjectLike(secondValue))
  ) {
    return undefined;
  }

  return {
    ...(hasFirst ? (firstValue as Record<string, unknown>) : {}),
    ...(hasSecond ? (secondValue as Record<string, unknown>) : {}),
  };
}

function mergeTransportOverrideAliasMaps(
  targetProviderData: Record<string, unknown>,
  inheritedProviderData: Record<string, unknown>,
  toolProviderData: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): void {
  const inheritedMerged = getMergedProviderDataAliasMap(
    inheritedProviderData,
    snakeKey,
    camelKey,
  );
  const toolMerged = getMergedProviderDataAliasMap(
    toolProviderData,
    snakeKey,
    camelKey,
  );

  if (!inheritedMerged || !toolMerged) {
    return;
  }

  const mergedAliasMap = {
    ...inheritedMerged,
    ...toolMerged,
  };

  const aliasKeys = [snakeKey, camelKey] as const;
  for (const aliasKey of aliasKeys) {
    if (
      hasOwn(inheritedProviderData, aliasKey) ||
      hasOwn(toolProviderData, aliasKey)
    ) {
      targetProviderData[aliasKey] = mergedAliasMap;
    }
  }
}

function mergeAgentToolProviderData(
  inheritedProviderData: Record<string, unknown>,
  toolProviderData: Record<string, unknown>,
): Record<string, unknown> {
  const mergedProviderData: Record<string, unknown> = {
    ...inheritedProviderData,
    ...toolProviderData,
  };

  for (const [
    snakeKey,
    camelKey,
  ] of TRANSPORT_OVERRIDE_PROVIDER_DATA_ALIAS_KEYS) {
    mergeNestedObjectMap(
      mergedProviderData,
      inheritedProviderData,
      toolProviderData,
      snakeKey,
    );
    mergeNestedObjectMap(
      mergedProviderData,
      inheritedProviderData,
      toolProviderData,
      camelKey,
    );
  }

  for (const [
    snakeKey,
    camelKey,
  ] of TRANSPORT_OVERRIDE_PROVIDER_DATA_ALIAS_KEYS) {
    mergeTransportOverrideAliasMaps(
      mergedProviderData,
      inheritedProviderData,
      toolProviderData,
      snakeKey,
      camelKey,
    );
  }

  return mergedProviderData;
}

function mergeAgentToolModelSettings(
  inheritedRunConfig: Partial<RunConfig>,
  toolRunConfigOverride: Partial<RunConfig>,
): Partial<RunConfig>['modelSettings'] | undefined {
  const inheritedModelSettings = inheritedRunConfig.modelSettings;
  const toolModelSettings = toolRunConfigOverride.modelSettings;
  const hasToolModelSettingsOverride = hasOwn(
    toolRunConfigOverride,
    'modelSettings',
  );

  if (
    !inheritedModelSettings ||
    !hasToolModelSettingsOverride ||
    !toolModelSettings
  ) {
    return undefined;
  }

  const mergedModelSettings: Record<string, unknown> = {
    ...inheritedModelSettings,
    ...toolModelSettings,
  };
  const inheritedModelSettingsRecord = inheritedModelSettings as Record<
    string,
    unknown
  >;
  const toolModelSettingsRecord = toolModelSettings as Record<string, unknown>;

  for (const key of NESTED_MODEL_SETTINGS_MERGE_KEYS) {
    mergeNestedObjectMap(
      mergedModelSettings,
      inheritedModelSettingsRecord,
      toolModelSettingsRecord,
      key,
    );
  }

  const inheritedProviderData = inheritedModelSettings.providerData;
  const toolProviderData = toolModelSettings.providerData;
  const hasToolProviderDataOverride = hasOwn(toolModelSettings, 'providerData');

  if (
    hasToolProviderDataOverride &&
    isPlainObjectLike(inheritedProviderData) &&
    isPlainObjectLike(toolProviderData)
  ) {
    mergedModelSettings.providerData = mergeAgentToolProviderData(
      inheritedProviderData,
      toolProviderData,
    );
  }

  return mergedModelSettings as Partial<RunConfig>['modelSettings'];
}

export function getInheritedAgentToolRunConfig(
  parentRunConfig: Partial<RunConfig> | undefined,
  toolRunConfigOverride: Partial<RunConfig> | undefined,
): Partial<RunConfig> | undefined {
  if (!parentRunConfig) {
    return undefined;
  }

  const inheritedRunConfig: Partial<RunConfig> = {};
  const overridesModelProvider =
    typeof toolRunConfigOverride?.modelProvider !== 'undefined';

  if (typeof parentRunConfig.modelProvider !== 'undefined') {
    inheritedRunConfig.modelProvider = parentRunConfig.modelProvider;
  }
  if (!overridesModelProvider && typeof parentRunConfig.model !== 'undefined') {
    inheritedRunConfig.model = parentRunConfig.model;
  }
  if (
    !overridesModelProvider &&
    typeof parentRunConfig.modelSettings !== 'undefined'
  ) {
    const inheritedModelSettings = getSafeInheritedAgentToolModelSettings(
      parentRunConfig.modelSettings,
    );
    if (typeof inheritedModelSettings !== 'undefined') {
      inheritedRunConfig.modelSettings = inheritedModelSettings;
    }
  }

  return Object.keys(inheritedRunConfig).length > 0
    ? inheritedRunConfig
    : undefined;
}

export function mergeAgentToolRunConfig(
  inheritedRunConfig: Partial<RunConfig> | undefined,
  toolRunConfigOverride: Partial<RunConfig> | undefined,
): Partial<RunConfig> {
  if (!inheritedRunConfig) {
    return toolRunConfigOverride ?? {};
  }
  if (!toolRunConfigOverride) {
    return inheritedRunConfig;
  }

  const mergedRunConfig: Partial<RunConfig> = {
    ...inheritedRunConfig,
    ...toolRunConfigOverride,
  };
  const mergedModelSettings = mergeAgentToolModelSettings(
    inheritedRunConfig,
    toolRunConfigOverride,
  );
  if (typeof mergedModelSettings !== 'undefined') {
    mergedRunConfig.modelSettings = mergedModelSettings;
  }

  return mergedRunConfig;
}
