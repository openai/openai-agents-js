import { afterEach, describe, test, expect, vi } from 'vitest';
import {
  DEFAULT_OPENAI_MODEL,
  setTracingExportApiKey,
  getTracingExportApiKey,
  shouldUseResponsesByDefault,
  shouldUseResponsesWebSocketByDefault,
  setOpenAIAPI,
  setOpenAIResponsesTransport,
  getDefaultOpenAIClient,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  getDefaultOpenAIKey,
  getDefaultOpenAIWebSocketBaseURL,
} from '../src/defaults';
import OpenAI from 'openai';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Defaults', () => {
  test('Default OpenAI model is gpt-5.6-luna', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5.6-luna');
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
  test('shouldUseResponsesWebSocketByDefault', async () => {
    setOpenAIResponsesTransport('websocket');
    expect(shouldUseResponsesWebSocketByDefault()).toBe(true);
    setOpenAIResponsesTransport('http');
    expect(shouldUseResponsesWebSocketByDefault()).toBe(false);
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
  test.each(['', '   '])(
    'treats OPENAI_WEBSOCKET_BASE_URL %j as unconfigured',
    (value) => {
      vi.stubEnv('OPENAI_WEBSOCKET_BASE_URL', value);
      expect(getDefaultOpenAIWebSocketBaseURL()).toBeUndefined();
    },
  );
  test('returns a trimmed OPENAI_WEBSOCKET_BASE_URL when set', () => {
    vi.stubEnv('OPENAI_WEBSOCKET_BASE_URL', '  wss://proxy.example.test/v1  ');
    expect(getDefaultOpenAIWebSocketBaseURL()).toBe(
      'wss://proxy.example.test/v1',
    );
  });
});
