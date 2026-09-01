import { afterEach, describe, test, expect } from 'vitest';
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
} from '../src/defaults';
import OpenAI from 'openai';

describe('Defaults', () => {
  afterEach(() => {
    setOpenAIAPI('responses');
    setOpenAIResponsesTransport('http');
  });

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
  test('setOpenAIAPI rejects invalid runtime values without changing the default', () => {
    setOpenAIAPI('responses');

    expect(() => setOpenAIAPI('response' as any)).toThrow(
      "OpenAI API must be 'chat_completions' or 'responses'.",
    );
    expect(shouldUseResponsesByDefault()).toBe(true);
  });
  test('shouldUseResponsesWebSocketByDefault', async () => {
    setOpenAIResponsesTransport('websocket');
    expect(shouldUseResponsesWebSocketByDefault()).toBe(true);
    setOpenAIResponsesTransport('http');
    expect(shouldUseResponsesWebSocketByDefault()).toBe(false);
  });
  test('setOpenAIResponsesTransport rejects invalid runtime values without changing the default', () => {
    setOpenAIResponsesTransport('websocket');

    expect(() => setOpenAIResponsesTransport('ws' as any)).toThrow(
      "OpenAI Responses transport must be 'http' or 'websocket'.",
    );
    expect(shouldUseResponsesWebSocketByDefault()).toBe(true);
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
});
