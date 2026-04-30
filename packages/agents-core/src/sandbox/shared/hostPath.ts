import { isAbsolute, relative, sep } from 'node:path';

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
