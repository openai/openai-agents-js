export function hasBackslashPathSeparator(path: string): boolean {
  return path.trim().includes('\\');
}

export function hasParentPathSegment(path: string): boolean {
  return path
    .trim()
    .split('/')
    .some((segment) => segment === '..');
}

export function hasEscapingParentPathSegment(path: string): boolean {
  let depth = 0;
  for (const segment of path.trim().split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment !== '..') {
      depth += 1;
      continue;
    }
    if (depth === 0) {
      return true;
    }
    depth -= 1;
  }
  return false;
}

export function normalizePosixPath(path: string): string {
  const trimmed = path.trim();
  const isAbsolute = trimmed.startsWith('/');
  const segments: string[] = [];

  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }

  const normalized = segments.join('/');
  if (isAbsolute) {
    return normalized ? `/${normalized}` : '/';
  }
  return normalized || '.';
}

export function posixDirname(path: string): string {
  if (path === '/') {
    return '/';
  }
  const normalized = path.replace(/\/+$/u, '');
  if (!normalized || normalized === '/') {
    return '.';
  }
  const index = normalized.lastIndexOf('/');
  if (index < 0) {
    return '.';
  }
  return index === 0 ? '/' : normalized.slice(0, index);
}

export function isUnderPosixPath(path: string, root: string): boolean {
  if (root === '/') {
    return path.startsWith('/');
  }
  return path === root || path.startsWith(`${root}/`);
}

export function relativePosixPathWithinRoot(
  root: string,
  path: string,
): string | null {
  if (!isUnderPosixPath(path, root)) {
    return null;
  }
  if (path === root) {
    return '';
  }
  if (root === '/') {
    return path.slice(1);
  }
  return path.slice(root.length + 1);
}
