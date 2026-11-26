import type { AgentInputItem } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    (typeof value !== 'object' &&
      typeof value !== 'function' &&
      typeof value !== 'symbol')
  );
}

// Only copy private native captures. All richer graphs retain native cloning.
export function cloneCapturedInputItem(item: AgentInputItem): AgentInputItem {
  const value: unknown = item;
  if (!isRecord(value)) return structuredClone(item);
  const result = { ...value };
  for (const key of Object.keys(result)) {
    const field = result[key];
    if (isScalar(field)) continue;
    if (key !== 'content' || !Array.isArray(field) || field.length !== 1)
      return structuredClone(item);
    const keys = Object.keys(field);
    if (keys.length !== 1 || keys[0] !== '0') return structuredClone(item);
    const part = field[0];
    if (!isRecord(part)) return structuredClone(item);
    const copiedPart = { ...part };
    for (const partKey of Object.keys(copiedPart)) {
      const partValue = copiedPart[partKey];
      if (isScalar(partValue)) continue;
      if (
        partKey !== 'annotations' ||
        !Array.isArray(partValue) ||
        partValue.length !== 0 ||
        Object.keys(partValue).length !== 0
      )
        return structuredClone(item);
      copiedPart[partKey] = [];
    }
    result[key] = [copiedPart];
  }
  return result as unknown as AgentInputItem;
}
