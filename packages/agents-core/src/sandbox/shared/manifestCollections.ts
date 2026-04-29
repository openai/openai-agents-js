import { jsonEqual } from './compare';

export function mergeNamedObjects<T extends { name: string }>(
  base: T[],
  update: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const value of [...base, ...update]) {
    merged.set(value.name, structuredClone(value));
  }
  return [...merged.values()];
}

export function addedOrChangedNamedObjects<T extends { name: string }>(
  current: T[],
  target: T[],
): T[] {
  const currentByName = new Map(current.map((value) => [value.name, value]));
  return target
    .filter((value) => {
      const existing = currentByName.get(value.name);
      return !existing || !jsonEqual(existing, value);
    })
    .map((value) => structuredClone(value));
}

export function mergePathKeyedObjects<T extends { path: string }>(
  base: T[],
  update: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const value of [...base, ...update]) {
    merged.set(value.path, structuredClone(value));
  }
  return [...merged.values()];
}

export function addedOrChangedPathKeyedObjects<T extends { path: string }>(
  current: T[],
  target: T[],
): T[] {
  const currentByPath = new Map(current.map((value) => [value.path, value]));
  return target
    .filter((value) => {
      const existing = currentByPath.get(value.path);
      return !existing || !jsonEqual(existing, value);
    })
    .map((value) => structuredClone(value));
}
