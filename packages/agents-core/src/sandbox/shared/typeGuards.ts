export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const result = value[key];
  return typeof result === 'string' ? result : undefined;
}

export function readString(
  value: Record<string, unknown>,
  key: string,
  fallback: string = '',
): string {
  const result = value[key];
  return result === undefined || result === null ? fallback : String(result);
}

export function readOptionalNumberArray(value: unknown): number[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number')
    : undefined;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
