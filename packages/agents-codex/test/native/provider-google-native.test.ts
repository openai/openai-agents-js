import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';

it.each(['tool', 'text', 'vertex-tool', 'none'] as const)(
  'fences unsupported Google signed calls before native effects: %s',
  async (signaturePart) => {
    const signed = signaturePart !== 'none';
    const requests: any[] = [];
    const effects: number[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const final = body.contents.some((message: any) =>
        message.parts.some((part: any) => part.functionResponse),
      );
      if (signed && final) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: 'Missing thought signature',
              status: 'INVALID_ARGUMENT',
            },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: final
                  ? [{ text: '42' }]
                  : [
                      ...(signaturePart === 'text'
                        ? [
                            {
                              text: 'Use double.',
                              thoughtSignature: 'opaque-google-signature',
                            },
                          ]
                        : []),
                      {
                        functionCall: {
                          id: 'google_double',
                          name: 'double',
                          args: { value: 21 },
                        },
                        ...(signaturePart.endsWith('tool')
                          ? { thoughtSignature: 'opaque-google-signature' }
                          : {}),
                      },
                    ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
            totalTokenCount: 5,
          },
          modelVersion: 'gemini-3-flash-preview',
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing address');
    const baseURL = `http://127.0.0.1:${address.port}`;
    try {
      const google = createGoogleGenerativeAI({
        apiKey: 'fixture',
        baseURL,
        ...(signaturePart === 'vertex-tool'
          ? { name: 'vertex.generative-ai' }
          : {}),
      });
      const backend = new AiSdkModel(google('gemini-3-flash-preview'));
      const double = tool({
        name: 'double',
        description: 'Double a number.',
        parameters: z.object({ value: z.number() }),
        execute: ({ value }) => {
          effects.push(value);
          return value * 2;
        },
      });
      await using provider = new NativeProvider({
        baseUrl: `${baseURL}/fallback`,
        modelBackend: backend,
      });
      await using session = await new Agent({
        model: 'gpt-4.1',
        instructions: 'Use double.',
        tools: [double],
        provider,
      }).session();
      const turn = await session.submit('Double21.');
      if (signed) {
        const failure = await turn.wait().then(
          () => undefined,
          (error: Error) => error,
        );
        expect({
          error: failure?.message,
          effects,
          requests: requests.length,
        }).toEqual({
          error: 'AiSdkModel does not support Google thought signatures',
          effects: [],
          requests: 1,
        });
      } else {
        expect((await turn.wait()).finalOutput).toBe('42');
        expect(effects).toEqual([21]);
        expect(requests).toHaveLength(2);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
