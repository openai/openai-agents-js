// Internal policy metadata, not authority: Session must also consume the original grant.
const plainOpenings = new WeakSet<object>();
export function markPlainTerminalOpening(token: object): void {
  plainOpenings.add(token);
}
export function consumePlainTerminalOpening(token: unknown): boolean {
  return (
    typeof token === 'object' && token !== null && plainOpenings.delete(token)
  );
}
