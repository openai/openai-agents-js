import { describe, expect, it, vi } from 'vitest';
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

  it.each([
    ['private default', {}, true, false, true],
    ['explicit Session or excluded run', {}, false, true, false],
    ['explicit WebSockets', { supportsWebsockets: true }, true, true, false],
    ['explicit HTTP', { supportsWebsockets: false }, true, false, true],
    [
      'custom base URL',
      { baseUrl: 'http://127.0.0.1:1/v1' },
      true,
      false,
      true,
    ],
    [
      'buffered response',
      { responseMode: 'buffered' as const },
      true,
      false,
      false,
    ],
  ] as const)(
    'selects effective transport for %s',
    async (_name, options, privateRun, allowed, reusable) => {
      const provider = new NativeProvider({
        apiKey: 'synthetic-key',
        ...options,
      });
      const lease = provider._acquire(undefined, privateRun);
      try {
        expect(lease.websocketsAllowed).toBe(allowed);
        expect(lease.config['model_providers.native_agent']).toMatchObject({
          supports_websockets: allowed,
        });
        expect(lease.privateRuntime !== undefined).toBe(reusable);
      } finally {
        await lease.release();
        await provider.close();
      }
    },
  );

  it.each([
    { apiKey: 'synthetic-key' },
    { baseUrl: 'http://127.0.0.1:1/v1' },
    { supportsWebsockets: true },
    { responseMode: 'buffered' as const },
    { headers: { 'x-custom-route': 'synthetic' } },
  ])('rejects conflicting saved-login routing', (options) => {
    expect(() => new NativeProvider({ ...options, codexLogin: {} })).toThrow(
      'codexLogin requires native streaming HTTP with default ChatGPT routing',
    );
  });

  it('rejects mixed ChatGPT inference options before reading the credential callback', () => {
    const getCredential = vi.fn();
    const signInWithChatGPT = {
      get getCredential() {
        return getCredential();
      },
    };
    expect(
      () => new NativeProvider({ codexLogin: {}, signInWithChatGPT }),
    ).toThrow('Choose either codexLogin or signInWithChatGPT');
    expect(getCredential).not.toHaveBeenCalled();
  });

  it('captures saved-login options and skips ambient API-key selection', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-api-key');
    const login = { accountId: 'synthetic-workspace' };
    const provider = new NativeProvider({ codexLogin: login });
    login.accountId = 'replaced';
    const lease = provider._acquire(undefined, true);
    try {
      expect(lease.codexLogin).toEqual({ accountId: 'synthetic-workspace' });
      expect(lease.apiKey).toBeUndefined();
      expect(lease.realtimeApiKey).toBeUndefined();
      expect(lease.privateRuntime).toBeUndefined();
      expect(lease.config['model_providers.native_agent']).toMatchObject({
        base_url: 'https://chatgpt.com/backend-api/codex',
        supports_websockets: false,
      });
    } finally {
      await lease.release();
      await provider.close();
      vi.unstubAllEnvs();
    }
  });

  it('keeps the default WS choice when private candidacy is excluded', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    class DerivedProvider extends NativeProvider {}
    const providers = [
      new NativeProvider(),
      new DerivedProvider({ apiKey: 'synthetic-key' }),
    ];
    try {
      for (const provider of providers) {
        const lease = provider._acquire(undefined, true);
        try {
          expect(lease.websocketsAllowed).toBe(true);
          expect(lease.privateRuntime).toBeUndefined();
        } finally {
          await lease.release();
        }
      }
    } finally {
      await Promise.all(providers.map((provider) => provider.close()));
      vi.unstubAllEnvs();
    }
  });
});
