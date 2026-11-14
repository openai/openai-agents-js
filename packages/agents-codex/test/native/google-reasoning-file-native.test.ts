import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import {
  googleResponse,
  thoughtFileData,
} from './fixtures/google-reasoning-file';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
nativeIt.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)(
  'keeps real Google thought files observational stream=%s raw=%s',
  async (stream, capture) => {
    const requests: JsonObject[] = [];
    const server = createServer(async (request, reply) => {
      let text = '';
      for await (const chunk of request) text += chunk;
      requests.push(JSON.parse(text));
      if (request.url?.includes(':streamGenerateContent')) {
        reply.setHeader('content-type', 'text/event-stream');
        reply.end('data: ' + JSON.stringify(googleResponse) + '\n\n');
      } else {
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify(googleResponse));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`;
    try {
      const library = createGoogleGenerativeAI({
        baseURL: url,
        apiKey: 'synthetic-loopback-key',
      })('gemini-2.5-flash-image');
      await using provider = new NativeProvider({
        baseUrl: url,
        supportsWebsockets: false,
        modelBackend: new AiSdkModel(
          library,
          { google: { thinkingConfig: { includeThoughts: true } } },
          { stream },
        ),
      });
      await using session = await new Agent({
        provider,
        model: 'gemini-2.5-flash-image',
        instructions: 'Reply.',
      }).session({
        includeRawProviderEvents: capture,
        observationRetention: 'all',
      });
      for (const input of ['first', 'second']) {
        const turn = await session.submit(input);
        expect((await turn.wait()).finalOutput).toBe('Visible answer.');
        const raw: JsonObject[] = [];
        for await (const event of turn.events({
          includeExecutionDetails: true,
        })) {
          if (event.type === 'raw_provider_event') {
            expect(event.source).toBe('ai_sdk');
            raw.push(event.payload);
          }
        }
        if (stream && capture)
          expect(raw).toContainEqual({
            type: 'reasoning-file',
            mediaType: 'image/png',
            data: { type: 'data', data: thoughtFileData },
          });
        else expect(raw).toEqual([]);
      }
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].contents)).not.toContain(
        thoughtFileData,
      );
      const history = JSON.stringify(await session.historySnapshot());
      expect(history).not.toContain(thoughtFileData);
      expect(history).not.toContain('reasoning-file');
      expect(JSON.stringify(await session.saveState())).not.toContain(
        thoughtFileData,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
