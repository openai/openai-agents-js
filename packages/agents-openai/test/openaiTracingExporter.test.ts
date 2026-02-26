import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OpenAITracingExporter,
  _openAITracingExporterTestUtils,
} from '../src/openaiTracingExporter';
import { HEADERS } from '../src/defaults';
import { createCustomSpan } from '@openai/agents-core';
import logger from '../src/logger';

describe('OpenAITracingExporter', () => {
  const maxFieldBytes = 100_000;
  const truncationSuffix = '... [truncated]';
  const jsonSizeBytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
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
  });

  it('skips export when no apiKey', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
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
    expect(errorSpy).toHaveBeenCalledWith(
      'No API key provided for OpenAI tracing exporter. Exports will be skipped',
    );
    errorSpy.mockRestore();
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

  it('moves unsupported generation usage fields into details', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: 46,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 3 },
            details: { provider: 'ai-sdk' },
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      details: {
        provider: 'ai-sdk',
        total_tokens: 46,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });

  it('drops unserializable generation usage detail fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1b',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            details: {
              provider: 'ai-sdk',
              bigint: 1n,
            },
            opaque: () => 'skip',
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      details: {
        provider: 'ai-sdk',
      },
    });
  });

  it('keeps null generation usage extra fields in details', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1ba',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: null,
            details: {
              provider: 'ai-sdk',
            },
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      details: {
        provider: 'ai-sdk',
        total_tokens: null,
      },
    });
  });

  it('keeps generation usage detail values with enumerable fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    class EnumerableValue {
      label = 'enumerable';
      count = 2;
    }

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1bb',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            details: {
              enumerable: new EnumerableValue(),
            },
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      details: {
        enumerable: {
          label: 'enumerable',
          count: 2,
        },
      },
    });
  });

  it('preserves array positions in generation usage details', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1bc',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            details: {
              items: ['a', () => 'bad', 'b'],
            },
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      details: {
        items: ['a', null, 'b'],
      },
    });
  });

  it('keeps generation usage detail values with toJSON support', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    class CustomValue {
      toJSON() {
        return { kind: 'custom', ok: true };
      }
    }

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1c',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            details: {
              createdAt: new Date('2026-02-26T00:00:00.000Z'),
              location: new URL('https://example.com/path'),
              custom: new CustomValue(),
            },
            payload: Buffer.from('abc'),
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      details: {
        createdAt: '2026-02-26T00:00:00.000Z',
        location: 'https://example.com/path',
        custom: { kind: 'custom', ok: true },
        payload: {
          type: 'Buffer',
          data: [97, 98, 99],
        },
      },
    });
  });

  it('drops non-object generation usage.details', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-1a',
        trace_id: 'trace-1',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            details: 'invalid',
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
    });
  });

  it('drops invalid generation usage when required usage fields are missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-whitelist',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-2',
        trace_id: 'trace-2',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          usage: {
            prompt_tokens: 12,
            completion_tokens: 34,
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data).toEqual({
      type: 'generation',
    });
  });

  it('truncates oversized span input strings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-large-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const originalInput = 'x'.repeat(maxFieldBytes + 5_000);
    const item = {
      exportedPayload: {
        object: 'trace.span',
        id: 'span-large-input',
        trace_id: 'trace-large-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: originalInput,
        },
        error: null,
      },
      toJSON() {
        return this.exportedPayload;
      },
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(typeof sentInput).toBe('string');
    expect(sentInput.endsWith(truncationSuffix)).toBe(true);
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
    expect(item.exportedPayload.span_data.input).toBe(originalInput);
  });

  it('truncates oversized structured span input without flattening it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-large-structured-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-large-structured-input',
        trace_id: 'trace-large-structured-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: {
            blob: 'x'.repeat(maxFieldBytes + 5_000),
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(sentInput).toEqual(
      expect.objectContaining({
        blob: expect.any(String),
      }),
    );
    expect(sentInput.blob.endsWith(truncationSuffix)).toBe(true);
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('preserves nested generation input list shape while truncating large payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-large-list-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-large-list-input',
        trace_id: 'trace-large-list-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: {
                    data: 'x'.repeat(maxFieldBytes + 5_000),
                    format: 'wav',
                  },
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(Array.isArray(sentInput)).toBe(true);
    expect(sentInput[0].role).toBe('user');
    expect(sentInput[0].content[0].input_audio.format).toBe('wav');
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('keeps JSON-serializable non-plain objects when truncating span input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-json-objects-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    class SerializableValue {
      toJSON() {
        return { label: 'custom-object' };
      }
    }

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-json-objects-input',
        trace_id: 'trace-json-objects-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: {
            blob: 'x'.repeat(maxFieldBytes + 5_000),
            createdAt: new Date('2026-02-26T00:00:00.000Z'),
            location: new URL('https://example.com/traces'),
            payload: Buffer.from('abc'),
            custom: new SerializableValue(),
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(sentInput.blob.endsWith(truncationSuffix)).toBe(true);
    expect(sentInput.createdAt).toBe('2026-02-26T00:00:00.000Z');
    expect(sentInput.location).toBe('https://example.com/traces');
    expect(sentInput.payload).toEqual({
      type: 'Buffer',
      data: [97, 98, 99],
    });
    expect(sentInput.custom).toEqual({ label: 'custom-object' });
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('keeps enumerable non-plain objects when truncating span input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-enumerable-objects-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    class EnumerableInputValue {
      label = 'class-instance';
      count = 3;
    }

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-enumerable-objects-input',
        trace_id: 'trace-enumerable-objects-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: {
            blob: 'x'.repeat(maxFieldBytes + 5_000),
            enumerable: new EnumerableInputValue(),
          },
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(sentInput.blob.endsWith(truncationSuffix)).toBe(true);
    expect(sentInput.enumerable).toEqual({
      label: 'class-instance',
      count: 3,
    });
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('preserves array positions when truncating span input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-array-positions-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-array-positions-input',
        trace_id: 'trace-array-positions-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: [
            {
              role: 'user',
              content: ['a', () => 'bad', 'b', 'x'.repeat(maxFieldBytes)],
            },
          ],
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(sentInput[0].content[0]).toBe('a');
    expect(sentInput[0].content[1]).toBeNull();
    expect(sentInput[0].content[2]).toBe('b');
    expect(typeof sentInput[0].content[3]).toBe('string');
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('replaces oversized unserializable outputs with a preview object', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-unserializable-output',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const output = 1n as unknown;
    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-unserializable-output',
        trace_id: 'trace-unserializable-output',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'function',
          output,
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.output).toEqual({
      truncated: true,
      original_type: 'bigint',
      preview: '<bigint truncated>',
    });
  });

  it('falls back to Object when constructor access throws during preview generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-constructor-throws-output',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const output = {};
    Object.defineProperty(output, 'constructor', {
      get() {
        throw new Error('constructor access failed');
      },
    });
    Object.defineProperty(output, 'payload', {
      enumerable: true,
      get() {
        throw new Error('payload access failed');
      },
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-constructor-throws-output',
        trace_id: 'trace-constructor-throws-output',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'function',
          output,
        },
        error: null,
      }),
    } as any;

    await expect(exporter.export([item])).resolves.toBeUndefined();

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.output).toEqual({
      truncated: true,
      original_type: 'Object',
      preview: '<Object len=1 truncated>',
    });
  });

  it('falls back when toJSON access throws during sanitization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-tojson-throws-output',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const output = {};
    Object.defineProperty(output, 'toJSON', {
      get() {
        throw new Error('toJSON access failed');
      },
    });
    Object.defineProperty(output, 'payload', {
      enumerable: true,
      get() {
        throw new Error('payload access failed');
      },
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-tojson-throws-output',
        trace_id: 'trace-tojson-throws-output',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'function',
          output,
        },
        error: null,
      }),
    } as any;

    await expect(exporter.export([item])).resolves.toBeUndefined();

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.output).toEqual({
      truncated: true,
      original_type: 'Object',
      preview: '<Object len=1 truncated>',
    });
  });

  it('caps preview metadata when the constructor name is extremely long', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-long-preview-metadata',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const longTypeName = 'Type' + 'x'.repeat(maxFieldBytes);
    const output = {};
    Object.defineProperty(output, 'constructor', {
      get() {
        return { name: longTypeName };
      },
    });
    Object.defineProperty(output, 'toJSON', {
      get() {
        throw new Error('toJSON access failed');
      },
    });
    Object.defineProperty(output, 'payload', {
      enumerable: true,
      get() {
        throw new Error('payload access failed');
      },
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-long-preview-metadata',
        trace_id: 'trace-long-preview-metadata',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'function',
          output,
        },
        error: null,
      }),
    } as any;

    await expect(exporter.export([item])).resolves.toBeUndefined();

    const [, opts] = fetchMock.mock.calls[0];
    const sentOutput = JSON.parse(opts.body as string).data[0].span_data.output;
    expect(sentOutput.truncated).toBe(true);
    expect(sentOutput.original_type.endsWith(truncationSuffix)).toBe(true);
    expect(typeof sentOutput.preview).toBe('string');
    expect(jsonSizeBytes(sentOutput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('omits top-level input and output values that JSON would omit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-omitted-top-level-fields',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-omitted-top-level-fields',
        trace_id: 'trace-omitted-top-level-fields',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: undefined,
          output: () => 'omit',
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentSpanData = JSON.parse(opts.body as string).data[0].span_data;
    expect(sentSpanData).not.toHaveProperty('input');
    expect(sentSpanData).not.toHaveProperty('output');
  });

  it('omits span output when its getter throws during sanitization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-throwing-output-getter',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const spanData = {
      type: 'function',
      get output() {
        throw new Error('output access failed');
      },
    };

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-throwing-output-getter',
        trace_id: 'trace-throwing-output-getter',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: spanData,
        error: null,
      }),
    } as any;

    await expect(exporter.export([item])).resolves.toBeUndefined();

    const [, opts] = fetchMock.mock.calls[0];
    const sentSpanData = JSON.parse(opts.body as string).data[0].span_data;
    expect(sentSpanData.type).toBe('function');
    expect(sentSpanData).not.toHaveProperty('output');
  });

  it('falls back to a preview when deep nesting overflows recursive truncation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-deep-nesting-output',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const output: Record<string, unknown> = {};
    let cursor = output;
    for (let index = 0; index < 15_000; index += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    cursor.payload = 'x'.repeat(maxFieldBytes);

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-deep-nesting-output',
        trace_id: 'trace-deep-nesting-output',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'function',
          output,
        },
        error: null,
      }),
    } as any;

    await expect(exporter.export([item])).resolves.toBeUndefined();

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body as string).data[0].span_data.output).toEqual({
      truncated: true,
      original_type: 'Object',
      preview: '<Object len=1 truncated>',
    });
  });

  it('truncates escape-heavy strings based on JSON byte size', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'key-escape-heavy-input',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 20,
    });

    const item = {
      toJSON: () => ({
        object: 'trace.span',
        id: 'span-escape-heavy-input',
        trace_id: 'trace-escape-heavy-input',
        parent_id: null,
        started_at: 'start',
        ended_at: 'end',
        span_data: {
          type: 'generation',
          input: ('\\\\' + '"').repeat(40_000) + 'tail',
        },
        error: null,
      }),
    } as any;

    await exporter.export([item]);

    const [, opts] = fetchMock.mock.calls[0];
    const sentInput = JSON.parse(opts.body as string).data[0].span_data.input;
    expect(sentInput.endsWith(truncationSuffix)).toBe(true);
    expect(jsonSizeBytes(sentInput)).toBeLessThanOrEqual(maxFieldBytes);
  });

  it('deletes mapping children when child budget is zero', () => {
    const truncated =
      _openAITracingExporterTestUtils.truncateMappingForJsonLimit(
        { a: {}, b: {} },
        0,
      );

    expect(truncated).toEqual({});
  });

  it('truncates mapping children stored under empty-string keys', () => {
    const truncated =
      _openAITracingExporterTestUtils.truncateMappingForJsonLimit(
        { '': 'x'.repeat(maxFieldBytes), keep: 'y' },
        128,
      );

    expect(truncated).toHaveProperty('');
    expect(typeof truncated['']).toBe('string');
    expect((truncated[''] as string).endsWith(truncationSuffix)).toBe(true);
    expect(truncated.keep).toBe('y');
    expect(jsonSizeBytes(truncated)).toBeLessThanOrEqual(128);
  });

  it('deletes list children when child budget is zero', () => {
    const truncated = _openAITracingExporterTestUtils.truncateListForJsonLimit(
      [{}, {}],
      0,
    );

    expect(truncated).toEqual([]);
  });

  it('retries on server errors', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
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
    expect(warnSpy).toHaveBeenCalledWith(
      '[non-fatal] Tracing: server error 500, retrying.',
    );
    warnSpy.mockRestore();
  });

  it('stops on client error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
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
    expect(errorSpy).toHaveBeenCalledWith(
      '[non-fatal] Tracing client error 400: bad',
    );
    errorSpy.mockRestore();
  });

  it('uses item-level API keys when exporting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'default-key',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 1,
      maxDelay: 2,
    });

    const items = [
      { tracingApiKey: 'key-a', toJSON: () => ({ id: 'a' }) },
      { tracingApiKey: undefined, toJSON: () => ({ id: 'b' }) },
      { tracingApiKey: 'key-b', toJSON: () => ({ id: 'c' }) },
    ] as any;

    await exporter.export(items);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const authHeaders = fetchMock.mock.calls.map(
      ([, opts]) => (opts as any).headers.Authorization,
    );
    expect(authHeaders).toEqual(
      expect.arrayContaining([
        'Bearer key-a',
        'Bearer default-key',
        'Bearer key-b',
      ]),
    );
  });

  it('groups items by api key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OpenAITracingExporter({
      apiKey: 'default-key',
      endpoint: 'https://example.com/ingest',
      maxRetries: 1,
      baseDelay: 1,
      maxDelay: 2,
    });

    const items = [
      { tracingApiKey: 'key-a', toJSON: () => ({ id: 'a' }) },
      { tracingApiKey: 'key-a', toJSON: () => ({ id: 'b' }) },
      { tracingApiKey: undefined, toJSON: () => ({ id: 'c' }) },
    ] as any;

    await exporter.export(items);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls.find(
      ([, opts]) => (opts as any).headers.Authorization === 'Bearer key-a',
    );
    const defaultCall = fetchMock.mock.calls.find(
      ([, opts]) =>
        (opts as any).headers.Authorization === 'Bearer default-key',
    );

    expect(firstCall).toBeDefined();
    expect(JSON.parse(firstCall![1].body as string).data).toHaveLength(2);
    expect(defaultCall).toBeDefined();
    expect(JSON.parse(defaultCall![1].body as string).data).toHaveLength(1);
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
