import { captureModelSettings, type ModelSettings } from './provider';

export function captureOpeningModelSettings(
  defaults?: ModelSettings,
  openingSettings?: ModelSettings,
): ModelSettings | undefined {
  let settings = defaults && captureModelSettings(defaults);
  if (openingSettings !== undefined) {
    const overrides = captureModelSettings(openingSettings);
    settings = captureModelSettings({
      ...settings,
      ...overrides,
      retry:
        overrides.retry === undefined
          ? settings?.retry
          : overrides.retry === null
            ? null
            : { ...settings?.retry, ...overrides.retry },
    });
  }
  return settings;
}
