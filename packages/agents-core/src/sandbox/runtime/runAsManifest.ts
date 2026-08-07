import {
  copyManifestMountCredentialExposurePolicy,
  Environment,
  Manifest,
} from '../manifest';
import type { SandboxUser } from '../users';

export function sandboxRunAsName(
  runAs: string | SandboxUser | undefined,
): string | undefined {
  if (runAs === undefined) {
    return undefined;
  }
  if (typeof runAs === 'string') {
    return runAs.trim();
  }
  return runAs.name;
}

export function manifestWithRunAsUser(
  manifest: Manifest,
  runAs: string | SandboxUser | undefined,
): Manifest {
  const runAsName = sandboxRunAsName(runAs);
  if (!runAsName || manifestHasUser(manifest, runAsName)) {
    return manifest;
  }

  const updatedManifest = new Manifest({
    version: manifest.version,
    root: manifest.root,
    entries: structuredClone(manifest.entries),
    environment: Object.fromEntries(
      Object.entries(manifest.environment).map(([key, value]) => [
        key,
        value instanceof Environment ? value.init() : value,
      ]),
    ),
    users: [...structuredClone(manifest.users), { name: runAsName }],
    groups: structuredClone(manifest.groups),
    extraPathGrants: structuredClone(manifest.extraPathGrants),
    remoteMountCommandAllowlist: [...manifest.remoteMountCommandAllowlist],
  });
  copyManifestMountCredentialExposurePolicy(updatedManifest, manifest);
  return updatedManifest;
}

function manifestHasUser(manifest: Manifest, name: string): boolean {
  if (manifest.users.some((user) => user.name === name)) {
    return true;
  }
  return manifest.groups.some((group) =>
    group.users?.some((user) => user.name === name),
  );
}
