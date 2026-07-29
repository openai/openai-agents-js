import { isAbsolute, relative, sep } from 'node:path';
import type { SandboxPathGrant } from '../pathGrants';

export function sandboxPathGrantHostPath(grant: SandboxPathGrant): string {
  const hostPath = grant.hostPath ?? grant.path;
  if (grant.hostPath !== undefined && !isAbsolute(hostPath)) {
    throw new Error(
      `Sandbox path grant hostPath must be absolute on the current host: ${hostPath}`,
    );
  }
  if (
    grant.hostPath !== undefined &&
    sep === '\\' &&
    !/^[A-Za-z]:\\/u.test(hostPath)
  ) {
    throw new Error(
      `Sandbox path grant hostPath must be drive-qualified on Windows: ${hostPath}`,
    );
  }
  return hostPath;
}

export function relativeHostPathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

export function relativeHostPathEscapesRootOrSelf(
  relativePath: string,
): boolean {
  return relativePath === '' || relativeHostPathEscapesRoot(relativePath);
}

export function isHostPathWithinRoot(root: string, path: string): boolean {
  return !relativeHostPathEscapesRoot(relative(root, path));
}

export function isHostPathStrictlyWithinRoot(
  root: string,
  path: string,
): boolean {
  return !relativeHostPathEscapesRootOrSelf(relative(root, path));
}
