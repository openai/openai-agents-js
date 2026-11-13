import { bindModelProviderMetadata } from '../src/runtime/model-provider-metadata';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { nativeInput } from '../src/runtime/input';
import { expect, it } from 'vitest';
import { AiSdkModel, type ModelRequest } from '../src/runtime/models';
import type { JsonObject } from '../src/runtime/binding';

function request(
  detail?: string,
  strict?: boolean,
  imageUrl = 'https://example.test/image.png',
): ModelRequest {
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
              image_url: imageUrl,
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

it('groups normalized Responses summaries under their original reasoning item', async () => {
  const adapter = new AiSdkModel({
    specificationVersion: 'v4',
    modelId: 'fixture-reasoning',
    provider: 'openai.responses',
    doGenerate() {
      return {
        finishReason: { unified: 'stop' },
        content: [
          {
            type: 'reasoning',
            text: 'First summary.',
            providerMetadata: { openai: { itemId: 'rs_buffered' } },
          },
          {
            type: 'reasoning',
            text: 'Second summary.',
            providerMetadata: {
              openai: {
                itemId: 'rs_buffered',
                reasoningEncryptedContent: 'fixture-ciphertext',
              },
            },
          },
          { type: 'text', text: 'Final answer.' },
        ],
      };
    },
  });
  const result = await adapter.complete(request());
  expect(result.output).toEqual([
    {
      type: 'reasoning',
      id: 'rs_buffered',
      summary: [
        { type: 'summary_text', text: 'First summary.' },
        { type: 'summary_text', text: 'Second summary.' },
      ],
      encrypted_content: 'fixture-ciphertext',
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Final answer.' }],
    },
  ]);
});

it('routes native workspace patches through a function-only AI SDK provider', async () => {
  const patch =
    '*** Begin Patch\n*** Add File: report.txt\n+done\n*** End Patch';
  const requests: JsonObject[] = [];
  const provider = createOpenAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      requests.push(body);
      const initial = requests.length === 1;
      return Response.json({
        id: 'chat_patch',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: initial ? 'tool_calls' : 'stop',
            message: initial
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_patch',
                      type: 'function',
                      function: {
                        name: 'apply_patch',
                        arguments: JSON.stringify({ patch }),
                      },
                    },
                  ],
                }
              : { role: 'assistant', content: 'done' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const adapter = new AiSdkModel(provider.chat('gpt-4.1'));
  const complete = (history: JsonObject[]) =>
    adapter.complete({
      ...request(),
      body: {
        model: 'gpt-4.1',
        input: [
          ...history,
          {
            type: 'additional_tools',
            tools: [
              {
                type: 'namespace',
                name: 'functions',
                tools: [{ type: 'custom', name: 'apply_patch' }],
              },
            ],
          },
        ],
        tool_choice: {
          type: 'custom',
          name: 'apply_patch',
          namespace: 'functions',
        },
      },
    });

  const first = await complete([]);
  expect(first.output).toEqual([
    {
      type: 'custom_tool_call',
      call_id: 'call_patch',
      name: 'apply_patch',
      input: patch,
    },
  ]);
  expect(requests[0]).toMatchObject({
    tools: [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          parameters: { properties: { patch: { type: 'string' } } },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'apply_patch' } },
  });

  const resumed = await complete([
    ...(first.output as JsonObject[]),
    {
      type: 'custom_tool_call_output',
      call_id: 'call_patch',
      output: 'patched',
    },
  ]);
  expect(requests[1]?.messages).toMatchObject([
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_patch',
          type: 'function',
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({ patch }),
          },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_patch', content: 'patched' },
  ]);
  expect(resumed.output).toEqual([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    },
  ]);
});

it.each(['raw', 'structured', 'invalid structured'] as const)(
  'converts a %s AI SDK Responses workspace patch',
  async (kind) => {
    const patch =
      '*** Begin Patch\n*** Add File: report.txt\n+done\n*** End Patch';
    const operation = {
      type: 'create_file',
      path: 'report.txt',
      diff:
        kind === 'invalid structured'
          ? '+done\n*** Delete File: other.txt'
          : '+done',
    };
    const argumentsText = JSON.stringify(
      kind === 'raw' ? { patch } : { operation },
    );
    const provider = createOpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as JsonObject;
        expect(body.text).toMatchObject({ verbosity: 'low' });
        expect(body.tools).toMatchObject([
          {
            type: 'function',
            name: 'apply_patch',
            parameters: {
              properties: {
                patch: { type: 'string' },
                operation: expect.any(Object),
              },
            },
          },
        ]);
        return Response.json({
          id: 'resp_patch',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'gpt-4.1',
          output: [
            {
              type: 'function_call',
              id: 'fc_patch',
              status: 'completed',
              call_id: 'call_patch',
              name: 'apply_patch',
              arguments: argumentsText,
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const adapter = new AiSdkModel(provider.responses('gpt-4.1'));
    const response = await adapter.complete({
      ...request(),
      body: {
        model: 'gpt-4.1',
        input: [],
        text: { verbosity: 'low' },
        tools: [{ type: 'custom', name: 'apply_patch' }],
        tool_choice: { type: 'custom', name: 'apply_patch' },
      },
    });

    expect(response.output).toEqual([
      {
        type: 'custom_tool_call',
        id: 'fc_patch',
        status: 'completed',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: kind === 'invalid structured' ? '' : patch,
      },
    ]);
  },
);

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

const imageCases = [
  {
    label: 'http',
    imageUrl: 'http://example.test/image.png',
    mediaType: 'image/*',
    data: undefined,
  },
  {
    label: 'https',
    imageUrl: 'https://example.test/image.png',
    mediaType: 'image/*',
    data: undefined,
  },
  {
    label: 'png-inline',
    imageUrl: 'data:image/png;base64,AAEC',
    mediaType: 'image/png',
    data: 'AAEC',
  },
  {
    label: 'jpeg-inline-parameters',
    imageUrl: 'data:image/jpeg;charset=utf-8;base64,AQID',
    mediaType: 'image/jpeg',
    data: 'AQID',
  },
  {
    label: 'png-inline-unpadded',
    imageUrl: 'data:image/png;base64,AQI',
    mediaType: 'image/png',
    data: 'AQI',
  },
];
it.each(
  (['v2', 'v3', 'v4'] as const).flatMap((specificationVersion) =>
    imageCases.map((image) => ({ specificationVersion, ...image })),
  ),
)(
  'projects $label into the $specificationVersion image protocol',
  async ({ specificationVersion, imageUrl, mediaType, data }) => {
    const value = data ?? new URL(imageUrl);
    const model = new AiSdkModel({
      specificationVersion,
      provider: 'other.messages',
      modelId: 'fixture',
      doGenerate(options) {
        expect(options.prompt[0].content[0]).toEqual({
          type: 'file',
          mediaType,
          data:
            specificationVersion === 'v4'
              ? typeof value === 'string'
                ? { type: 'data', data: value }
                : { type: 'url', url: value }
              : value,
        });
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
        };
      },
    });
    await model.complete(request(undefined, undefined, imageUrl));
  },
);
it.each(
  imageCases
    .map((image) => ({ endpoint: 'anthropic-v3', ...image }))
    .concat(
      imageCases
        .filter((image) => image.data !== undefined)
        .map((image) => ({ endpoint: 'google-v4', ...image })),
    ),
)(
  'preserves $label through actual $endpoint image wire conversion',
  async ({ endpoint, imageUrl, mediaType, data }) => {
    const seen: any[] = [];
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify(
          endpoint === 'anthropic-v3'
            ? {
                id: 'msg_image',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-5',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                candidates: [
                  {
                    content: { role: 'model', parts: [{ text: 'ok' }] },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 1,
                  candidatesTokenCount: 1,
                  totalTokenCount: 2,
                },
              },
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const options = {
        apiKey: 'fixture',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      };
      const real =
        endpoint === 'anthropic-v3'
          ? createAnthropic(options)('claude-sonnet-4-5')
          : createGoogleGenerativeAI(options)('gemini-2.5-flash');
      await new AiSdkModel(real).complete(
        request(undefined, undefined, imageUrl),
      );
      expect(seen).toHaveLength(1);
      if (endpoint === 'anthropic-v3')
        expect(seen[0].messages[0].content[0]).toEqual({
          type: 'image',
          source:
            data === undefined
              ? { type: 'url', url: imageUrl }
              : { type: 'base64', media_type: mediaType, data },
        });
      else
        expect(seen[0].contents[0].parts[0]).toEqual({
          inlineData: { mimeType: mediaType, data },
        });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
it.each(['AAEC', [0, 1, 2], new Uint8Array([0, 1, 2]), 'data:image/png,AAEC'])(
  'keeps unadmitted raw/byte/malformed image forms outside native input',
  (image_url) => {
    expect(() =>
      nativeInput({
        role: 'user',
        content: [{ type: 'input_image', image_url }],
      } as any),
    ).toThrow();
  },
);

it.each(['v2', 'v3', 'v4'] as const)(
  'projects admitted file parts to AI SDK %s',
  async (specificationVersion) => {
    const reachedProvider = new Error('Synthetic provider boundary');
    let prompt: unknown;
    const adapter = new AiSdkModel(
      {
        specificationVersion,
        modelId: 'fixture-file-model',
        provider: 'fixture.files',
        doGenerate(options) {
          prompt = options.prompt;
          throw reachedProvider;
        },
      },
      {},
      {
        resolveFileOptions(file) {
          if (file.filename !== 'typed.json') return;
          return {
            mediaType: 'application/json',
            providerOptions: { fixture: { source: 'declared' } },
          };
        },
      },
    );
    const fileUrl = new URL('https://example.test/report.pdf?version=1');
    const typedUrl = new URL('https://example.test/document');
    const input: JsonObject[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            file_data: 'data:text/plain;charset=utf-8;base64,YQ==',
            filename: 'note.txt',
          },
          { type: 'input_file', file_data: 'Yg==', filename: 'Raw.PDF' },
          { type: 'input_file', file_url: fileUrl.href },
          {
            type: 'input_file',
            file_url: typedUrl.href,
            filename: 'typed.json',
          },
        ],
      },
    ];
    await expect(
      adapter.complete({
        ...request(),
        body: { model: 'fixture-file-model', input },
      }),
    ).rejects.toBe(reachedProvider);
    const versioned = (data: string | URL) =>
      specificationVersion !== 'v4'
        ? data
        : typeof data === 'string'
          ? { type: 'data', data }
          : { type: 'url', url: data };
    expect(prompt).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: versioned('YQ=='),
            mediaType: 'text/plain',
            filename: 'note.txt',
          },
          {
            type: 'file',
            data: versioned('Yg=='),
            mediaType: 'application/pdf',
            filename: 'Raw.PDF',
          },
          {
            type: 'file',
            data: versioned(fileUrl),
            mediaType: 'application/pdf',
          },
          {
            type: 'file',
            data: versioned(typedUrl),
            mediaType: 'application/json',
            filename: 'typed.json',
            providerOptions: { fixture: { source: 'declared' } },
          },
        ],
      },
    ]);
  },
);

it.each([
  [{ file_id: 'file_fixture' }, 'does not support provider file IDs'],
  [
    { file_url: 'http://example.test/report.pdf' },
    'Unsupported media URL scheme',
  ],
  [{ file_data: 'YQ==' }, 'file inputs require a media type'],
  [
    { file_data: 'data:;base64,YQ==', filename: 'report.pdf' },
    'file inputs require a media type',
  ],
] as const)(
  'rejects unsupported AI SDK file reference %j',
  async (file, error) => {
    const adapter = new AiSdkModel({
      specificationVersion: 'v3',
      modelId: 'fixture-file-model',
      provider: 'fixture.files',
      doGenerate() {
        throw new Error('Unsupported file reached the provider');
      },
    });
    await expect(
      adapter.complete({
        ...request(),
        body: {
          model: 'fixture-file-model',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_file', ...file }],
            },
          ],
        },
      }),
    ).rejects.toThrow(error);
  },
);

it('forwards owned text metadata into the real Google provider wire without changing caller data', async () => {
  const requests: any[] = [];
  const google = createGoogleGenerativeAI({
    apiKey: 'synthetic',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: 'continued' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      });
    },
  });
  const model = google('gemini-2.5-flash');
  const item = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'first answer' }],
  };
  const request: ModelRequest = {
    body: {
      model: model.modelId,
      input: [
        item,
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    },
    sessionId: 'session',
    turnId: 'turn',
    context: undefined,
    signal: new AbortController().signal,
  };
  const metadata = {
    google: { thoughtSignature: 'synthetic-owned-signature' },
  };
  bindModelProviderMetadata(request, [
    {
      input_index: 0,
      item,
      metadata: {
        provider: model.provider,
        model: model.modelId,
        value: metadata,
      },
    },
  ]);
  const adapter = new AiSdkModel(model);
  expect((await adapter.complete(request)).output).toMatchObject([
    { type: 'message', content: [{ type: 'output_text', text: 'continued' }] },
  ]);
  expect(requests[0].contents).toEqual([
    {
      role: 'model',
      parts: [
        { text: 'first answer', thoughtSignature: 'synthetic-owned-signature' },
      ],
    },
    { role: 'user', parts: [{ text: 'continue' }] },
  ]);
  expect(metadata).toEqual({
    google: { thoughtSignature: 'synthetic-owned-signature' },
  });
  expect(JSON.stringify(request)).not.toContain('synthetic-owned-signature');
});

it('preserves the real OpenAI reasoning and tool wire order across private message scopes', async () => {
  const requests: any[] = [];
  const openai = createOpenAI({
    apiKey: 'synthetic',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'resp_done',
        model: 'gpt-5',
        created_at: 0,
        status: 'completed',
        output: [
          {
            id: 'msg_done',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const metadata = {
    openai: {
      itemId: 'rs_original',
      reasoningEncryptedContent: 'fixture-ciphertext',
    },
  };
  const reasoning = ['Check the record.', 'Confirm the match.'].map((text) => ({
    type: 'reasoning' as const,
    text,
    providerOptions: metadata,
  }));
  const tool = {
    type: 'tool-call' as const,
    toolCallId: 'call_lookup',
    toolName: 'lookup',
    input: {},
  };
  await openai.responses('gpt-5').doGenerate({
    providerOptions: { openai: { store: false } },
    prompt: [{ role: 'assistant', content: [...reasoning, tool] }],
  });
  await openai.responses('gpt-5').doGenerate({
    providerOptions: { openai: { store: false } },
    prompt: [
      { role: 'assistant', content: reasoning, providerOptions: metadata },
      { role: 'assistant', content: [tool] },
    ],
  });
  expect(requests[1].input).toEqual(requests[0].input);
  expect(requests[1].input).toEqual([
    {
      type: 'reasoning',
      id: 'rs_original',
      encrypted_content: 'fixture-ciphertext',
      summary: [
        { type: 'summary_text', text: 'Check the record.' },
        { type: 'summary_text', text: 'Confirm the match.' },
      ],
    },
    {
      type: 'function_call',
      call_id: 'call_lookup',
      name: 'lookup',
      arguments: '{}',
    },
  ]);
});
