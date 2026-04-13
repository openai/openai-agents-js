export type SafeExecuteResult<T> = [Error | unknown | null, T | null];

export async function safeExecute<T>(
  fn: () => T,
): Promise<SafeExecuteResult<T>> {
  try {
    return [null, await fn()];
  } catch (error) {
    return [error, null];
  }
}
