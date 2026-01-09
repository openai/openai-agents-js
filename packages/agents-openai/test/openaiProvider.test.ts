import { afterEach, describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../src/openaiProvider';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import {
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIAPI,
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

  it('returns responses model when useResponses true', async () => {
    const provider = new OpenAIProvider({
      openAIClient: new FakeClient() as any,
      useResponses: true,
    });
    const model = await provider.getModel('m');
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
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

  it('reuses a default client when opting out of the responses API', async () => {
    const defaultClient = { client: true } as any;
    setDefaultOpenAIClient(defaultClient);
    const provider = new OpenAIProvider({ useResponses: false });

    const model = await provider.getModel('gpt-4o');

    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(OpenAIMock).not.toHaveBeenCalled();
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
