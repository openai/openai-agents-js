import { UserError } from '../../errors';
import type { Manifest } from '../manifest';

const SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SerializedManifestEnvironment = Record<
  string,
  { value: string; ephemeral?: boolean; description?: string }
>;

export async function materializeEnvironment(
  manifest: Manifest,
  baseEnvironment: Record<string, string> = {},
): Promise<Record<string, string>> {
  return {
    ...baseEnvironment,
    ...(await manifest.resolveEnvironment()),
  };
}

export function materializeStaticEnvironment(
  manifest: Manifest,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.environment).map(([key, value]) => [
      key,
      value.value,
    ]),
  );
}

export async function mergeMaterializedEnvironment(
  previousManifest: Manifest,
  nextManifest: Manifest,
  currentEnvironment: Record<string, string>,
): Promise<Record<string, string>> {
  const previousEnvironment = await materializeEnvironment(previousManifest);
  const runtimeEnvironmentDelta = Object.fromEntries(
    Object.entries(currentEnvironment).filter(
      ([key, value]) => previousEnvironment[key] !== value,
    ),
  );

  return await materializeEnvironment(nextManifest, runtimeEnvironmentDelta);
}

export function mergeStaticMaterializedEnvironment(
  previousManifest: Manifest,
  nextManifest: Manifest,
  currentEnvironment: Record<string, string>,
): Record<string, string> {
  const previousEnvironment = materializeStaticEnvironment(previousManifest);
  const runtimeEnvironmentDelta = Object.fromEntries(
    Object.entries(currentEnvironment).filter(
      ([key, value]) => previousEnvironment[key] !== value,
    ),
  );

  return {
    ...runtimeEnvironmentDelta,
    ...materializeStaticEnvironment(nextManifest),
  };
}

export function serializeManifestEnvironment(
  manifest: Manifest,
): SerializedManifestEnvironment {
  return Object.fromEntries(
    Object.entries(manifest.environment).map(([key, value]) => [
      key,
      value.normalized(),
    ]),
  );
}

export function serializeRuntimeEnvironmentForPersistence(
  manifest: Manifest,
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.environment)
      .filter(
        ([key, value]) =>
          !value.ephemeral &&
          key in environment &&
          typeof environment[key] === 'string',
      )
      .map(([key, value]) => [
        key,
        value.resolver ? environment[key] : value.value,
      ]),
  );
}

export function deserializePersistedEnvironmentForRuntime(
  manifest: Manifest,
  environment: Record<string, string> | undefined,
  baseEnvironment: Record<string, string> = {},
): Record<string, string> {
  const manifestEnvironment = materializeStaticEnvironment(manifest);
  const persistentManifestEnvironment = Object.fromEntries(
    Object.entries(manifestEnvironment).filter(
      ([key]) => !manifest.environment[key]?.ephemeral,
    ),
  );
  const persistedEnvironment = Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key]) =>
        key in manifestEnvironment && !manifest.environment[key]?.ephemeral,
    ),
  );

  return {
    ...baseEnvironment,
    ...persistentManifestEnvironment,
    ...persistedEnvironment,
  };
}

export function assertShellEnvironmentName(name: string): void {
  if (!SHELL_ENV_NAME_PATTERN.test(name)) {
    throw new UserError(
      `Invalid environment variable name "${name}". Environment names used in shell commands must match ${SHELL_ENV_NAME_PATTERN.source}.`,
    );
  }
}
