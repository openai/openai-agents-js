import type { JsonObject } from './binding';
import type { NativeProvider } from './provider';

type CompactionOwner = { readonly defaultProviderCompaction?: boolean };

// Only the captured configured-child opening can attach this presentation receipt.
const configuredChildDefaults = new WeakMap<object, boolean>();

export function bindConfiguredChildSandboxDefault<T extends object>(
  options: T,
  value: boolean | undefined,
): T {
  if (value !== undefined) configuredChildDefaults.set(options, value);
  return options;
}

export function consumeConfiguredChildSandboxDefault(
  options: object | undefined,
): boolean | undefined {
  if (options === undefined) return undefined;
  const value = configuredChildDefaults.get(options);
  configuredChildDefaults.delete(options);
  return value;
}

/** Opaque model producers retain explicit request-control opt-in. */
export function sandboxDefaultCompaction(
  owner: CompactionOwner | undefined,
  provider: NativeProvider,
  inherited?: boolean,
): boolean | undefined {
  const selected = owner?.defaultProviderCompaction ?? inherited;
  return provider._supportsProfileRouting ? selected : undefined;
}

export function sandboxDefaultModel(
  model: JsonObject,
  owner: CompactionOwner | undefined,
  provider: NativeProvider,
  inherited?: boolean,
): JsonObject {
  const selected = sandboxDefaultCompaction(owner, provider, inherited);
  if (selected === undefined) return model;
  return {
    ...model,
    request_controls: {
      ...((model.request_controls ?? {}) as JsonObject),
      sdk_default_provider_compaction: selected,
    },
  };
}
