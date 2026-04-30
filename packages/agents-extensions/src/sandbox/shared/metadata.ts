import {
  isDir,
  isMount,
  normalizeRelativePath,
  FileMode,
  Permissions,
  SandboxUnsupportedFeatureError,
  type Entry,
  type Manifest,
} from '@openai/agents-core/sandbox';
import type { SandboxManifestMetadataSupport } from './types';

export const MOUNT_MANIFEST_METADATA_SUPPORT: SandboxManifestMetadataSupport = {
  mounts: true,
};

export const SANDBOX_MANIFEST_METADATA_SUPPORT: SandboxManifestMetadataSupport =
  {
    users: true,
    groups: true,
    entryPermissions: true,
    entryGroups: true,
    mounts: true,
  };

export function sandboxEntryPermissionsMode(entry: Entry): string {
  const permissions = new Permissions(
    entry.permissions ?? {
      owner: FileMode.ALL,
      group: FileMode.READ | FileMode.EXEC,
      other: FileMode.READ | FileMode.EXEC,
    },
  );
  return (permissions.toMode() & 0o777).toString(8).padStart(4, '0');
}

export function assertSandboxManifestMetadataSupported(
  providerName: string,
  manifest: Manifest,
  support: SandboxManifestMetadataSupport = {},
): void {
  if (!support.users && manifest.users.length > 0) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support manifest users yet.`,
      {
        provider: providerName,
        feature: 'manifest.users',
      },
    );
  }
  if (!support.groups && manifest.groups.length > 0) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support manifest groups yet.`,
      {
        provider: providerName,
        feature: 'manifest.groups',
      },
    );
  }
  if (!support.extraPathGrants && manifest.extraPathGrants.length > 0) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support extra path grants yet.`,
      {
        provider: providerName,
        feature: 'manifest.extraPathGrants',
      },
    );
  }

  for (const [logicalPath, entry] of Object.entries(manifest.entries)) {
    assertSandboxEntryMetadataSupported(
      providerName,
      logicalPath,
      entry,
      support,
    );
  }
}

export function assertSandboxEntryMetadataSupported(
  providerName: string,
  logicalPath: string,
  entry: Entry,
  support: SandboxManifestMetadataSupport = {},
): void {
  const displayPath = logicalPath || '.';
  if (!support.entryPermissions && entry.permissions !== undefined) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support sandbox entry permissions yet: ${displayPath}`,
      {
        provider: providerName,
        feature: 'entry.permissions',
        path: displayPath,
      },
    );
  }
  if (!support.entryGroups && entry.group !== undefined) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support sandbox entry group ownership yet: ${displayPath}`,
      {
        provider: providerName,
        feature: 'entry.group',
        path: displayPath,
      },
    );
  }
  if (!support.mounts && isMount(entry)) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support mount entries yet: ${displayPath}`,
      {
        provider: providerName,
        feature: 'entry.mount',
        path: displayPath,
      },
    );
  }

  if (!isDir(entry) || !entry.children) {
    return;
  }

  for (const [childPath, childEntry] of Object.entries(entry.children)) {
    const childLogicalPath = joinSandboxPath(logicalPath, childPath);
    assertSandboxEntryMetadataSupported(
      providerName,
      childLogicalPath,
      childEntry,
      support,
    );
  }
}

function joinSandboxPath(parent: string, child: string): string {
  const normalizedChild = normalizeRelativePath(child);
  if (!parent || parent === '.') {
    return normalizedChild;
  }
  return `${parent.replace(/\/+$/u, '')}/${normalizedChild}`;
}
