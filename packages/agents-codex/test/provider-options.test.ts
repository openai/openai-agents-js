import { describe, expect, it } from 'vitest';
import { NativeProvider } from '../src/runtime/provider';

describe('NativeProvider option capture', () => {
  it.each([
    ['baseUrl', 42],
    ['apiKey', 42],
    ['supportsWebsockets', 'false'],
    ['baseUrl', null],
    ['apiKey', null],
    ['supportsWebsockets', null],
  ])(
    'rejects an incorrectly typed %s from JSON configuration',
    (key, value) => {
      const options = JSON.parse(JSON.stringify({ [key]: value }));
      expect(() => new NativeProvider(options)).toThrow(TypeError);
      expect(() => new NativeProvider(options)).toThrow(String(key));
    },
  );

  it('preserves omission, explicit websocket choices and nonempty strings', async () => {
    const defaultProvider = new NativeProvider();
    const explicit = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-api-key',
      supportsWebsockets: false,
    });
    const enabled = new NativeProvider({ supportsWebsockets: true });
    expect(defaultProvider.baseUrl).toBeUndefined();
    expect(defaultProvider.apiKey).toBeUndefined();
    expect(defaultProvider.supportsWebsockets).toBeUndefined();
    expect(explicit.baseUrl).toBe('http://127.0.0.1:1/v1');
    expect(explicit.apiKey).toBe('synthetic-api-key');
    expect(explicit.supportsWebsockets).toBe(false);
    expect(enabled.supportsWebsockets).toBe(true);
    await Promise.all([
      defaultProvider.close(),
      explicit.close(),
      enabled.close(),
    ]);
  });

  it.each(['baseUrl', 'apiKey'])('continues rejecting an empty %s', (key) => {
    expect(() => new NativeProvider({ [key]: '' })).toThrow(TypeError);
  });
});
