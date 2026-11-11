import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';
import { APIUserAbortError } from 'openai';
import { expect, it } from 'vitest';
import {
  AiSdkModel,
  ResponsesModel,
  type ModelRequest,
} from '../src/runtime/models';

// Real provider conversion has been retaining wire semantics absent from a model double.
it.each([
  'image',
  'parallel',
  'responses-incomplete',
  'responses-refusal',
] as const)(
  'retains native %s input through the real AI SDK provider',
  async (scenario) => {
    const seen: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      const pending = new Set<string>();
      for (const item of body.messages ?? []) {
        if (item.role === 'tool') pending.delete(item.tool_call_id);
        else {
          if (pending.size) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                error: {
                  message: 'Missing parallel tool results',
                  type: 'invalid_request_error',
                },
              }),
            );
            return;
          }
          for (const call of item.tool_calls ?? []) pending.add(call.id);
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      if (scenario.startsWith('responses-')) {
        response.end(
          JSON.stringify({
            id: 'resp_synthetic',
            status: 'incomplete',
            output:
              scenario === 'responses-refusal'
                ? [
                    {
                      type: 'message',
                      id: 'refused',
                      role: 'assistant',
                      status: 'completed',
                      content: [
                        {
                          type: 'refusal',
                          refusal: 'synthetic-private-refusal',
                        },
                      ],
                    },
                  ]
                : [
                    {
                      type: 'function_call',
                      id: 'pending',
                      call_id: 'pending',
                      name: 'lookup',
                      arguments: '{}',
                      status: 'completed',
                    },
                  ],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              total_tokens: 5,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: 'synthetic',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'done' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing peer');
    try {
      const provider = createOpenAI({
        apiKey: 'synthetic',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      });
      const model = new AiSdkModel(
        scenario.startsWith('responses-')
          ? provider.responses('gpt-4.1')
          : provider.chat('gpt-4.1'),
      );
      const image = 'data:image/png;base64,AA==';
      const input: ModelRequest['body']['input'] =
        scenario === 'image'
          ? [
              {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: 'Describe.' },
                  { type: 'input_image', image_url: image },
                ],
              },
            ]
          : [
              {
                type: 'function_call',
                call_id: 'a',
                name: 'lookup',
                arguments: '{}',
              },
              {
                type: 'function_call',
                call_id: 'b',
                name: 'lookup',
                arguments: '{}',
              },
              { type: 'function_call_output', call_id: 'a', output: 'one' },
              { type: 'function_call_output', call_id: 'b', output: 'two' },
            ];
      const completion = model.complete({
        body: { model: 'gpt-4.1', input },
        context: undefined,
        sessionId: 'session',
        turnId: 'turn',
        signal: new AbortController().signal,
      } as ModelRequest);
      if (scenario === 'responses-incomplete') {
        await expect(completion).rejects.toThrow(/completed response/);
        return;
      }
      const result = await completion;
      if (scenario === 'responses-refusal') {
        expect(JSON.stringify(result.output)).toContain(
          'synthetic-private-refusal',
        );
        return;
      }
      expect(JSON.stringify(result.output)).toContain('done');
      expect(seen).toHaveLength(1);
      if (scenario === 'image')
        expect(seen[0].messages[0].content).toContainEqual({
          type: 'image_url',
          image_url: { url: image },
        });
      else
        expect(
          seen[0].messages[0].tool_calls.map((call: any) => call.id),
        ).toEqual(['a', 'b']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each(['v2', 'v3', 'v4'] as const)(
  'retains %s token accounting without changing the borrowed model',
  async (specificationVersion) => {
    const model = {
      specificationVersion,
      provider: 'synthetic.provider',
      modelId: 'synthetic',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'accounted' }],
        finishReason:
          specificationVersion === 'v2' ? 'stop' : { unified: 'stop' },
        usage:
          specificationVersion === 'v2'
            ? {
                inputTokens: 5,
                outputTokens: 3,
                cachedInputTokens: 2,
                reasoningTokens: 1,
              }
            : {
                inputTokens: { total: 5, cacheRead: 2, cacheWrite: 1 },
                outputTokens: { total: 3, reasoning: 1 },
              },
      }),
    };
    const result = await new AiSdkModel(model).complete({
      body: { model: 'synthetic', input: [] },
      context: undefined,
      sessionId: 'session',
      turnId: 'turn',
      signal: new AbortController().signal,
    });
    expect(result.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
      cached_input_tokens: 2,
      reasoning_output_tokens: 1,
    });
  },
);

it.each([
  { name: 'Error', message: 'Invalid JSON response', validBody: true },
  { name: 'AI_APICallError', message: 'Transport failed', validBody: true },
  {
    name: 'AI_APICallError',
    message: 'Invalid JSON response',
    validBody: false,
  },
])(
  'original provider failure identity: $name / $message / $validBody',
  async ({ name, message, validBody }) => {
    const failure = Object.assign(new Error(message), {
      name,
      statusCode: 200,
      responseBody: validBody
        ? JSON.stringify({
            status: 'incomplete',
            output: [
              {
                type: 'message',
                content: [{ type: 'refusal', refusal: 'private' }],
              },
            ],
          })
        : 'invalid JSON',
    });
    const model = new AiSdkModel({
      specificationVersion: 'v4',
      provider: 'openai.responses',
      modelId: 'synthetic',
      doGenerate() {
        throw failure;
      },
    });
    await expect(
      model.complete({
        body: { model: 'synthetic', input: [] },
        context: undefined,
        sessionId: 'session',
        turnId: 'turn',
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
  },
);

it.each(['stopped', 'live', 'unrelated'] as const)(
  'borrowed Responses cancellation identity: %s',
  async (scenario) => {
    const controller = new AbortController();
    const reason = new Error('native owner cancellation');
    const failure =
      scenario === 'unrelated'
        ? new Error('Request was aborted.')
        : new APIUserAbortError();
    if (scenario === 'stopped') controller.abort(reason);
    let dispatched = 0;
    const model = new ResponsesModel({
      responses: {
        async create() {
          dispatched++;
          if (scenario === 'unrelated') controller.abort(reason);
          throw failure;
        },
      },
    });
    await expect(
      model.complete({
        body: { model: 'synthetic', input: [] },
        context: undefined,
        sessionId: 'session',
        turnId: 'turn',
        signal: controller.signal,
      }),
    ).rejects.toBe(scenario === 'stopped' ? reason : failure);
    expect(dispatched).toBe(scenario === 'stopped' ? 0 : 1);
  },
);
