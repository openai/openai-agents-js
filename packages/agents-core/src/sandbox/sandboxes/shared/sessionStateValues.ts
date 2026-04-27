import { Manifest } from '../../manifest';
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

export function deserializeLocalSandboxSessionStateValues(
  state: Record<string, unknown>,
  configuredSnapshot: LocalSandboxSnapshotSpec | null | undefined,
): LocalSandboxSessionStateValues {
  return {
    manifest: new Manifest(state.manifest as Manifest),
    workspaceRootPath: readString(state, 'workspaceRootPath'),
    workspaceRootOwned: Boolean(state.workspaceRootOwned),
    environment: readEnvironmentState(state.environment),
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
