import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../src/openaiProvider';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import { setOpenAIAPI } from '../src/defaults';
import * as defaults from '../src/defaults';

class FakeClient {}

describe('OpenAIProvider', () => {
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

  it('registers for key changes when using default key', () => {
    const registerSpy = vi.spyOn(defaults, 'registerOpenAIProvider');

    // Provider without specific apiKey should register
    new OpenAIProvider({});
    expect(registerSpy).toHaveBeenCalledTimes(1);

    registerSpy.mockRestore();
  });

  it('does not register for key changes when using custom client', () => {
    const registerSpy = vi.spyOn(defaults, 'registerOpenAIProvider');

    // Provider with custom client should not register
    new OpenAIProvider({ openAIClient: new FakeClient() as any });
    expect(registerSpy).not.toHaveBeenCalled();

    registerSpy.mockRestore();
  });

  it('does not register for key changes when using custom apiKey', () => {
    const registerSpy = vi.spyOn(defaults, 'registerOpenAIProvider');

    // Provider with custom apiKey should not register
    new OpenAIProvider({ apiKey: 'custom-key' });
    expect(registerSpy).not.toHaveBeenCalled();

    registerSpy.mockRestore();
  });

  it('invalidates client when API key changes', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });

    // Get a model to ensure client is created
    const model1 = await provider.getModel('test-model');
    expect(model1).toBeDefined();

    // Invalidate the client
    provider.invalidateClient();

    // Getting a model should still work after invalidation
    const model2 = await provider.getModel('test-model');
    expect(model2).toBeDefined();

    // Cleanup
    provider.destroy();
  });
});
