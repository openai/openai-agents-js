import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { Agent, NativeProvider } from '@openai/agents';
import { startWebStarter } from '../../../../examples/codex/web-starter/server';

// Node 22 warns when SQLite is first imported. Expect only that import diagnostic;
// restore normal warning handling before any test executes.
const restoreSqliteWarning = vi.hoisted(() => {
  const emitWarning = process.emitWarning;
  const warning = vi
    .spyOn(process, 'emitWarning')
    .mockImplementation((...args: unknown[]) => {
      if (
        args[0] ===
          'SQLite is an experimental feature and might change at any time' &&
        args[1] === 'ExperimentalWarning' &&
        args.slice(2).every((argument) => argument === undefined)
      )
        return;
      Reflect.apply(emitWarning, process, args);
    });
  return () => warning.mockRestore();
});
restoreSqliteWarning();

const exec = promisify(execFile);
const browserIt = it.skipIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
    process.env.OPENAI_AGENTS_BROWSER_TESTS !== '1',
);
const executablePath = process.env.CHROMIUM_PATH ?? chromium.executablePath();

describe('real browser native acceptance', () => {
  browserIt(
    'correlates browser approval to an issued native request using the existing witness',
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'agents-browser-interaction-'),
      );
      const app = await startWebStarter({ directory });
      try {
        const result = await exec(
          process.execPath,
          [resolve('examples/codex/web-starter/browser-check.mjs'), app.url],
          {
            env: { ...process.env, CHROMIUM_PATH: executablePath },
            timeout: 90_000,
          },
        );
        expect(result.stdout).toContain(
          'approval settles typed result and rejects token replay',
        );
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    100_000,
  );

  browserIt(
    'captures a fake microphone and plays actual browser peer audio through native WebRTC ownership',
    async () => {
      const client = await readFile(
        resolve('examples/codex/browser-acceptance/realtime-client.mjs'),
      );
      const sdkRoot = resolve('packages/agents-codex/dist');
      const offers: string[] = [];
      const hangups: string[] = [];
      const sidebands: string[] = [];
      const failures: unknown[] = [];
      let answerSdp = '';
      let accepted: Record<string, unknown> | undefined;
      let session: Awaited<ReturnType<Agent['session']>> | undefined;
      let voice:
        | Awaited<ReturnType<NonNullable<typeof session>['realtime']>>
        | undefined;
      const server = createServer(async (request, response) => {
        try {
          const path = new URL(request.url!, 'http://localhost').pathname;
          const sdkModule = /^\/sdk\/(voice|runtime)\/([\w-]+\.mjs)$/.exec(
            path,
          );
          if (path === '/') {
            response
              .writeHead(200, { 'content-type': 'text/html' })
              .end(
                '<button>Connect</button><audio autoplay></audio><script type="module" src="/client.mjs"></script>',
              );
          } else if (request.method === 'GET' && path === '/client.mjs') {
            response
              .writeHead(200, { 'content-type': 'text/javascript' })
              .end(client);
          } else if (request.method === 'GET' && sdkModule) {
            const script = await readFile(
              join(sdkRoot, sdkModule[1], sdkModule[2]),
            );
            response
              .writeHead(200, { 'content-type': 'text/javascript' })
              .end(script);
          } else if (request.method === 'POST' && path === '/exchange') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const input = JSON.parse(Buffer.concat(chunks).toString());
            answerSdp = input.answerSdp;
            voice = await session!.realtime({
              model: 'synthetic-browser-realtime',
              transport: { type: 'webrtc', offerSdp: input.offerSdp },
            });
            response
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ answerSdp: voice.answerSdp }));
          } else if (request.method === 'POST' && path === '/close') {
            await voice!.close();
            response.writeHead(200).end();
          } else if (
            request.method === 'POST' &&
            path === '/v1/realtime/calls'
          ) {
            expect(request.headers.authorization).toBe(
              'Bearer synthetic-browser-key',
            );
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const form = await new Response(
              new Uint8Array(Buffer.concat(chunks)),
              {
                headers: { 'content-type': request.headers['content-type']! },
              },
            ).formData();
            const value = async (name: string) => {
              const part = form.get(name)!;
              return typeof part === 'string' ? part : part.text();
            };
            offers.push(await value('sdp'));
            accepted = JSON.parse(await value('session'));
            response
              .writeHead(200, {
                'content-type': 'application/sdp',
                location: '/v1/realtime/calls/rtc_browser',
              })
              .end(answerSdp);
          } else if (
            request.method === 'POST' &&
            path === '/v1/realtime/calls/rtc_browser/hangup'
          ) {
            hangups.push('rtc_browser');
            response.writeHead(200).end();
          } else response.writeHead(404).end();
        } catch (error) {
          failures.push(error);
          response.writeHead(500).end('Synthetic fixture failed');
        }
      });
      const sockets = new WebSocketServer({ server, path: '/v1/realtime' });
      sockets.on('connection', (socket, request) => {
        const callId = new URL(
          request.url!,
          'http://localhost',
        ).searchParams.get('call_id');
        sidebands.push(callId!);
        socket.send(
          JSON.stringify({
            type: 'session.created',
            session: { ...accepted, id: 'session-browser' },
          }),
        );
        socket.on('message', (raw) => {
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'session.update') {
            Object.assign(accepted!, frame.session);
            socket.send(
              JSON.stringify({
                type: 'session.updated',
                session: { ...accepted, id: 'session-browser' },
              }),
            );
          }
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing server address');
      const origin = `http://127.0.0.1:${address.port}`;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      await using provider = new NativeProvider({
        baseUrl: `${origin}/v1`,
        apiKey: 'synthetic-browser-key',
        supportsWebsockets: false,
      });
      try {
        const agent = new Agent({
          instructions: 'Answer the microphone.',
          model: 'gpt-5.5',
          provider,
        });
        session = await agent.session();
        browser = await chromium.launch({
          executablePath,
          headless: true,
          chromiumSandbox: true,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        });
        const context = await browser.newContext({
          permissions: ['microphone'],
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (response) => {
          if (
            response.request().resourceType() === 'script' &&
            !response.ok()
          ) {
            errors.push(`Script HTTP ${response.status()}: ${response.url()}`);
          }
        });
        page.on('requestfailed', (request) => {
          if (request.resourceType() === 'script') {
            errors.push(
              `Script request failed: ${request.url()}: ${request.failure()?.errorText}`,
            );
          }
        });
        await page.goto(origin);
        await page.getByRole('button', { name: 'Connect' }).click();
        const observed = await page.evaluate(
          async () => await (window as any).acceptance,
        );
        expect(
          observed,
          [observed?.error, ...errors].filter(Boolean).join('\n'),
        ).toMatchObject({
          ok: true,
          result: { mutedAndRestored: true, closed: true },
        });
        expect(observed.result.microphoneBytes).toBeGreaterThan(0);
        expect(observed.result.playbackTime).toBeGreaterThan(0);
        expect(errors).toEqual([]);
        expect(offers).toHaveLength(1);
        expect(offers[0]).toContain('m=audio');
        expect(sidebands).toEqual(['rtc_browser']);
        expect(hangups).toEqual(['rtc_browser']);
        expect(await session.getActiveAgent()).toBe(agent);
        expect(failures).toEqual([]);
      } finally {
        await browser?.close();
        await voice?.close();
        await session?.close();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60_000,
  );
});
