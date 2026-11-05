import { isAbsolute, resolve } from 'node:path';

/** A trusted application-owned native conversation directory, not a checkpoint. */
export interface LocalStorage {
  readonly path: string;
}

/** Resolve a profile once without opening files or acquiring a writer. */
export function localStorage(path: string): LocalStorage {
  checkPath(path);
  return Object.freeze({ path: resolve(path) });
}

function checkPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.includes('\0'))
    throw new TypeError('Local storage requires a nonempty path without NUL');
}

/** @internal Capture structural descriptors before opening can suspend. */
export function localStoragePath(storage: LocalStorage): string {
  if (storage === null || typeof storage !== 'object')
    throw new TypeError('storage must contain an absolute path');
  const path = storage.path;
  checkPath(path);
  if (!isAbsolute(path)) throw new TypeError('storage.path must be absolute');
  return path;
}
