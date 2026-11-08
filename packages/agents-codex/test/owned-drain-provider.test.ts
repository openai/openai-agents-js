import { describe, expect, it } from 'vitest';
import {
  NativeProvider,
  isCanonicalProviderForOwnedOpening,
} from '../src/runtime/provider';

describe('owned drain resolved provider provenance', () => {
  it('accepts the original provider but rejects fake and Proxy receivers without traps', () => {
    const provider = new NativeProvider({ supportsWebsockets: false });
    expect(isCanonicalProviderForOwnedOpening(provider)).toBe(true);
    expect(
      isCanonicalProviderForOwnedOpening(
        Object.create(NativeProvider.prototype),
      ),
    ).toBe(false);
    let traps = 0;
    const proxy = new Proxy(provider, {
      getPrototypeOf(target) {
        traps++;
        return Reflect.getPrototypeOf(target);
      },
      get(target, key, receiver) {
        traps++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(isCanonicalProviderForOwnedOpening(proxy)).toBe(false);
    expect(traps).toBe(0);
  });

  it('does not invoke an own getter while refusing an observable provider', () => {
    const provider = new NativeProvider();
    let reads = 0;
    Object.defineProperty(provider, 'baseUrl', {
      get() {
        reads++;
        return 'fixture';
      },
    });
    expect(isCanonicalProviderForOwnedOpening(provider)).toBe(false);
    expect(reads).toBe(0);
    expect(provider.baseUrl).toBe('fixture');
    expect(reads).toBe(1);
  });

  it('refuses a provider subclass', () => {
    class Derived extends NativeProvider {}
    expect(isCanonicalProviderForOwnedOpening(new Derived())).toBe(false);
  });

  it.each(['method', 'getter'] as const)(
    'keeps a self-restoring %s acquisition ordinary',
    (kind) => {
      const provider = new NativeProvider();
      const lease = {} as ReturnType<NativeProvider['_acquire']>;
      let getterReads = 0;
      let calls = 0;
      const wrapped = function (this: NativeProvider) {
        expect(this).toBe(provider);
        calls++;
        Reflect.deleteProperty(provider, '_acquire');
        return lease;
      };
      Object.defineProperty(provider, '_acquire', {
        configurable: true,
        ...(kind === 'method'
          ? { value: wrapped }
          : {
              get() {
                getterReads++;
                Reflect.deleteProperty(provider, '_acquire');
                return wrapped;
              },
            }),
      });
      const canonicalAtAcquire = isCanonicalProviderForOwnedOpening(provider);
      expect(getterReads).toBe(0);
      const actualLease = Reflect.apply(provider._acquire, provider, [
        undefined,
      ]);
      expect(actualLease).toBe(lease);
      expect(calls).toBe(1);
      expect(getterReads).toBe(kind === 'getter' ? 1 : 0);
      expect(isCanonicalProviderForOwnedOpening(provider)).toBe(true);
      expect(
        canonicalAtAcquire && isCanonicalProviderForOwnedOpening(provider),
      ).toBe(false);
    },
  );
});
