import type { Manifest } from '../../manifest';
import { normalizeExposedPort, type ExposedPortEndpoint } from '../../session';
import {
  isRecord,
  isStringRecord,
  readOptionalNumberArray,
  readOptionalString,
  readString,
} from '../../shared/typeGuards';
import type { LocalSandboxSnapshot, LocalSandboxSnapshotSpec } from '../types';
import { rehydrateLocalSnapshotSpec } from './localSnapshots';
import {
  deserializeHostPathGrantRedactionMetadata,
  deserializeManifest,
  deserializeMountCredentialRedactionMetadata,
} from './manifestPersistence';
import { rehydratePersistedEnvironmentForRuntime } from '../../shared/environment';

export type LocalSandboxSessionStateValues = {
  manifest: Manifest;
  workspaceRootPath: string;
  workspaceRootOwned: boolean;
  environment: Record<string, string>;
  snapshotSpec: LocalSandboxSnapshotSpec | null;
  snapshot: LocalSandboxSnapshot | null;
  snapshotFingerprint: string | null;
  snapshotFingerprintVersion: string | null;
  configuredExposedPorts: number[];
  exposedPorts?: Record<string, ExposedPortEndpoint>;
};

export async function deserializeLocalSandboxSessionStateValues(
  state: Record<string, unknown>,
  configuredSnapshot: LocalSandboxSnapshotSpec | null | undefined,
  prepareManifest: (manifest: Manifest) => Manifest = (manifest) => manifest,
): Promise<LocalSandboxSessionStateValues> {
  const manifest = prepareManifest(
    deserializeManifest(state.manifest as Record<string, unknown> | undefined),
  );
  const persistedEnvironment = readEnvironmentState(state.environment);
  const runtimeEnvironment = Object.fromEntries(
    Object.entries(persistedEnvironment).filter(
      ([key]) => !(key in manifest.environment),
    ),
  );
  return {
    manifest,
    workspaceRootPath: readString(state, 'workspaceRootPath'),
    workspaceRootOwned: Boolean(state.workspaceRootOwned),
    environment: {
      ...runtimeEnvironment,
      ...(await rehydratePersistedEnvironmentForRuntime(
        manifest,
        persistedEnvironment,
      )),
    },
    snapshotSpec: rehydrateLocalSnapshotSpec(
      state.snapshotSpec,
      configuredSnapshot,
    ),
    snapshot: (state.snapshot as LocalSandboxSnapshot | undefined) ?? null,
    snapshotFingerprint:
      readOptionalString(state, 'snapshotFingerprint') ??
      readOptionalString(state, 'snapshot_fingerprint') ??
      null,
    snapshotFingerprintVersion:
      readOptionalString(state, 'snapshotFingerprintVersion') ??
      readOptionalString(state, 'snapshot_fingerprint_version') ??
      null,
    configuredExposedPorts: normalizeExposedPorts(
      readOptionalNumberArray(state.configuredExposedPorts),
    ),
    exposedPorts: readExposedPortsState(state),
    ...deserializeHostPathGrantRedactionMetadata(state),
    ...deserializeMountCredentialRedactionMetadata(state),
  };
}

export function readExposedPortsState(
  state: Record<string, unknown>,
): Record<string, ExposedPortEndpoint> | undefined {
  const exposedPorts = state.exposedPorts;
  return isRecord(exposedPorts)
    ? (exposedPorts as Record<string, ExposedPortEndpoint>)
    : undefined;
}

export function normalizeExposedPorts(ports?: number[]): number[] {
  return [...new Set((ports ?? []).map((port) => normalizeExposedPort(port)))];
}

function readEnvironmentState(value: unknown): Record<string, string> {
  return isStringRecord(value) ? { ...value } : {};
}
