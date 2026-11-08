import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Agent, NativeProvider } from '../src';

type Frame = Record<string, any>;
const OFFER = 'v=0\r\ns=synthetic-browser-offer\r\n';
const ANSWER = 'v=0\r\ns=synthetic-provider-answer\r\n';
const AUTHORIZATION = 'Bearer synthetic-native-call-key';

// The same local call/sideband protocol used by the Python public API fixture;
// the SDK owns actual native provider projection, admission and call cleanup.
async function callPeer() {
  const sessions = new Map<string, Frame>();
  const offers: string[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const sidebands: string[] = [];
  const hangups: string[] = [];
  const frames: Frame[] = [];
  const failures: unknown[] = [];
  const closed: Promise<void>[] = [];
  const server = createServer(async (request, response) => {
    try {
      headers.push({ ...request.headers });
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (request.method === 'POST' && path === '/v1/realtime/calls') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
          headers: { 'content-type': request.headers['content-type']! },
        }).formData();
        const text = async (name: string) => {
          const value = form.get(name);
          if (value === null) throw new Error(`Missing ${name}`);
          return typeof value === 'string' ? value : value.text();
        };
        offers.push(await text('sdp'));
        const id = `rtc_native_${offers.length}`;
        sessions.set(id, JSON.parse(await text('session')));
        response
          .writeHead(200, {
            'content-type': 'application/sdp',
            location: `/v1/realtime/calls/${id}`,
          })
          .end(ANSWER);
      } else if (request.method === 'POST' && path.endsWith('/hangup')) {
        hangups.push(path.split('/').at(-2)!);
        response.writeHead(200).end();
      } else response.writeHead(404).end('Unexpected provider route');
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end('Fixture failure');
    }
  });
  const sockets = new WebSocketServer({ server, path: '/v1/realtime' });
  sockets.on('connection', (socket, request) => {
    headers.push({ ...request.headers });
    const id = new URL(request.url!, 'http://localhost').searchParams.get(
      'call_id',
    )!;
    sidebands.push(id);
    const accepted = structuredClone(sessions.get(id));
    if (!accepted) {
      socket.close(1008, 'Unknown call');
      return;
    }
    closed.push(once(socket, 'close').then(() => {}));
    socket.send(
      JSON.stringify({
        type: 'session.created',
        session: { ...accepted, id: `session-${id}` },
      }),
    );
    socket.on('message', (raw) => {
      const frame: Frame = JSON.parse(raw.toString());
      frames.push(frame);
      // Unexpected updates remain visible to the test rather than hanging it.
      if (frame.type === 'session.update') {
        Object.assign(accepted, frame.session);
        socket.send(
          JSON.stringify({
            type: 'session.updated',
            session: { ...accepted, id: `session-${id}` },
          }),
        );
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    sessions,
    offers,
    headers,
    sidebands,
    hangups,
    frames,
    failures,
    closed,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each(['webrtc', 'sip'] as const)(
  'opens and closes public native %s transport through local HTTP and sideband',
  async (kind) => {
    const peer = await callPeer();
    try {
      await using provider = new NativeProvider({
        baseUrl: peer.baseUrl,
        apiKey: 'synthetic-native-call-key',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Preserve the caller profile.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      const options =
        kind === 'sip'
          ? {}
          : ({
              model: 'fixture-realtime',
              voice: 'marin',
              instructions: 'Initial media instructions.',
            } as const);
      const warmup = await session.realtime({
        ...options,
        transport: { type: 'webrtc', offerSdp: OFFER },
      });
      expect(warmup.callId).toBe('rtc_native_1');
      expect(warmup.answerSdp).toBe(ANSWER);
      await warmup.close();
      await Promise.all(peer.closed);
      if (kind === 'sip') {
        // An app accepts the external call with the captured caller's config.
        peer.sessions.set(
          'rtc_external_sip',
          structuredClone(peer.sessions.get('rtc_native_1')!),
        );
        const voice = await session.realtime({
          ...options,
          transport: { type: 'sip', callId: 'rtc_external_sip' },
        });
        try {
          expect(voice.callId).toBe('rtc_external_sip');
          expect(voice.answerSdp).toBeUndefined();
          await expect(voice.sendAudio(new Int16Array([1]))).rejects.toThrow(
            'SIP',
          );
        } finally {
          await voice.close();
        }
        await Promise.all(peer.closed);
      }
      expect(await session.getActiveAgent()).toBe(agent);
      expect(peer.offers).toEqual([OFFER]);
      expect(peer.sidebands).toEqual(
        kind === 'sip'
          ? ['rtc_native_1', 'rtc_external_sip']
          : ['rtc_native_1'],
      );
      expect(peer.hangups).toEqual(['rtc_native_1']);
      expect(peer.sessions.get('rtc_native_1')!.instructions).toBe(
        options.instructions ?? 'Preserve the caller profile.',
      );
      expect(
        peer.frames.some((frame) => frame.type === 'input_audio_buffer.append'),
      ).toBe(false);
      for (const headers of peer.headers) {
        expect(headers.authorization).toBe(AUTHORIZATION);
        expect(headers['x-sdk-sentinel-grant']).toBeUndefined();
      }
      expect(peer.failures).toEqual([]);
    } finally {
      await peer.close();
    }
  },
  30000,
);

nativeIt.each(['model', 'voice', 'instructions'] as const)(
  'rejects a SIP %s override before credentials and preserves Session reuse',
  async (field) => {
    const peer = await callPeer();
    try {
      await using provider = new NativeProvider({
        baseUrl: peer.baseUrl,
        apiKey: 'synthetic-native-call-key',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Preserve the caller profile.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      let credentialCalls = 0;
      await expect(
        session.realtime({
          transport: { type: 'sip', callId: 'rtc_external_sip' },
          [field]: field === 'voice' ? 'marin' : 'initial-call-override',
          apiKey: () => {
            credentialCalls++;
            return 'synthetic-native-call-key';
          },
        }),
      ).rejects.toThrow();
      expect(credentialCalls).toBe(0);
      expect(peer.headers).toEqual([]);
      expect(peer.offers).toEqual([]);
      expect(peer.sidebands).toEqual([]);
      expect(await session.getActiveAgent()).toBe(agent);

      const settings = { audio: { output: { voice: 'marin' } } };
      const warmup = await session.realtime({
        transport: { type: 'webrtc', offerSdp: OFFER },
        settings,
      });
      await warmup.close();
      peer.sessions.set(
        'rtc_external_sip',
        structuredClone(peer.sessions.get('rtc_native_1')!),
      );
      const voice = await session.realtime({
        transport: { type: 'sip', callId: 'rtc_external_sip' },
        settings,
      });
      expect(voice.callId).toBe('rtc_external_sip');
      await voice.close();
      await Promise.all(peer.closed);
      expect(peer.sidebands).toEqual(['rtc_native_1', 'rtc_external_sip']);
      expect(peer.hangups).toEqual(['rtc_native_1']);
      expect(peer.failures).toEqual([]);
    } finally {
      await peer.close();
    }
  },
  30000,
);
