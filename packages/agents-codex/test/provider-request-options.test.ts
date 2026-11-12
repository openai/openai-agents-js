import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import {
  ChatCompletionsModel,
  ResponsesModel,
  type ModelRequest,
  type ModelRequestOptions,
} from '../src';
import { markModelRequestTransport } from '../src/runtime/models';

const adapters = [ChatCompletionsModel, ResponsesModel] as const;
function request(signal = new AbortController().signal): ModelRequest {
  return {
    body: {
      model: 'fixture',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
    },
    context: { key: 'context' },
    sessionId: 'session',
    turnId: 'turn',
    signal,
  };
}
function success(chat: boolean): Response {
  return Response.json(
    chat
      ? {
          id: 'chat',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' },
            },
          ],
        }
      : {
          id: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        },
  );
}

it.each(adapters)(
  'captures per-request headers and typed query values with %s',
  async (Adapter) => {
    const seen: { url: URL; headers: Headers; body: any }[] = [];
    const client = new OpenAI({
      apiKey: 'fixture',
      baseURL: 'http://test.invalid/v1',
      defaultHeaders: { 'x-remove': 'inherited' },
      fetch: async (url, init) => {
        seen.push({
          url: new URL(String(url)),
          headers: new Headers(init?.headers),
          body: JSON.parse(init?.body as string),
        });
        return success(Adapter === ChatCompletionsModel);
      },
    });
    const options: ModelRequestOptions = {
      headers: { 'x-selected': 'captured', 'x-remove': null },
      query: { count: 2, enabled: true, tags: ['a', 'b'] },
      timeoutMs: 1000,
      maxRetries: 0,
    };
    const model = new Adapter(client, undefined, { requestOptions: options });
    (options.headers as Record<string, string | null>)['x-selected'] =
      'changed';
    (options.query!.tags as string[]).push('changed');
    await model.complete(request());
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get('x-selected')).toBe('captured');
    expect(seen[0].headers.has('x-remove')).toBe(false);
    expect(seen[0].url.searchParams.get('count')).toBe('2');
    expect(seen[0].url.searchParams.get('enabled')).toBe('true');
    expect(seen[0].url.search).not.toContain('changed');
    for (const key of ['headers', 'query', 'timeoutMs', 'maxRetries'])
      expect(seen[0].body).not.toHaveProperty(key);
  },
);

it.each(adapters)(
  'uses one captured options factory and a detached request with %s',
  async (Adapter) => {
    let wire: any;
    let header: string | null = null;
    const client = new OpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        header = new Headers(init?.headers).get('x-selected');
        wire = JSON.parse(init?.body as string);
        return success(Adapter === ChatCompletionsModel);
      },
    });
    const input = request();
    const selected = { headers: { 'x-selected': 'before' } };
    const factory = vi.fn((observed: ModelRequest) => {
      expect(observed.context).toBe(input.context);
      expect(observed.signal).toBe(input.signal);
      expect(observed.sessionId).toBe(input.sessionId);
      observed.body.model = 'mutated';
      queueMicrotask(() => {
        selected.headers['x-selected'] = 'after';
      });
      return selected;
    });
    const options = { requestOptions: factory };
    const model = new Adapter(client, undefined, options);
    options.requestOptions = vi.fn(() => {
      throw new Error('replacement');
    });
    await model.complete(input);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(input.body.model).toBe('fixture');
    expect(wire.model).toBe('fixture');
    expect(header).toBe('before');
  },
);

it.each(adapters)(
  'uses the real client retry owner exactly once with %s',
  async (Adapter) => {
    let calls = 0;
    const client = new OpenAI({
      apiKey: 'fixture',
      maxRetries: 0,
      fetch: async () => {
        calls++;
        return calls === 1
          ? Response.json(
              { error: { message: 'retry' } },
              { status: 500, headers: { 'retry-after-ms': '1' } },
            )
          : success(Adapter === ChatCompletionsModel);
      },
    });
    const model = new Adapter(client, undefined, {
      requestOptions: { maxRetries: 1 },
    });
    await model.complete(request());
    expect(calls).toBe(2);
    expect(client.maxRetries).toBe(0);
  },
);

it.each(adapters)(
  'uses per-attempt client timeout without retrying when disabled with %s',
  async (Adapter) => {
    let calls = 0;
    const client = new OpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    });
    const model = new Adapter(client, undefined, {
      requestOptions: { timeoutMs: 10, maxRetries: 0 },
    });
    await expect(model.complete(request())).rejects.toBeInstanceOf(
      OpenAI.APIConnectionTimeoutError,
    );
    expect(calls).toBe(1);
  },
);

it.each(adapters)(
  'keeps native cancellation ahead of options dispatch with %s',
  async (Adapter) => {
    const gate = Promise.withResolvers<ModelRequestOptions>();
    const fetch = vi.fn();
    const client = new OpenAI({ apiKey: 'fixture', fetch });
    const controller = new AbortController();
    const reason = new Error('native cancellation');
    const model = new Adapter(client, undefined, {
      requestOptions: async () => gate.promise,
    });
    const pending = model.complete(request(controller.signal));
    controller.abort(reason);
    gate.resolve({ headers: { 'x-selected': 'late' } });
    await expect(pending).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(adapters)(
  'rejects unsupported authority options before client I/O with %s',
  (Adapter) => {
    const client = new OpenAI({ apiKey: 'fixture', fetch: vi.fn() });
    expect(
      () =>
        new Adapter(client, undefined, {
          requestOptions: { signal: new AbortController().signal } as any,
        }),
    ).toThrow(TypeError);
  },
);

it.each(adapters)(
  'overlays scoped HTTP options only on the issuing model request with %s',
  async (Adapter) => {
    const seen: Array<{
      url: URL;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    let credentialCalls = 0;
    const client = new OpenAI({
      apiKey: async () => {
        credentialCalls += 1;
        return 'synthetic-borrowed-' + credentialCalls;
      },
      baseURL: 'http://test.invalid/v1',
      defaultHeaders: { 'x-drop': 'client' },
      defaultQuery: { keep: 'client', empty: 'client' },
      fetch: async (url, init) => {
        seen.push({
          url: new URL(String(url)),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return success(Adapter === ChatCompletionsModel);
      },
    });
    const model = new Adapter(client, undefined, {
      requestOptions: {
        headers: { 'X-Routing': 'adapter', 'x-adapter': 'retained' },
        query: { route: 'adapter' },
      },
    });
    const scoped = request();
    markModelRequestTransport(scoped, {
      headers: { 'x-routing': 'operation', 'x-drop': null },
      query: { route: 'operation', empty: null, count: 2 },
      query_nulls_as_empty: true,
    });
    await model.complete(scoped);
    await model.complete(request());
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(first.headers.get('authorization')).toBe(
      'Bearer synthetic-borrowed-1',
    );
    expect(first.headers.get('x-routing')).toBe('operation');
    expect(first.headers.get('x-adapter')).toBe('retained');
    expect(first.headers.has('x-drop')).toBe(false);
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      route: 'operation',
      keep: 'client',
      empty: '',
      count: '2',
    });
    expect(second.headers.get('authorization')).toBe(
      'Bearer synthetic-borrowed-2',
    );
    expect(second.headers.get('x-routing')).toBe('adapter');
    expect(second.headers.get('x-drop')).toBe('client');
    expect(Object.fromEntries(second.url.searchParams)).toEqual({
      route: 'adapter',
      keep: 'client',
      empty: 'client',
    });
    for (const call of seen)
      expect(call.body).not.toHaveProperty('request_transport');
  },
);
