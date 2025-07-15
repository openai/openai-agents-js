import { describe, test, expect, vi } from 'vitest';
import {
  DEFAULT_OPENAI_MODEL,
  setTracingExportApiKey,
  getTracingExportApiKey,
  shouldUseResponsesByDefault,
  setOpenAIAPI,
  getDefaultOpenAIClient,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  getDefaultOpenAIKey,
} from '../src/defaults';
import OpenAI from 'openai';

describe('Defaults', () => {
  test('Default OpenAI model is out there', () => {
    expect(DEFAULT_OPENAI_MODEL).toBeDefined();
  });
  test('get/setTracingExportApiKey', async () => {
    setTracingExportApiKey('foo');
    expect(getTracingExportApiKey()).toBe('foo');
  });
  test('shouldUseResponsesByDefault', async () => {
    setOpenAIAPI('responses');
    expect(shouldUseResponsesByDefault()).toBe(true);
    setOpenAIAPI('chat_completions');
    expect(shouldUseResponsesByDefault()).toBe(false);
  });
  test('get/setDefaultOpenAIClient', async () => {
    const client = new OpenAI({ apiKey: 'foo' });
    setDefaultOpenAIClient(client);
    expect(getDefaultOpenAIClient()).toBe(client);
  });
  test('get/setDefaultOpenAIKey', async () => {
    setDefaultOpenAIKey('foo');
    expect(getDefaultOpenAIKey()).toBe('foo');
  });

  test('setDefaultOpenAIKey notifies registered providers', async () => {
    const mockProvider = { invalidateClient: vi.fn() };
    const { registerOpenAIProvider, unregisterOpenAIProvider } = await import(
      '../src/defaults'
    );

    registerOpenAIProvider(mockProvider);
    setDefaultOpenAIKey('new-key');

    expect(mockProvider.invalidateClient).toHaveBeenCalledTimes(1);

    // Cleanup
    unregisterOpenAIProvider(mockProvider);
  });

  test('setDefaultOpenAIClient notifies registered providers', async () => {
    const mockProvider = { invalidateClient: vi.fn() };
    const { registerOpenAIProvider, unregisterOpenAIProvider } = await import(
      '../src/defaults'
    );

    registerOpenAIProvider(mockProvider);
    const client = new OpenAI({ apiKey: 'test-key' });
    setDefaultOpenAIClient(client);

    expect(mockProvider.invalidateClient).toHaveBeenCalledTimes(1);

    // Cleanup
    unregisterOpenAIProvider(mockProvider);
  });
});
