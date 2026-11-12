/** Private callback metadata never enters model-visible output or application data. */
const targets = new WeakMap<object, string>();
export function handoffResultTarget(result: object): string | undefined {
  return targets.get(result);
}
export function withHandoffResultTarget<T extends object>(
  result: T,
  target: string,
): T {
  targets.set(result, target);
  return result;
}
