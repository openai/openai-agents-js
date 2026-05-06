import { describe, test, expect } from 'vitest';
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
  test('Default OpenAI model is gpt-5.4-mini', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5.4-mini');
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
});
