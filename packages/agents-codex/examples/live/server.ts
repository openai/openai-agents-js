import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import {
  OpenAIResponsesModel,
  Runner,
  type Agent,
} from '@openai/agents/classic';
import { askOrderAgent, createOrderAgent, sessionConfig } from './agent';
import { relay } from './relay';
import {
  closeSocket,
  closeUnattachedSession,
  createLiveTransport,
  sendMessage,
} from './transport';

const offerSchema = z.strictObject({ sdp: z.string().min(1).max(65_536) });

function receiveOffer(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, sdp?: string) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onFailure);
      socket.off('close', onFailure);
      if (error) reject(error);
      else resolve(sdp!);
    };
    const onFailure = () =>
      finish(new Error('The browser disconnected before sending an offer.'));
    const onMessage = (data: RawData) => {
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        finish(undefined, offerSchema.parse(JSON.parse(bytes.toString())).sdp);
      } catch {
        finish(new Error('Invalid browser offer.'));
      }
    };
    const timer = setTimeout(
      () => finish(new Error('The browser offer timed out.')),
      30_000,
    );
    socket.once('message', onMessage);
    socket.once('error', onFailure);
    socket.once('close', onFailure);
    if (socket.readyState !== WebSocket.OPEN) onFailure();
  });
}

/** A localhost demonstration, with all API credentials and tool execution on the server. */
export function createLiveApp(options: {
  apiKey: string;
  baseURL?: string;
  agentModel?: string;
  backendModel?: string;
  agent?: Agent;
  runner?: Runner;
}) {
  const transport = createLiveTransport(options);
  const agent =
    options.agent ??
    createOrderAgent(
      new OpenAIResponsesModel(
        new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL }),
        options.agentModel ?? 'gpt-6-luna',
      ),
    );
  const runner = options.runner ?? new Runner();
  const active = new Set<Promise<void>>();
  const pages = new Map([
    ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
    [
      '/static/app.js',
      { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
    ],
  ]);
  const server = createServer((request, response) => {
    const page =
      request.method === 'GET' ? pages.get(request.url ?? '') : undefined;
    if (!page) {
      response.writeHead(404).end();
      return;
    }
    void readFile(join(__dirname, 'static', page.file)).then(
      (body) =>
        response
          .writeHead(200, {
            'Content-Type': page.contentType,
            'Cache-Control': 'no-store',
          })
          .end(body),
      () =>
        response.writeHead(500).end('The example page could not be loaded.'),
    );
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });

  async function handleSession(browser: WebSocket): Promise<void> {
    const setup = new AbortController();
    let firstMessage = true;
    const cancelSetup = () => {
      setup.abort(
        new Error('The browser ended the conversation during setup.'),
      );
    };
    const onSetupMessage = () => {
      // receiveOffer owns the first message; retain later controls even in the same frame batch.
      if (firstMessage) {
        firstMessage = false;
        return;
      }
      // Close is the only setup control; unexpected extra input also ends setup.
      cancelSetup();
    };
    const releaseSetup = () => {
      browser.off('message', onSetupMessage);
      browser.off('error', cancelSetup);
      browser.off('close', cancelSetup);
    };
    browser.on('message', onSetupMessage);
    browser.on('error', cancelSetup);
    browser.on('close', cancelSetup);
    try {
      const sdp = await receiveOffer(browser);
      if (setup.signal.aborted || browser.readyState !== WebSocket.OPEN) return;
      const created = await transport.create(
        sessionConfig(options.backendModel),
        sdp,
      );
      let attached = false;
      try {
        const live = await transport.attach(created.session.id);
        attached = true;
        const relaying = relay(
          live,
          browser,
          (request, signal) => askOrderAgent(agent, request, signal, runner),
          {
            type: 'answer',
            sdp: created.transport.sdp,
            session_id: created.session.id,
          },
          setup.signal,
        );
        // relay installs its listeners synchronously, so control ownership has no gap.
        releaseSetup();
        await relaying;
      } finally {
        if (!attached) {
          let confirmed = false;
          try {
            confirmed = await closeUnattachedSession(
              transport,
              created.session.id,
            );
          } catch {
            /* Report unconfirmed finalization without exposing provider errors. */
          }
          if (!confirmed)
            console.warn('Live session finalization could not be confirmed.');
        }
      }
    } catch (error) {
      console.warn(
        'Live example session failed (%s).',
        error instanceof Error ? error.name : 'Error',
      );
      try {
        await sendMessage(browser, {
          type: 'error',
          message:
            'The session failed. Check the server configuration and GPT Live access.',
        });
      } catch {
        /* The browser may already have disconnected. */
      }
    } finally {
      releaseSetup();
      await closeSocket(browser);
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const port = request.socket.localPort;
    const origins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);
    if (request.url !== '/ws' || !origins.has(request.headers.origin ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (browser) => {
      const task = handleSession(browser);
      active.add(task);
      void task.then(
        () => active.delete(task),
        () => active.delete(task),
      );
    });
  });

  let closing: Promise<void> | undefined;
  return {
    server,
    close() {
      return (closing ??= (async () => {
        const closed = server.listening
          ? new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          : Promise.resolve();
        for (const browser of sockets.clients) browser.terminate();
        await Promise.allSettled(active);
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await closed;
      })());
    },
  };
}

if (typeof require !== 'undefined' && require.main === module) {
  const app = createLiveApp({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseURL: process.env.OPENAI_BASE_URL,
  });
  app.server.listen(8000, '127.0.0.1', () =>
    console.log('Open http://localhost:8000'),
  );
  const stop = () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
