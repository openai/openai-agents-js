// Internal identity capability; never re-export from a public entrypoint.
const issued = new WeakSet<object>();

export function issueOwnedOpeningAuthority(): object {
  const token = Object.freeze({});
  issued.add(token);
  return token;
}

export function hasOwnedOpeningAuthority(value: unknown): value is object {
  return typeof value === 'object' && value !== null && issued.has(value);
}

export function consumeOwnedOpeningAuthority(value: unknown): boolean {
  return typeof value === 'object' && value !== null && issued.delete(value);
}
