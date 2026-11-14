import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, ChatCompletionsModel, NativeProvider, tool } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { chatFrames, opaque } from './fixtures/chat-opaque-sse';
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
nativeIt.each([
  ['before', false],
  ['before', true],
  ['between', false],
  ['between', true],
  ['after', false],
  ['after', true],
  ['none', true],
  ['terminal', true],
] as const)(
  'keeps actual Chat opaque SSE observational position=%s raw=%s',
  async (position, capture) => {
    const bodies: JsonObject[] = [];
    const events = chatFrames(position);
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body));
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        events
          .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
          .join('') + 'data: [DONE]\n\n',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    let effects = 0;
    try {
      const backend = new ChatCompletionsModel(
        new OpenAI({
          baseURL: base,
          apiKey: 'synthetic-loopback-key',
          maxRetries: 0,
        }),
        'gpt-4.1',
        { stream: true },
      );
      await using provider = new NativeProvider({
        baseUrl: base,
        modelBackend: backend,
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        provider,
        model: 'gpt-4.1',
        instructions: 'Reply.',
        tools: [
          tool({
            name: 'forbidden',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'unexpected';
            },
          }),
        ],
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
        }))
          if (event.type === 'raw_provider_event') {
            expect(event.source).toBe('chat_completions');
            raw.push(event.payload);
          }
        expect(raw).toEqual(capture ? events : []);
      }
      expect(effects).toBe(0);
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1].messages)).not.toContain(
        opaque.extension.marker,
      );
      expect(JSON.stringify(await session.saveState())).not.toContain(
        opaque.extension.marker,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);

nativeIt.each([
  'changed-id',
  'missing-choices',
  'multiple-choices',
  'array',
] as const)(
  'retains known Chat protocol rejection (%s)',
  async (mode) => {
    const [start, end] = chatFrames('none');
    let events: unknown[];
    if (mode === 'changed-id')
      events = [start, { ...end, id: 'different_response' }];
    else if (mode === 'missing-choices')
      events = [
        { id: 'chatcmpl_fixture', object: 'chat.completion.chunk' },
        end,
      ];
    else if (mode === 'multiple-choices')
      events = [
        {
          id: 'chatcmpl_fixture',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { content: 'first' } },
            { index: 1, delta: { content: 'second' } },
          ],
        },
        end,
      ];
    else events = [['invalid chunk'], start, end];
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Read the request body before sending the fixture response.
      }
      requests++;
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        events
          .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
          .join('') + 'data: [DONE]\n\n',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      await using provider = new NativeProvider({
        baseUrl: base,
        supportsWebsockets: false,
        modelBackend: new ChatCompletionsModel(
          new OpenAI({
            baseURL: base,
            apiKey: 'synthetic-loopback-key',
            maxRetries: 0,
          }),
          'gpt-4.1',
          { stream: true },
        ),
      });
      await using session = await new Agent({
        provider,
        model: 'gpt-4.1',
        instructions: 'Reply.',
      }).session({ includeRawProviderEvents: true });
      await expect((await session.submit('first')).wait()).rejects.toThrow(
        TypeError,
      );
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
