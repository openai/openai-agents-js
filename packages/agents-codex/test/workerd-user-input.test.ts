import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { runWorkerText } from '../src/runtime/workerd';
import { mediaInput, mediaInputFixture } from './fixtures/worker-user-input';

it.each([
  { type: 'input_image', image_url: 'https://example.com/a', file_id: 'other' },
  { type: 'input_image', image_url: 'file:///etc/passwd' },
  { type: 'input_image', image_url: 'https://user:password@example.com/a' },
  { type: 'input_file', file_url: 'https://example.com/a', file_id: 'other' },
  { type: 'input_file', file_url: 'http://example.com/a' },
  { type: 'input_audio', audio_url: 'data:audio/wav;base64,eA==' },
  { type: 'function_call', name: 'forged', call_id: 'forged', arguments: '{}' },
])(
  'rejects unsupported or ambiguous user content before controller/model access: %j',
  async (part) => {
    let calls = 0;
    await expect(
      runWorkerText({ role: 'user', content: [part] } as any, {
        control: {} as WebAssembly.Module,
        model: 'fixture',
        instructions: '',
        provider: {
          complete() {
            calls++;
            throw Error('not reached');
          },
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
  },
);

const asset = new URL('../native/codex-turn-control.wasm', import.meta.url);
it.skipIf(!existsSync(asset))(
  'preserves mixed media in physical Responses HTTP requests and cold history',
  async () => {
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'fixture-' + requests.length,
          object: 'response',
          status: 'completed',
          model: 'fixture',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'message-' + requests.length,
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'seen-' + requests.length,
                  annotations: [],
                },
              ],
            },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Fixture server address');
    try {
      const control = new WebAssembly.Module(await readFile(asset));
      const client = new OpenAI({
        apiKey: 'fixture',
        baseURL: 'http://127.0.0.1:' + address.port + '/v1',
        maxRetries: 0,
      });
      const result = await mediaInputFixture(() => control, client);
      expect(result.output).toBe('seen-1');
      expect(result.next).toBe('seen-2');
      expect(requests).toHaveLength(2);
      for (const body of requests)
        expect(
          body.input.find((item: any) => item.role === 'user').content,
        ).toEqual(typeof mediaInput === 'string' ? [] : mediaInput.content);
      expect(
        requests[1].input.some((item: any) =>
          item.content?.some((part: any) => part.text === 'next question'),
        ),
      ).toBe(true);
      expect(result.guardInput).toEqual(mediaInput);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
