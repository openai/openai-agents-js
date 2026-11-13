import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';

it.each(['tool', 'text', 'vertex-tool', 'none'] as const)(
  'round-trips Google thought signatures on their original parts: %s',
  async (signaturePart) => {
    const signature = 'opaque-google-signature';
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
      const signedParts = body.contents
        .filter((message: any) => message.role === 'model')
        .flatMap((message: any) => message.parts)
        .filter((part: any) => part.thoughtSignature === signature);
      const matches =
        signaturePart === 'none'
          ? signedParts.length === 0
          : signedParts.length === 1 &&
            (signaturePart === 'text'
              ? signedParts[0].text === 'Use double.'
              : signedParts[0].functionCall?.name === 'double');
      if (final && !matches) {
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
                              thoughtSignature: signature,
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
                          ? { thoughtSignature: signature }
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
      expect((await turn.wait()).finalOutput).toBe('42');
      expect(effects).toEqual([21]);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(await session.historySnapshot())).not.toContain(
        signature,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
