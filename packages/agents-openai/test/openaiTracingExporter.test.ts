import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { OpenAITracingExporter } from '../src/openaiTracingExporter';
import { HEADERS } from '../src/defaults';
import { createCustomSpan } from '@openai/agents-core';

import { setTracingDisabled } from '@openai/agents-core';

// Disable tracing to prevent stderr output
beforeAll(() => {
  setTracingDisabled(true);
});

afterAll(() => {
  setTracingDisabled(false);
});

describe('OpenAITracingExporter', () => {
  const fakeSpan = createCustomSpan({
    data: {
      name: 'test',
    },
  });
  fakeSpan.toJSON = () => ({
    object: 'trace.span',
    id: '123',
    trace_id: '123',
    parent_id: '123',
    started_at: '123',
    ended_at: '123',
    span_data: { name: 'test' },
    error: null,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    // Suppress console output during tests to reduce noise
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('skips export when no apiKey', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OpenAITracingExporter({ apiKey: '' });
    const item = createCustomSpan({
      data: {
        name: 'test',
      },
    });
    await exporter.export([item]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exports payload via fetch when apiKey is provided', async () => {
    const item = fakeSpan;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key1',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    await exporter.export([item], undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/ingest');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer key1',
        'OpenAI-Beta': 'traces=v1',
        ...HEADERS,
      }),
    );
    expect(JSON.parse(opts.body as string)).toEqual({ data: [item.toJSON()] });
  });

  it('retries on server errors', async () => {
    const item = fakeSpan;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'err',
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key2',
      endpoint: 'url',
      maxRetries: 2,
      baseDelay: 1,
      maxDelay: 2,
    });
    await exporter.export([item]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on client error', async () => {
    const item = fakeSpan;
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OpenAITracingExporter({
      apiKey: 'key3',
      endpoint: 'u',
      maxRetries: 2,
    });
    await exporter.export([item]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('setDefaultOpenAITracingExporter registers processor', async () => {
    const setTraceProcessors = vi.fn();
    const BatchTraceProcessor = vi.fn().mockImplementation((exp) => ({ exp }));
    vi.resetModules();
    vi.doMock('@openai/agents-core', async () => {
      const actual = await vi.importActual<any>('@openai/agents-core');
      return { ...actual, BatchTraceProcessor, setTraceProcessors };
    });
    const mod = await import('../src/openaiTracingExporter');
    mod.setDefaultOpenAITracingExporter();
    expect(BatchTraceProcessor).toHaveBeenCalled();
    expect(setTraceProcessors).toHaveBeenCalledWith([expect.anything()]);
    vi.resetModules();
  });
});
