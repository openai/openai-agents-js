import { afterEach, describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../src/openaiProvider';
import {
  OpenAIResponsesModel,
  OpenAIResponsesWSModel,
} from '../src/openaiResponsesModel';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import * as defaultsModule from '../src/defaults';
import {
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIAPI,
  setOpenAIResponsesTransport,
} from '../src/defaults';

const OpenAIMock = vi.hoisted(() =>
  vi.fn(function FakeOpenAI(this: any, config: any) {
    Object.assign(this, config);
    this.chat = { completions: { create: vi.fn() } };
    this.responses = { create: vi.fn(), compact: vi.fn() };
  }),
);

vi.mock('openai', () => ({
  default: OpenAIMock,
  OpenAI: OpenAIMock,
}));

class FakeClient {}

describe('OpenAIProvider', () => {
  afterEach(() => {
    setOpenAIAPI('responses');
    setOpenAIResponsesTransport('http');
    setDefaultOpenAIClient(undefined as any);
    setDefaultOpenAIKey(undefined as any);
    OpenAIMock.mockClear();
  });

  it('throws when apiKey and openAIClient are provided', () => {
    expect(
      () => new OpenAIProvider({ apiKey: 'k', openAIClient: {} as any }),
    ).toThrow();
  });

  it('throws when baseURL and openAIClient are provided', () => {
    expect(
      () => new OpenAIProvider({ baseURL: 'x', openAIClient: {} as any }),
    ).toThrow();
  });

  it('throws when websocketBaseURL and openAIClient are provided', () => {
    expect(
      () =>
        new OpenAIProvider({
          websocketBaseURL: 'wss://proxy.example.test/v1',
          openAIClient: {} as any,
        }),
    ).toThrow();
  });

  it('returns responses model when useResponses true', async () => {
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
    });
    const model = await provider.getModel('m');
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
  });

  it('returns websocket responses model when useResponsesWebSocket is enabled', async () => {
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
      useResponsesWebSocket: true,
    });
    const model = await provider.getModel('m');
    expect(model).toBeInstanceOf(OpenAIResponsesWSModel);
  });

  it('does not use env websocket base URL fallback for a custom OpenAI client', async () => {
    const getDefaultWebSocketBaseURLSpy = vi
      .spyOn(defaultsModule, 'getDefaultOpenAIWebSocketBaseURL')
      .mockReturnValue('wss://env-proxy.example.test/v1');
    const customClient = {
      baseURL: 'https://custom-openai.example/v1',
      responses: { create: vi.fn(), compact: vi.fn() },
      chat: { completions: { create: vi.fn() } },
    } as any;
    const provider = new OpenAIProvider({
      openAIClient: customClient,
      useResponses: true,
      useResponsesWebSocket: true,
    });

    const model = await provider.getModel('m');

    expect(model).toBeInstanceOf(OpenAIResponsesWSModel);
    expect(getDefaultWebSocketBaseURLSpy).not.toHaveBeenCalled();
  });

  it('does not use env websocket base URL fallback when provider baseURL is explicit', async () => {
    const getDefaultWebSocketBaseURLSpy = vi
      .spyOn(defaultsModule, 'getDefaultOpenAIWebSocketBaseURL')
      .mockReturnValue('wss://env-proxy.example.test/v1');
    const provider = new OpenAIProvider({
      baseURL: 'https://proxy.example.test/v1',
      useResponses: true,
      useResponsesWebSocket: true,
    });

    const model = await provider.getModel('m');

    expect(model).toBeInstanceOf(OpenAIResponsesWSModel);
    expect(getDefaultWebSocketBaseURLSpy).not.toHaveBeenCalled();
  });

  it('does not use env websocket base URL fallback when using a default injected client', async () => {
    const getDefaultWebSocketBaseURLSpy = vi
      .spyOn(defaultsModule, 'getDefaultOpenAIWebSocketBaseURL')
      .mockReturnValue('wss://env-proxy.example.test/v1');
    setDefaultOpenAIClient({
      baseURL: 'https://default-client.example/v1',
      responses: { create: vi.fn(), compact: vi.fn() },
      chat: { completions: { create: vi.fn() } },
    } as any);
    const provider = new OpenAIProvider({
      useResponses: true,
      useResponsesWebSocket: true,
    });

    const model = await provider.getModel('m');

    expect(model).toBeInstanceOf(OpenAIResponsesWSModel);
    expect(getDefaultWebSocketBaseURLSpy).not.toHaveBeenCalled();
  });

  it('uses default API when useResponses not set', async () => {
    setOpenAIAPI('responses');
    let provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
    });
    expect(await provider.getModel('m')).toBeInstanceOf(OpenAIResponsesModel);

    setOpenAIAPI('chat_completions');
    provider = new OpenAIProvider({ openAIClient: new FakeClient() as any });
    expect(await provider.getModel('m')).toBeInstanceOf(
      OpenAIChatCompletionsModel,
    );
  });

  it('uses default responses transport when useResponsesWebSocket is not set', async () => {
    setOpenAIAPI('responses');
    setOpenAIResponsesTransport('websocket');

    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
    });

    expect(await provider.getModel('m')).toBeInstanceOf(OpenAIResponsesWSModel);
  });

  it('reuses a default client when opting out of the responses API', async () => {
    const defaultClient = { client: true } as any;
    setDefaultOpenAIClient(defaultClient);
    const provider = new OpenAIProvider({ useResponses: false });

    const model = await provider.getModel('gpt-4o');

    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(OpenAIMock).not.toHaveBeenCalled();
  });

  it('caches model wrappers so websocket transport can reuse a connection', async () => {
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
      useResponsesWebSocket: true,
    });

    const first = await provider.getModel('gpt-4.1');
    const second = await provider.getModel('gpt-4.1');

    expect(first).toBe(second);
    expect(first).toBeInstanceOf(OpenAIResponsesWSModel);
  });

  it('can disable websocket model wrapper caching', async () => {
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
      useResponsesWebSocket: true,
      cacheResponsesWebSocketModels: false,
    });

    const first = await provider.getModel('gpt-4.1');
    const second = await provider.getModel('gpt-4.1');

    expect(first).not.toBe(second);
    expect(first).toBeInstanceOf(OpenAIResponsesWSModel);
    expect(second).toBeInstanceOf(OpenAIResponsesWSModel);
  });

  it('does not retain uncached websocket models for provider.close', async () => {
    const closeSpy = vi
      .spyOn(OpenAIResponsesWSModel.prototype, 'close')
      .mockResolvedValue(undefined);
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
      useResponsesWebSocket: true,
      cacheResponsesWebSocketModels: false,
    });

    await provider.getModel('gpt-4.1');
    await provider.getModel('gpt-4.1');
    await provider.close();

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('closes cached closeable models and clears the cache', async () => {
    const closeSpy = vi
      .spyOn(OpenAIResponsesWSModel.prototype, 'close')
      .mockResolvedValue(undefined);
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
      useResponsesWebSocket: true,
    });

    const first = await provider.getModel('gpt-4.1');
    await provider.close();
    const second = await provider.getModel('gpt-4.1');

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });

  it('constructs a client using default env configuration for responses', async () => {
    setDefaultOpenAIKey('test-key');
    const provider = new OpenAIProvider({
      baseURL: 'https://alt.example',
      organization: 'org-123',
      project: 'proj-456',
      useResponses: true,
    });

    const model = (await provider.getModel('gpt-4.1')) as any;

    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://alt.example',
      organization: 'org-123',
      project: 'proj-456',
    });
  });
});
