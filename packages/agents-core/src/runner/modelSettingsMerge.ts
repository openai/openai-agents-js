import { ModelSettings } from '../model';

const NESTED_MODEL_SETTINGS_MERGE_KEYS = ['reasoning', 'text'] as const;

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function mergeRetrySettings(
  targetRecord: Record<string, unknown>,
  inheritedRecord: Record<string, unknown>,
  overrideRecord: Record<string, unknown>,
): void {
  if (
    !isPlainObjectLike(inheritedRecord.retry) ||
    !isPlainObjectLike(overrideRecord.retry)
  ) {
    return;
  }

  const inheritedRetry = inheritedRecord.retry;
  const overrideRetry = overrideRecord.retry;
  const mergedRetry = {
    ...inheritedRetry,
    ...overrideRetry,
  };

  if (
    isPlainObjectLike(inheritedRetry.backoff) &&
    isPlainObjectLike(overrideRetry.backoff)
  ) {
    mergedRetry.backoff = {
      ...inheritedRetry.backoff,
      ...overrideRetry.backoff,
    };
  }

  targetRecord.retry = mergedRetry;
}

export function mergeModelSettings(
  inheritedModelSettings?: ModelSettings,
  overrideModelSettings?: ModelSettings,
): ModelSettings {
  const mergedModelSettings: ModelSettings = {
    ...inheritedModelSettings,
    ...overrideModelSettings,
  };

  if (!inheritedModelSettings || !overrideModelSettings) {
    return mergedModelSettings;
  }

  const inheritedModelSettingsRecord = inheritedModelSettings as Record<
    string,
    unknown
  >;
  const overrideModelSettingsRecord = overrideModelSettings as Record<
    string,
    unknown
  >;
  const mergedModelSettingsRecord = mergedModelSettings as Record<
    string,
    unknown
  >;

  for (const key of NESTED_MODEL_SETTINGS_MERGE_KEYS) {
    mergeNestedObjectMap(
      mergedModelSettingsRecord,
      inheritedModelSettingsRecord,
      overrideModelSettingsRecord,
      key,
    );
  }
  mergeRetrySettings(
    mergedModelSettingsRecord,
    inheritedModelSettingsRecord,
    overrideModelSettingsRecord,
  );

  return mergedModelSettings;
}
