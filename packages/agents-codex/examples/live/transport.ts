import { once } from 'node:events';
import OpenAI from 'openai';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import type { LiveMessage } from './delegation';

const messageSchema = z.looseObject({ type: z.string() });
const createdSessionSchema = z.object({
  session: z.object({ id: z.string().min(1) }),
  transport: z.object({ sdp: z.string().min(1) }),
});

export function readMessage(data: RawData): LiveMessage {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  return messageSchema.parse(JSON.parse(bytes.toString('utf8')));
}

export function sendMessage(
  socket: WebSocket,
  message: LiveMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('The connection is not open.'));
      return;
    }
    socket.send(JSON.stringify(message), (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

/** Close the transport and retain its error owner until the socket has settled. */
export async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const ignoreError = () => {};
    const timer = setTimeout(() => socket.terminate(), 5_000);
    socket.on('error', ignoreError);
    socket.once('close', () => {
      clearTimeout(timer);
      socket.off('error', ignoreError);
      resolve();
    });
    socket.close();
  });
}

/** Use the installed API client's HTTP/auth handling and one server-owned sideband. */
export function createLiveTransport(options: {
  apiKey: string;
  baseURL?: string;
}) {
  if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required.');
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    timeout: 30_000,
  });

  return {
    async create(session: Record<string, unknown>, sdp: string) {
      // The pinned client predates Live's generated resource; post is its public escape hatch.
      const response = await client.post<unknown>('/live/sessions', {
        body: { session, transport: { type: 'webrtc', sdp } },
      });
      return createdSessionSchema.parse(response);
    },
    async attach(sessionId: string): Promise<WebSocket> {
      const url = new URL(
        `${client.baseURL.replace(/\/$/, '')}/live/sessions/${encodeURIComponent(sessionId)}/attach`,
      );
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${client.apiKey}`,
      };
      if (client.organization)
        headers['OpenAI-Organization'] = client.organization;
      if (client.project) headers['OpenAI-Project'] = client.project;
      const socket = new WebSocket(url, {
        headers,
        handshakeTimeout: 15_000,
        followRedirects: false,
        maxPayload: 1_048_576,
      });
      try {
        await once(socket, 'open', { signal: AbortSignal.timeout(15_000) });
        return socket;
      } catch (error) {
        await closeSocket(socket);
        throw error;
      }
    },
  };
}

/** Recover only enough authority to close a session whose first attachment failed. */
export async function closeUnattachedSession(
  transport: ReturnType<typeof createLiveTransport>,
  sessionId: string,
): Promise<boolean> {
  const socket = await transport.attach(sessionId);
  const final = Promise.withResolvers<boolean>();
  const onMessage = (data: RawData) => {
    try {
      if (readMessage(data).type === 'session.closed') final.resolve(true);
    } catch {
      final.resolve(false);
    }
  };
  const onFailure = () => final.resolve(false);
  socket.on('message', onMessage);
  socket.on('error', onFailure);
  socket.on('close', onFailure);
  const timer = setTimeout(onFailure, 15_000);
  try {
    socket.send(JSON.stringify({ type: 'session.close' }));
    return await final.promise;
  } finally {
    clearTimeout(timer);
    socket.off('message', onMessage);
    await closeSocket(socket);
    socket.off('error', onFailure);
    socket.off('close', onFailure);
  }
}
