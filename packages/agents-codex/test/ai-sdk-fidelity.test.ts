import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { expect, it } from 'vitest';
import { AiSdkModel, type ModelRequest } from '../src/runtime/models';

function request(detail?: string, strict?: boolean): ModelRequest {
  return {
    body: {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: 'https://example.test/image.png',
              ...(detail === undefined ? {} : { detail }),
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Lookup.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
          ...(strict === undefined ? {} : { strict }),
        },
      ],
    },
    context: undefined,
    sessionId: 'session',
    turnId: 'turn',
    signal: new AbortController().signal,
  };
}

it.each(
  (['chat', 'responses'] as const).flatMap((endpoint) => [
    { endpoint, label: 'explicit', detail: 'high', strict: true },
    { endpoint, label: 'false', detail: 'low', strict: false },
    { endpoint, label: 'omitted', detail: undefined, strict: undefined },
  ]),
)(
  'preserves $label native image/function fields through real OpenAI $endpoint',
  async ({ endpoint, detail, strict }) => {
    const seen: any[] = [];
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify(
          endpoint === 'chat'
            ? {
                id: 'chat_fidelity',
                object: 'chat.completion',
                created: 0,
                model: 'gpt-4.1',
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'ok' },
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }
            : {
                id: 'resp_fidelity',
                object: 'response',
                created_at: 0,
                status: 'completed',
                model: 'gpt-4.1',
                output: [
                  {
                    type: 'message',
                    id: 'msg_fidelity',
                    status: 'completed',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: 'ok', annotations: [] },
                    ],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const provider = createOpenAI({
        apiKey: 'synthetic',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      });
      const real =
        endpoint === 'chat'
          ? provider.chat('gpt-4.1')
          : provider.responses('gpt-4.1');
      let projected: any;
      const model = new AiSdkModel({
        specificationVersion: real.specificationVersion,
        modelId: real.modelId,
        provider: real.provider,
        doGenerate(options) {
          projected = options;
          return real.doGenerate(options);
        },
      });
      await model.complete(request(detail, strict));
      expect(seen).toHaveLength(1);
      const wire = seen[0];
      const image =
        endpoint === 'chat'
          ? wire.messages[0].content[0].image_url
          : wire.input[0].content[0];
      const declaration =
        endpoint === 'chat' ? wire.tools[0].function : wire.tools[0];
      expect.soft(image.detail).toBe(detail);
      if (strict !== undefined) expect.soft(declaration.strict).toBe(strict);
      expect.soft(projected.tools[0].strict).toBe(strict);
      expect(Object.hasOwn(projected.tools[0], 'strict')).toBe(
        strict !== undefined,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each(['high', 'low'])(
  'rejects unmapped %s image detail before non-OpenAI provider work',
  async (detail) => {
    let calls = 0;
    const model = new AiSdkModel({
      specificationVersion: 'v4',
      modelId: 'other',
      provider: 'other.messages',
      doGenerate() {
        calls++;
        throw new Error('Unexpected provider work');
      },
    });
    await expect(model.complete(request(detail))).rejects.toThrow(
      /image detail/,
    );
    expect(calls).toBe(0);
  },
);

it.each(['v2', 'v3'] as const)(
  'projects native images into the %s file protocol',
  async (specificationVersion) => {
    const model = new AiSdkModel({
      specificationVersion,
      provider: 'other.messages',
      modelId: 'fixture',
      doGenerate(options) {
        expect(options.prompt[0].content[0]).toEqual({
          type: 'file',
          mediaType: 'image/*',
          data: new URL('https://example.test/image.png'),
        });
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
        };
      },
    });
    await model.complete(request());
  },
);

it('preserves native image URLs through the actual Anthropic v3 provider', async () => {
  const seen: any[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(
      JSON.stringify({
        id: 'msg_image',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const provider = createAnthropic({
      apiKey: 'fixture',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const real = provider('claude-sonnet-4-5');
    expect(real.specificationVersion).toBe('v3');
    await new AiSdkModel(real).complete(request());
    expect(seen).toHaveLength(1);
    expect(seen[0].messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/image.png' },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
