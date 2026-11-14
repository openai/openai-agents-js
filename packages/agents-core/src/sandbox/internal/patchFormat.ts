import type { PatchFormat } from '../../editor';

/** Reject unsupported formatter results before a provider write. */
export function applyPatchFormat(
  format: PatchFormat,
  input: string,
  diff: string,
  mode: 'create' | 'default' = 'default',
): string {
  const result = format.applyDiff(input, diff, mode);
  if (typeof result !== 'string') {
    // An unsupported asynchronous formatter must not create an unhandled rejection.
    void Promise.resolve(result).catch(() => {});
    throw new TypeError('PatchFormat.applyDiff must return a string');
  }
  return result;
}
