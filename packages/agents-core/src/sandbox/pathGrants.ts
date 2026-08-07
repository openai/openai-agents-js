import {
  hasBackslashPathSeparator,
  hasParentPathSegment,
  normalizePosixPath,
} from './shared/posixPath';

export type SandboxPathGrantInit = {
  /** Absolute POSIX path visible inside the sandbox. */
  path: string;
  /** Absolute native host path. Defaults to `path`. */
  hostPath?: string;
  readOnly?: boolean;
  description?: string;
};

export type SandboxPathGrant = {
  /** Absolute POSIX path visible inside the sandbox. */
  path: string;
  /** Absolute native host path when it differs from `path`. */
  hostPath?: string;
  readOnly: boolean;
  description?: string;
};

export function normalizePathGrant(
  grant: SandboxPathGrantInit,
): SandboxPathGrant {
  const grantRecord = grant as Record<string, unknown>;
  if ('read_only' in grantRecord) {
    throw new Error(
      'Use camelCase config keys in sandbox path grants; snake_case key "read_only" is not supported.',
    );
  }
  if ('host_path' in grantRecord) {
    throw new Error(
      'Use camelCase config keys in sandbox path grants; snake_case key "host_path" is not supported.',
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
  const normalizedHostPath =
    grant.hostPath === undefined
      ? undefined
      : normalizePathGrantHostPath(grant.hostPath);

  return {
    path: normalizedPath,
    ...(normalizedHostPath === undefined
      ? {}
      : { hostPath: normalizedHostPath }),
    readOnly: grant.readOnly ?? false,
    ...(grant.description ? { description: grant.description } : {}),
  };
}

function normalizePathGrantHostPath(hostPath: string): string {
  if (hostPath.startsWith('\\\\') || hostPath.startsWith('//')) {
    throw new Error(
      'Sandbox path grant hostPath does not support UNC or device paths.',
    );
  }
  if (hostPath.split(/[\\/]/u).some((segment) => segment === '..')) {
    throw new Error(
      'Sandbox path grant hostPath must not contain parent segments.',
    );
  }
  const windowsDriveMatch = /^([A-Za-z]:)[\\/]/u.exec(hostPath);
  if (windowsDriveMatch) {
    const segments = hostPath
      .slice(windowsDriveMatch[0].length)
      .split(/[\\/]/u)
      .filter((segment) => segment && segment !== '.');
    if (segments.length === 0) {
      throw new Error(
        'Sandbox path grant hostPath must not be filesystem root.',
      );
    }
    return `${windowsDriveMatch[1]}\\${segments.join('\\')}`;
  }
  if (!hostPath.startsWith('/')) {
    throw new Error(
      'Sandbox path grant hostPath must be an absolute host path.',
    );
  }
  const normalizedHostPath = normalizePosixHostPath(hostPath);
  if (normalizedHostPath === '/') {
    throw new Error('Sandbox path grant hostPath must not be filesystem root.');
  }
  return normalizedHostPath;
}

function normalizePosixHostPath(hostPath: string): string {
  const segments = hostPath
    .split('/')
    .filter((segment) => segment && segment !== '.');
  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}
