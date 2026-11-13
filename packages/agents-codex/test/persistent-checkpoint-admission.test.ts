import { expect, it } from 'vitest';
import { Session } from '../src/runtime/session';

function refusal(allowLocal: boolean, options: object, queued = false) {
  const owner = {
    options,
    repairReceiptsIncomplete: false,
    isOpen: true,
    manualSealing: false,
    manualSealed: false,
    manualSeal: undefined,
    pendingRoots: new Map(queued ? [['queued', {}]] : []),
    graphStops: new Set(),
    childCallbacks: { entered: () => [] },
    lifecycle: { kind: 'idle' },
  };
  return Reflect.get(Session.prototype, 'checkpointRefusal').call(
    owner,
    allowLocal,
  );
}

it('admits idle LocalStorage inspection to the native checkpoint owner', () => {
  expect(refusal(true, { localStorage: true })).toBeUndefined();
});

it('keeps persistent manual capture outside the idle opt-in', () => {
  expect(refusal(false, { localStorage: true })).toContain(
    'Persistent storage',
  );
  expect(
    refusal(false, { localStorage: true, customStore: () => {} }),
  ).toContain('Persistent storage');
});

it('admits idle CustomStorage inspection to the native checkpoint owner', () => {
  expect(
    refusal(true, { localStorage: true, customStore: () => {} }),
  ).toBeUndefined();
});

it('keeps queued root work outside idle LocalStorage capture', () => {
  expect(refusal(true, { localStorage: true }, true)).toContain(
    'queued root work',
  );
});
