import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSession } from '@openai/agents/realtime';
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions';
import { buildServer, type TwilioServerConfig } from './server';

// Observe the provider boundary without bypassing real routes or signature checks.
vi.mock('@openai/agents/realtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@openai/agents/realtime')>();
  return {
    ...actual,
    RealtimeSession: vi.fn(function (
      ...args: ConstructorParameters<typeof actual.RealtimeSession>
    ) {
      return new actual.RealtimeSession(...args);
    }),
  };
});
vi.mock('@openai/agents-extensions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@openai/agents-extensions')>();
  return {
    ...actual,
    TwilioRealtimeTransportLayer: vi.fn(function (
      ...args: ConstructorParameters<typeof actual.TwilioRealtimeTransportLayer>
    ) {
      return new actual.TwilioRealtimeTransportLayer(...args);
    }),
  };
});

const connect = vi.fn().mockResolvedValue(undefined);
const close = vi.fn();

const config: TwilioServerConfig = {
  openAiApiKey: 'synthetic-openai-key',
  twilioAuthToken: 'synthetic-twilio-token',
  publicBaseUrl: 'https://voice.example.test',
};
// Independent test oracle: callers supply literal external URLs and form values.
function sign(url: string, params: Record<string, string | string[]> = {}) {
  const data = Object.keys(params)
    .sort()
    .reduce((value, key) => {
      const values = Array.isArray(params[key])
        ? [...new Set(params[key])].sort()
        : [params[key]];
      return value + values.map((item) => key + item).join('');
    }, url);
  return createHmac('sha1', config.twilioAuthToken)
    .update(data)
    .digest('base64');
}
const proxyHeaders = {
  host: 'hostile.example.test',
  forwarded: 'host=hostile.example.test;proto=http',
  'x-forwarded-host': 'hostile.example.test',
  'x-forwarded-proto': 'http',
};
const servers: ReturnType<typeof buildServer>[] = [];
const sockets: { terminate(): void }[] = [];
async function server() {
  const app = buildServer(config);
  servers.push(app);
  await app.ready();
  return app;
}
function noProviderWork() {
  expect(RealtimeSession).not.toHaveBeenCalled();
  expect(TwilioRealtimeTransportLayer).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The real constructor and transport listeners remain active; never open a provider connection.
  const actual = await vi.importActual<
    typeof import('@openai/agents/realtime')
  >('@openai/agents/realtime');
  vi.mocked(RealtimeSession).mockImplementation(function (...args) {
    const session = new actual.RealtimeSession(...args);
    const originalClose = session.close.bind(session);
    session.connect = connect;
    session.close = () => {
      close();
      originalClose();
    };
    return session;
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of servers.splice(0)) await app.close();
  vi.restoreAllMocks();
});

describe('authenticated Twilio example', () => {
  it.each([
    ['twilioAuthToken', ''],
    ['openAiApiKey', ''],
    ['publicBaseUrl', ''],
    ['publicBaseUrl', 'http://voice.example.test'],
    ['publicBaseUrl', 'https://user@voice.example.test'],
    ['publicBaseUrl', 'https://voice.example.test/prefix'],
    ['publicBaseUrl', 'https://voice.example.test?query=value'],
    ['publicBaseUrl', 'https://voice.example.test#fragment'],
  ])('rejects invalid startup configuration %s=%s', (key, value) => {
    expect(() => buildServer({ ...config, [key]: value })).toThrow();
    noProviderWork();
  });

  it('signs GET against the configured origin and preserves the raw query', async () => {
    const app = await server();
    const query = '?From=%2B15550000000&label=a+b&label=a%20b';
    const response = await app.inject({
      method: 'GET',
      url: '/incoming-call' + query,
      headers: {
        ...proxyHeaders,
        'x-twilio-signature': sign(
          'https://voice.example.test/incoming-call' + query,
        ),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      '<Stream url="wss://voice.example.test/media-stream"',
    );
    expect(response.body).not.toContain('hostile');
    noProviderWork();
  });

  it('includes all decoded POST values including duplicates and whitespace', async () => {
    const app = await server();
    const params = { From: '+15550000000', Future: [' b ', 'a'], Empty: '' };
    const response = await app.inject({
      method: 'POST',
      url: '/incoming-call?label=%2F',
      headers: {
        ...proxyHeaders,
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': sign(
          'https://voice.example.test/incoming-call?label=%2F',
          params,
        ),
      },
      payload: 'From=%2B15550000000&Future=+b+&Future=a&Empty=',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('wss://voice.example.test/media-stream');
    noProviderWork();
  });

  it.each(['missing', 'wrong', 'hostile', 'query', 'body'])(
    'rejects %s HTTP signature without provider work',
    async (kind) => {
      const app = await server();
      const signed =
        kind === 'missing'
          ? undefined
          : kind === 'wrong'
            ? 'invalid'
            : sign(
                kind === 'hostile'
                  ? 'https://hostile.example.test/incoming-call'
                  : 'https://voice.example.test/incoming-call',
                { From: 'original' },
              );
      const response = await app.inject({
        method: 'POST',
        url: '/incoming-call' + (kind === 'query' ? '?extra=1' : ''),
        headers: {
          ...proxyHeaders,
          'content-type': 'application/x-www-form-urlencoded',
          ...(signed ? { 'x-twilio-signature': signed } : {}),
        },
        payload: 'From=' + (kind === 'body' ? 'changed' : 'original'),
      });
      expect(response.statusCode).toBe(403);
      noProviderWork();
    },
  );

  it('rejects unsupported content and methods and retains the body limit', async () => {
    const app = await server();
    const headers = { 'x-twilio-signature': 'synthetic' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/incoming-call',
          headers,
          payload: { From: 'x' },
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ method: 'PUT', url: '/incoming-call', headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/incoming-call',
          headers: {
            ...headers,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: 'x=' + 'x'.repeat(1024 * 1024),
        })
      ).statusCode,
    ).toBe(413);
    noProviderWork();
  });

  it.each(['', '/'])(
    'accepts the documented WSS signature variant %s',
    async (suffix) => {
      const app = await server();
      const socket = await app.injectWS('/media-stream', {
        headers: {
          ...proxyHeaders,
          'x-twilio-signature': sign(
            'wss://voice.example.test/media-stream' + suffix,
          ),
        },
      });
      sockets.push(socket);
      expect(RealtimeSession).toHaveBeenCalledTimes(1);
      expect(TwilioRealtimeTransportLayer).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['missing', 'wrong', 'hostile', 'webhook', 'query'])(
    'rejects %s upgrade before allocating sessions',
    async (kind) => {
      const app = await server();
      const signed =
        kind === 'missing'
          ? undefined
          : kind === 'wrong'
            ? 'invalid'
            : sign(
                kind === 'hostile'
                  ? 'wss://hostile.example.test/media-stream'
                  : kind === 'webhook'
                    ? 'https://voice.example.test/incoming-call'
                    : 'wss://voice.example.test/media-stream',
              );
      await expect(
        app.injectWS('/media-stream' + (kind === 'query' ? '?extra=1' : ''), {
          headers: {
            ...proxyHeaders,
            ...(signed ? { 'x-twilio-signature': signed } : {}),
          },
        }),
      ).rejects.toThrow('403');
      noProviderWork();
    },
  );

  it('closes acquired resources when authenticated session startup fails', async () => {
    connect.mockRejectedValueOnce(new Error('synthetic private failure'));
    const app = await server();
    const socket = await app.injectWS('/media-stream', {
      headers: {
        'x-twilio-signature': sign('wss://voice.example.test/media-stream'),
      },
    });
    sockets.push(socket);
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(close).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Twilio session startup failed.',
    );
  });
  it('closes the authenticated socket if session construction fails', async () => {
    vi.mocked(RealtimeSession).mockImplementationOnce(function () {
      throw new Error('synthetic construction failure');
    });
    const app = await server();
    const socket = await app.injectWS('/media-stream', {
      headers: {
        'x-twilio-signature': sign('wss://voice.example.test/media-stream'),
      },
    });
    sockets.push(socket);
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(connect).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Twilio session startup failed.',
    );
  });

  it('contains a disconnected pending call without closing a surviving call', async () => {
    let rejectPending!: (reason: Error) => void;
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPending = reject;
        }),
    );
    const app = await server();
    const headers = {
      'x-twilio-signature': sign('wss://voice.example.test/media-stream'),
    };
    const first = await app.injectWS('/media-stream', { headers });
    sockets.push(first);
    const survivor = await app.injectWS('/media-stream', { headers });
    sockets.push(survivor);
    first.close();
    await vi.waitFor(() => expect(first.readyState).toBe(3));
    // Deliver the provider's pending connection failure after the caller disconnects.
    rejectPending(new Error('synthetic cancelled connection'));
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(survivor.readyState).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
