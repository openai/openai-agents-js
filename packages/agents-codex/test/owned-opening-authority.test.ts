import { describe, expect, it } from 'vitest';
import { Session } from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';
import {
  consumeOwnedOpeningAuthority,
  hasOwnedOpeningAuthority,
  issueOwnedOpeningAuthority,
} from '../src/runtime/owned-opening-authority';

// Source-only regression proposal. No native binding, SDK run or model request.
function construct(
  Constructor: typeof Session,
  authority: unknown,
  owned = false,
) {
  return new Constructor(
    {} as import('../src/runtime/binding').Engine,
    {
      id: 'authority-fixture',
    } as import('../src/runtime/binding').NativeThread,
    captureTools([]),
    {},
    {},
    null,
    undefined,
    null,
    owned ? { input: 'fixture' } : undefined,
    undefined,
    authority,
  );
}

describe('internal owned opening identity capability', () => {
  it.each([true, {}, { canonicalOwnedFactory: true }])(
    'does not accept a forged capability %j',
    (forged) => {
      expect(hasOwnedOpeningAuthority(forged)).toBe(false);
      expect(consumeOwnedOpeningAuthority(forged)).toBe(false);
      const real = construct(Session, undefined);
      const Exposed = real.constructor as typeof Session;
      // This was observably wrong with the original boolean constructor:
      // true without OneShotOptions threw the private-owner invariant.
      expect(() => construct(Exposed, forged)).not.toThrow();
      expect(() => construct(Exposed, forged, true)).not.toThrow();
    },
  );

  it('consumes a genuine grant at the real constructor and rejects replay', () => {
    const real = construct(Session, undefined);
    const Exposed = real.constructor as typeof Session;
    const token = issueOwnedOpeningAuthority();
    expect(hasOwnedOpeningAuthority(token)).toBe(true);
    expect(construct(Exposed, token, true)).toBeInstanceOf(Session);
    expect(hasOwnedOpeningAuthority(token)).toBe(false);
    expect(consumeOwnedOpeningAuthority(token)).toBe(false);
    // A replay cannot regain the private field, even without an owned run.
    expect(() => construct(Exposed, token)).not.toThrow();
  });

  it('rejects an inconsistent genuine grant without a one-shot owner', () => {
    const token = issueOwnedOpeningAuthority();
    expect(() => construct(Session, token)).toThrow(
      'Owned factory authority requires a one-shot owner',
    );
    expect(hasOwnedOpeningAuthority(token)).toBe(false);
  });
});
