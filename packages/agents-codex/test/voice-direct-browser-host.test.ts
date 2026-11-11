import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it.skipIf(
  process.env.OPENAI_AGENTS_PORTABLE_TESTS !== '1' ||
    process.env.OPENAI_AGENTS_BROWSER_TESTS !== '1',
)(
  'executes Rust-owned direct voice over actual browser WebRTC and default playback',
  async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const bundled = await build({
      stdin: {
        contents: `export {NativeVoiceControl} from ${JSON.stringify(resolve('packages/agents-codex/src/voice/portable.ts'))}; export {connectPortableVoiceBrowser} from ${JSON.stringify(resolve('packages/agents-codex/src/voice/browser.ts'))};`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'DirectVoice',
      write: false,
    });
    const wasm = await readFile(
      process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!,
    );
    const server = createServer((request, response) => {
      if (request.url === '/control.wasm') {
        response.setHeader('Content-Type', 'application/wasm');
        response.end(wasm);
      } else
        response.end('<!doctype html><title>Direct voice acceptance</title>');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
        args: [
          '--no-sandbox',
          // The local fixture must also work on loopback-only test hosts.
          '--allow-loopback-in-peer-connection',
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
        ],
      });
      const page = await browser.newPage();

      await page.goto(`http://127.0.0.1:${port}`, { timeout: 5000 });

      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      const result = await page.evaluate(async () => {
        const api = (globalThis as any).DirectVoice;
        const module = await WebAssembly.compileStreaming(
          fetch('/control.wasm'),
        );
        const originalFetch = globalThis.fetch;
        const remote = new RTCPeerConnection();
        const frames: any[] = [];
        const audio: HTMLAudioElement[] = [];
        const createElement = document.createElement.bind(document);
        (document as any).createElement = (tag: string) => {
          const element = createElement(tag);
          if (tag === 'audio') audio.push(element as HTMLAudioElement);
          return element;
        };
        const gathered = (peer: RTCPeerConnection) =>
          peer.iceGatheringState === 'complete'
            ? Promise.resolve()
            : new Promise<void>((resolve) =>
                peer.addEventListener('icegatheringstatechange', () => {
                  if (peer.iceGatheringState === 'complete') resolve();
                }),
              );
        const audioContext = new AudioContext();
        const oscillator = audioContext.createOscillator();
        const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        remote.addTrack(
          destination.stream.getAudioTracks()[0],
          destination.stream,
        );
        await audioContext.resume();
        remote.ondatachannel = ({ channel }) => {
          channel.onmessage = ({ data }) => {
            const event = JSON.parse(data);
            frames.push(event);
            if (event.type === 'session.update') {
              channel.send(
                JSON.stringify({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
              channel.send(
                JSON.stringify({
                  type: 'response.created',
                  response: { id: 'browser-response' },
                }),
              );
              channel.send(
                JSON.stringify({
                  type: 'response.done',
                  response: {
                    id: 'browser-response',
                    status: 'completed',
                    output: [
                      {
                        type: 'function_call',
                        id: 'browser-item',
                        call_id: 'browser-call',
                        name: 'lookup',
                        arguments: '{"value":7}',
                      },
                    ],
                  },
                }),
              );
            }
          };
        };
        globalThis.fetch = async (_url, init) => {
          await remote.setRemoteDescription({
            type: 'offer',
            sdp: String(init?.body),
          });
          await remote.setLocalDescription(await remote.createAnswer());

          await gathered(remote);

          return new Response(remote.localDescription!.sdp);
        };
        let channelOpened = 0;
        let channelMessages = 0;
        let executions = 0;
        let approvals = 0;
        let credentialResolutions = 0;

        const call = await api.connectPortableVoiceBrowser({
          control: new api.NativeVoiceControl(module),
          apiKey: async () => {
            credentialResolutions++;
            return 'ek_synthetic-browser';
          },
          agent: {
            model: 'test',
            instructions: async () => 'Browser instructions',
            tools: [
              {
                name: 'lookup',
                description: 'Lookup',
                parameters: { type: 'object' },
                needsApproval: true,
                execute: (args: any, _signal: any, context: any) => {
                  executions++;
                  return `browser ${args.value} ${context.history.length}`;
                },
              },
            ],
            onApproval: async () => {
              approvals++;
              return true;
            },
          },
          signal: AbortSignal.timeout(18000),
          media: {
            onDataChannel(channel: RTCDataChannel) {
              channel.onopen = () => {
                channelOpened++;
              };
              channel.onmessage = () => {
                channelMessages++;
              };
            },
            onTransportEvent: async () => {
              throw new Error('application analytics unavailable');
            },
          },
        });
        try {
          const deadline = Date.now() + 10000;
          while (
            (!frames.some(
              (frame) => frame.item?.type === 'function_call_output',
            ) ||
              !audio.length ||
              audio[0].paused) &&
            Date.now() < deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 20));
          const result = {
            channelOpened,
            channelObserved: channelMessages > 0,
            executions,
            approvals,
            credentialResolutions,
            output: frames.find(
              (frame) => frame.item?.type === 'function_call_output',
            )?.item.output,
            playing: audio.length === 1 && !audio[0].paused,
            tracks: remote
              .getReceivers()
              .map((receiver) => receiver.track.kind),
          };
          await call.session.close();
          return {
            ...result,
            closed: call.media.status === 'closed',
            audioReleased: audio[0]?.srcObject === null,
          };
        } finally {
          await call.session.close();
          remote.close();
          globalThis.fetch = originalFetch;
          oscillator.stop();
          await audioContext.close();
        }
      });
      expect(result).toEqual({
        channelOpened: 1,
        channelObserved: true,
        executions: 1,
        approvals: 1,
        credentialResolutions: 1,
        output: 'browser 7 1',
        playing: true,
        tracks: ['audio'],
        closed: true,
        audioReleased: true,
      });
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  45_000,
);
