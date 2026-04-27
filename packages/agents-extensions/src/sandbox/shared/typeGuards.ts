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
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const result = value?.[key];
  return typeof result === 'string' ? result : undefined;
}

export function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function readString(
  value: Record<string, unknown>,
  key: string,
  fallback: string = '',
): string {
  const result = value[key];
  return result === undefined || result === null ? fallback : String(result);
}

export function readOptionalNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const result = value[key];
  return typeof result === 'number' ? result : undefined;
}

export function readOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const result = value[key];
  return typeof result === 'boolean' ? result : undefined;
}

export function readOptionalNumberArray(value: unknown): number[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number')
    : undefined;
}

export function readOptionalRecordArray(
  value: unknown,
): Array<Record<string, unknown>> | undefined {
  return Array.isArray(value) ? value.filter(isRecord) : undefined;
}

export function readOptionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  return isStringRecord(value) ? value : undefined;
}
