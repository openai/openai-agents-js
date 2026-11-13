import { describe, expect, it } from 'vitest';
import {
  captureProviderHistory,
  providerHistorySettings,
  type ProviderHistory,
} from '../src/runtime/provider-history';

describe('provider history capture', () => {
  it('detaches the current selection before asynchronous opening', () => {
    const supplied = { type: 'conversation' as const, id: 'conv_current' };
    const captured = captureProviderHistory(supplied);
    supplied.id = 'conv_changed';
    expect(captured).toEqual({ type: 'conversation', id: 'conv_current' });
    expect(Object.isFrozen(captured)).toBe(true);
  });
  it('keeps ordinary local mode and automatic response mode distinct', () => {
    expect(captureProviderHistory(undefined)).toBeUndefined();
    expect(captureProviderHistory({ type: 'previous_response' })).toEqual({
      type: 'previous_response',
    });
  });
  it.each([
    { type: 'conversation' },
    { type: 'conversation', id: '' },
    { type: 'previous_response', id: ' ' },
    { type: 'unsupported', id: 'external' },
  ])('refuses invalid selection %j', (value) => {
    expect(() => captureProviderHistory(value as ProviderHistory)).toThrow(
      TypeError,
    );
  });
  it.each([undefined, {}, { store: false }])(
    'requires current HTTP-chain storage permission for %j',
    (settings) => {
      expect(() =>
        providerHistorySettings({ type: 'previous_response' }, settings),
      ).toThrow('store=true');
    },
  );
  it('retains explicit response storage permission', () => {
    expect(
      providerHistorySettings({ type: 'previous_response' }, { store: true }),
    ).toEqual({ store: true });
  });
  it.each([undefined, false, true])(
    'uses current conversation storage choice %j',
    (store) => {
      expect(
        providerHistorySettings(
          { type: 'conversation', id: 'conv_current' },
          store === undefined ? undefined : { store },
        ),
      ).toEqual({ store: store ?? null });
    },
  );
  it('preserves legacy settings outside remote history mode', () => {
    const settings = { store: true };
    expect(providerHistorySettings(undefined, settings)).toBe(settings);
  });
});
