import {
  hasBackslashPathSeparator,
  hasParentPathSegment,
  normalizePosixPath,
} from './shared/posixPath';

export type SandboxPathGrantInit = {
  path: string;
  readOnly?: boolean;
  description?: string;
};

export type SandboxPathGrant = {
  path: string;
  readOnly: boolean;
  description?: string;
};

export function normalizePathGrant(
  grant: SandboxPathGrantInit,
): SandboxPathGrant {
  if ('read_only' in (grant as Record<string, unknown>)) {
    throw new Error(
      'Use camelCase config keys in sandbox path grants; snake_case key "read_only" is not supported.',
    );
  }
  if (hasParentPathSegment(grant.path)) {
    throw new Error(
      'Sandbox path grant path must not contain parent segments.',
    );
  }
  if (hasBackslashPathSeparator(grant.path)) {
    throw new Error('Sandbox path grant path must use "/" separators.');
  }
  const normalizedPath = normalizePosixPath(grant.path);
  if (!normalizedPath.startsWith('/')) {
    throw new Error('Sandbox path grant path must be absolute.');
  }
  if (normalizedPath === '/') {
    throw new Error('Sandbox path grant path must not be filesystem root.');
  }

  return {
    path: normalizedPath,
    readOnly: grant.readOnly ?? false,
    ...(grant.description ? { description: grant.description } : {}),
  };
}
