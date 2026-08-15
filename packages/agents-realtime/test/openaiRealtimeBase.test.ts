import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  expectTypeOf,
} from 'vitest';
import type { MessageEvent as WebSocketMessageEvent } from 'ws';
import type {
  RealtimeClientMessage,
  RealtimeMessageItem,
  RealtimeSessionConfig,
} from '../src';
import {
  DEFAULT_OPENAI_REALTIME_SESSION_CONFIG,
  OpenAIRealtimeBase,
} from '../src/openaiRealtimeBase';
import logger from '../src/logger';
import { responseDoneEventSchema } from '../src/openaiRealtimeEvents';

class TestBase extends OpenAIRealtimeBase {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'connected';
  events: RealtimeClientMessage[] = [];
  afterAudioDoneCalled = 0;
  connect = vi.fn(async () => {});
  sendEvent(event: RealtimeClientMessage) {
    this.events.push(event);
  }
  mute = vi.fn();
  close = vi.fn();
  interrupt = vi.fn();
  get muted() {
    return false;
  }

  protected _afterAudioDoneEvent(): void {
    this.afterAudioDoneCalled += 1;
  }
}

class ThrowingTestBase extends TestBase {
  sendCount = 0;

  constructor(private readonly throwOnSend: number) {
    super();
  }

  override sendEvent(event: RealtimeClientMessage) {
    this.sendCount += 1;
    if (this.sendCount === this.throwOnSend) {
      throw new Error('send failed');
    }
    super.sendEvent(event);
  }
}

class VoidMessageOverrideTransport extends TestBase {
  protected override _onMessage(
    event: MessageEvent | WebSocketMessageEvent,
  ): void {
    super._onMessage(event);
  }
}

function createToolCall() {
  return {
    type: 'function_call' as const,
    id: '1',
    callId: 'c1',
    name: 'tool',
    arguments: '{}',
    responseId: 'response-1',
  };
}

function acknowledgeHistoryCreate(
  base: TestBase,
  eventIndex: number,
  type:
    | 'conversation.item.added'
    | 'conversation.item.done' = 'conversation.item.added',
): void {
  const event = base.events[eventIndex] as any;
  (base as any)._onMessage({
    data: JSON.stringify({
      type,
      event_id: `server_${eventIndex}_${type}`,
      previous_item_id: event.previous_item_id ?? null,
      item: event.item,
    }),
  });
}

function acknowledgeHistoryDelete(base: TestBase, eventIndex: number): void {
  const event = base.events[eventIndex] as any;
  (base as any)._onMessage({
    data: JSON.stringify({
      type: 'conversation.item.deleted',
      event_id: `server_${eventIndex}_deleted`,
      item_id: event.item_id,
    }),
  });
}

describe('OpenAIRealtimeBase helpers', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves api keys from options', async () => {
    const base = new TestBase({ apiKey: () => 'fromCtor' });
    const key1 = await (base as any)._getApiKey({});
    const key2 = await (base as any)._getApiKey({ apiKey: 'override' });

    expect(key1).toBe('fromCtor');
    expect(key2).toBe('override');
  });

  it('allows void-returning _onMessage overrides for subclasses', () => {
    const transport = new VoidMessageOverrideTransport();

    expect(transport).toBeInstanceOf(OpenAIRealtimeBase);
    expectTypeOf(transport).toMatchTypeOf<OpenAIRealtimeBase>();
  });

  it('isolates typed events from mutations to raw wildcard events', () => {
    const base = new TestBase();
    const typedEvents: any[] = [];
    const payload = {
      type: 'session.updated',
      event_id: 'evt_1',
      session: {
        id: 'session_1',
        instructions: 'original instructions',
        provider_nested: { value: 'original value' },
      },
      provider_top_level: 123,
    };
    const rawListener = vi.fn((event: any) => {
      expect(event).toEqual(payload);
      event.session.instructions = 'mutated by raw listener';
      event.session.provider_nested.value = 'mutated by raw listener';
    });
    base.on('*', rawListener);
    base.on('session.updated', (event) => typedEvents.push(event));

    (base as any)._onMessage({ data: JSON.stringify(payload) });

    expect(rawListener).toHaveBeenCalledOnce();
    expect(typedEvents).toEqual([
      {
        type: 'session.updated',
        event_id: 'evt_1',
        session: {
          id: 'session_1',
          instructions: 'original instructions',
          provider_nested: { value: 'original value' },
        },
      },
    ]);
    expect((base as any)._rawSessionConfig).toEqual(payload.session);
  });

  it('clones raw events when structuredClone is unavailable', () => {
    vi.stubGlobal('structuredClone', undefined);
    const base = new TestBase();
    const rawListener = vi.fn();
    base.on('*', rawListener);

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'session.updated',
        session: { id: 'session_1', instructions: 'hello' },
      }),
    });

    expect(rawListener).toHaveBeenCalledWith({
      type: 'session.updated',
      session: { id: 'session_1', instructions: 'hello' },
    });
  });

  it('merges session config defaults', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({
      instructions: 'hi',
    });
    expect(config.instructions).toBe('hi');
    expect(Array.isArray(config.output_modalities)).toBe(true);
    expect(config.output_modalities.length).toBeGreaterThan(0);
    expect(config.audio?.input?.format).toBeDefined();
    expect(config.audio?.output?.format).toBeDefined();
    expect(config.audio?.output?.voice).toBeUndefined();
  });

  it('uses gpt-realtime-2.1 as the default model', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({});

    expect(config.model).toBe('gpt-realtime-2.1');
  });

  it('maps reasoning-capable realtime session settings', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({
      model: 'gpt-realtime-2.1',
      parallelToolCalls: false,
      reasoning: { effort: 'low' },
    });

    expect(config.model).toBe('gpt-realtime-2.1');
    expect(config.parallel_tool_calls).toBe(false);
    expect(config.reasoning).toEqual({ effort: 'low' });
  });

  it('forwards GA input audio transcription options', () => {
    const base = new TestBase();
    const contextualTranscriptionConfig = {
      audio: {
        input: {
          transcription: {
            model: 'gpt-transcribe',
            keywords: ['LegalOn', 'TomoniAI'],
            languages: ['ja', 'en'],
            prompt: 'A Japanese conversation about LegalOn and TomoniAI.',
          },
        },
      },
    } satisfies Partial<RealtimeSessionConfig>;
    const lowLatencyTranscriptionConfig = {
      audio: {
        input: {
          transcription: {
            model: 'gpt-live-transcribe',
            delay: 'low',
          },
        },
      },
    } satisfies Partial<RealtimeSessionConfig>;

    const contextualPayload = base.buildSessionPayload(
      contextualTranscriptionConfig,
    );
    const lowLatencyPayload = base.buildSessionPayload(
      lowLatencyTranscriptionConfig,
    );

    expect(contextualPayload.audio?.input?.transcription).toEqual(
      contextualTranscriptionConfig.audio.input.transcription,
    );
    expect(lowLatencyPayload.audio?.input?.transcription).toEqual(
      lowLatencyTranscriptionConfig.audio.input.transcription,
    );
  });

  it('preserves explicit null audio input config values', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({
      audio: {
        input: {
          noiseReduction: null,
          transcription: null,
          turnDetection: null,
        },
      },
    });

    expect(config.audio?.input?.noise_reduction).toBeNull();
    expect(config.audio?.input?.transcription).toBeNull();
    expect(config.audio?.input?.turn_detection).toBeNull();
  });

  it('treats null audio channels as unset when building config', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({
      audio: {
        input: null,
        output: null,
      },
    });

    expect(config.audio?.input?.format).toEqual(
      DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input?.format,
    );
    expect(config.audio?.input?.transcription).toEqual(
      DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input?.transcription,
    );
    expect(config.audio?.output?.format).toEqual(
      DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.output?.format,
    );
    expect(config.audio?.output?.speed).toEqual(
      DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.output?.speed,
    );
  });

  it('preserves falsy turn detection values when building payload', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({
      audio: {
        input: {
          turnDetection: {
            type: 'semantic_vad',
            createResponse: false,
            interruptResponse: false,
            prefixPaddingMs: 0,
            silenceDurationMs: 0,
            idleTimeoutMs: 0,
            threshold: 0,
            modelVersion: 'default',
          },
        },
      },
    });

    expect(config.audio?.input?.turn_detection).toEqual({
      type: 'semantic_vad',
      create_response: false,
      interrupt_response: false,
      prefix_padding_ms: 0,
      silence_duration_ms: 0,
      idle_timeout_ms: 0,
      threshold: 0,
      model_version: 'default',
    });
  });

  it('updateSessionConfig sends session.update', () => {
    const base = new TestBase();
    base.updateSessionConfig({ voice: 'echo' });
    expect(base.events[0]?.type).toBe('session.update');
    const session = (base.events[0] as any)?.session;
    expect(session?.audio?.output?.voice).toBe('echo');
  });

  it('whitelists function tools in session payload', () => {
    const base = new TestBase();
    const payload = (base as any)._getMergedSessionConfig({
      instructions: 'hi',
      model: 'gpt-realtime-1.5',
      tools: [
        {
          type: 'function',
          name: 'foo',
          description: 'desc',
          parameters: { type: 'object', properties: {}, required: [] },
          inputGuardrails: [{ name: 'ig' }],
          outputGuardrails: [{ name: 'og' }],
          needsApproval: true,
          handler: () => {},
        },
      ],
    });

    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'foo',
        description: 'desc',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ]);
  });

  it('whitelists mcp tools in session payload', () => {
    const base = new TestBase();
    const payload = (base as any)._getMergedSessionConfig({
      instructions: 'hi',
      model: 'gpt-realtime-1.5',
      tools: [
        {
          type: 'mcp',
          server_label: 'deepwiki',
          server_url: 'https://mcp.deepwiki.com/sse',
          server_description: 'desc',
          connector_id: 'connector_dropbox',
          authorization: 'token',
          headers: { Authorization: 'Bearer t' },
          allowed_tools: ['a'],
          require_approval: 'always',
          inputGuardrails: [{ name: 'ig' }],
        },
      ],
    });

    expect(payload.tools).toEqual([
      {
        type: 'mcp',
        server_label: 'deepwiki',
        server_url: 'https://mcp.deepwiki.com/sse',
        server_description: 'desc',
        connector_id: 'connector_dropbox',
        authorization: 'token',
        headers: { Authorization: 'Bearer t' },
        allowed_tools: ['a'],
        require_approval: 'always',
      },
    ]);
  });

  it('omits mcp require_approval when realtime config leaves it undefined', () => {
    const base = new TestBase();
    const payload = (base as any)._getMergedSessionConfig({
      instructions: 'hi',
      model: 'gpt-realtime-1.5',
      tools: [
        {
          type: 'mcp',
          server_label: 'deepwiki',
          server_url: 'https://mcp.deepwiki.com/sse',
        },
      ],
    });

    expect(payload.tools).toEqual([
      {
        type: 'mcp',
        server_label: 'deepwiki',
        server_url: 'https://mcp.deepwiki.com/sse',
      },
    ]);
  });

  it('preserves mcp require_approval read_only filters in realtime config', () => {
    const base = new TestBase();
    const payload = (base as any)._getMergedSessionConfig({
      instructions: 'hi',
      model: 'gpt-realtime-1.5',
      tools: [
        {
          type: 'mcp',
          server_label: 'deepwiki',
          server_url: 'https://mcp.deepwiki.com/sse',
          require_approval: {
            always: { read_only: false },
            never: { tool_names: ['search'], read_only: true },
          },
        },
      ],
    });

    expect(payload.tools).toEqual([
      {
        type: 'mcp',
        server_label: 'deepwiki',
        server_url: 'https://mcp.deepwiki.com/sse',
        require_approval: {
          always: { read_only: false },
          never: { tool_names: ['search'], read_only: true },
        },
      },
    ]);
  });

  it('sendFunctionCallOutput anchors the output after its function call', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (e) => updates.push(e));
    base.sendFunctionCallOutput(createToolCall(), 'output', true);

    expect(base.events[0]).toEqual({
      type: 'conversation.item.create',
      event_id: expect.stringMatching(/^history_/),
      previous_item_id: '1',
      item: {
        id: expect.stringMatching(/^fco_/),
        type: 'function_call_output',
        output: 'output',
        call_id: 'c1',
      },
    });
    expect(base.events[1]).toEqual({ type: 'response.create' });
    expect((base.events[0] as any).item.id).toHaveLength(32);
    expect(updates).toEqual([
      {
        itemId: '1',
        callId: 'c1',
        outputItemId: (base.events[0] as any).item.id,
        type: 'function_call',
        status: 'completed',
        arguments: '{}',
        name: 'tool',
        output: 'output',
      },
    ]);
  });

  it('continues the response when an output projection listener throws', () => {
    const base = new TestBase();
    let outputItemId: string | undefined;
    base.on('item_update', () => {
      outputItemId = (base.events[0] as any).item.id;
      throw new Error('listener failed');
    });

    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'output', true),
    ).not.toThrow();

    expect(base.events.map((event) => event.type)).toEqual([
      'conversation.item.create',
      'response.create',
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      'Error parsing tool call item',
      'object',
    );
    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'retry', false),
    ).toThrow(
      'Function call 1 already has an output pending or confirmed by the Realtime API.',
    );

    acknowledgeHistoryCreate(base, 0, 'conversation.item.done');
    expect(() =>
      base.resetHistory(
        [],
        [
          {
            itemId: outputItemId!,
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'reuse' }],
          },
        ],
      ),
    ).toThrow('conflicts with a visible item ID');

    const inProgressCall = {
      itemId: '1',
      callId: 'c1',
      type: 'function_call' as const,
      status: 'in_progress' as const,
      arguments: '{}',
      name: 'tool',
      output: null,
    };
    const completedCall = {
      ...inProgressCall,
      outputItemId,
      status: 'completed' as const,
      output: 'output',
    };
    expect(() => base.resetHistory([inProgressCall], [completedCall])).toThrow(
      'is already confirmed by the Realtime API',
    );
    expect(() =>
      base.resetHistory(
        [inProgressCall],
        [{ ...completedCall, outputItemId: undefined }],
      ),
    ).toThrow('is already confirmed by the Realtime API');
    expect(base.events).toHaveLength(2);
  });

  it('omits the output predecessor when the function call ID is unavailable', () => {
    const base = new TestBase();
    base.sendFunctionCallOutput(
      {
        ...createToolCall(),
        id: undefined,
      },
      'output',
      false,
    );

    expect(base.events[0]).not.toHaveProperty('previous_item_id');
  });

  it('rolls back an ordinary function call output when its create is rejected', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'server_call',
        response_id: 'response-1',
        output_index: 0,
        item: {
          id: '1',
          type: 'function_call',
          status: 'completed',
          arguments: '{}',
          name: 'tool',
          call_id: 'c1',
        },
      }),
    });

    transport.sendFunctionCallOutput(createToolCall(), 'output', false);
    const outputCreate = transport.events.at(-1) as any;
    expect(session.history[0]).toMatchObject({
      itemId: '1',
      status: 'completed',
      output: 'output',
      outputItemId: outputCreate.item.id,
    });

    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_output_error',
        error: {
          type: 'invalid_request_error',
          code: 'invalid_tool_call_id',
          message: 'The function call no longer exists.',
        },
      }),
    });

    expect(session.history[0]).toEqual({
      itemId: '1',
      callId: 'c1',
      outputItemId: undefined,
      type: 'function_call',
      status: 'in_progress',
      arguments: '{}',
      name: 'tool',
      output: null,
    });

    session.updateHistory([]);
    expect(transport.events.at(-1)).toMatchObject({
      type: 'conversation.item.delete',
      item_id: '1',
    });
  });

  it('matches uncorrelated output rejections in send order', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('error', () => {});
    base.on('item_update', (item) => updates.push(item));
    base.sendFunctionCallOutput(createToolCall(), 'first', false);
    base.sendFunctionCallOutput(
      {
        ...createToolCall(),
        id: '2',
        callId: 'c2',
      },
      'second',
      false,
    );

    const rejectOldestOutput = (eventId: string) =>
      (base as any)._onMessage({
        data: JSON.stringify({
          type: 'error',
          event_id: eventId,
          error: {
            type: 'invalid_request_error',
            code: 'invalid_tool_call_id',
            message: 'The function call no longer exists.',
          },
        }),
      });
    rejectOldestOutput('server_first_output_error');
    rejectOldestOutput('server_second_output_error');

    expect(updates.map((item) => [item.itemId, item.status])).toEqual([
      ['1', 'completed'],
      ['2', 'completed'],
      ['1', 'in_progress'],
      ['2', 'in_progress'],
    ]);
  });

  it('rejects another output while one is awaiting acknowledgement', () => {
    const base = new TestBase();
    base.sendFunctionCallOutput(createToolCall(), 'first', false);

    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'second', true),
    ).toThrow(
      'Function call 1 already has an output pending or confirmed by the Realtime API.',
    );
    expect(base.events).toHaveLength(1);
  });

  it('rejects another output after the first output is acknowledged', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    base.sendFunctionCallOutput(createToolCall(), 'first', false);
    acknowledgeHistoryCreate(base, 0, 'conversation.item.done');

    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'second', false),
    ).toThrow(
      'Function call 1 already has an output pending or confirmed by the Realtime API.',
    );
    expect(base.events).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      itemId: '1',
      status: 'completed',
      output: 'first',
    });
  });

  it('allows retrying an output after its create is rejected', () => {
    const base = new TestBase();
    base.on('error', () => {});
    base.sendFunctionCallOutput(createToolCall(), 'first', false);
    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_first_output_error',
        error: {
          type: 'invalid_request_error',
          code: 'invalid_tool_call_id',
          message: 'The function call no longer exists.',
        },
      }),
    });

    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'retry', false),
    ).not.toThrow();
    expect(base.events).toHaveLength(2);
    expect((base.events[1] as any).item.output).toBe('retry');
  });

  it('clears confirmed output ownership when the transport closes', () => {
    const base = new TestBase();
    base.sendFunctionCallOutput(createToolCall(), 'first', false);
    acknowledgeHistoryCreate(base, 0, 'conversation.item.done');
    (base as any)._onClose();

    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'after reconnect', false),
    ).not.toThrow();
    expect(base.events).toHaveLength(2);
  });

  it('clears confirmed output ownership when the output is deleted', () => {
    const base = new TestBase();
    base.sendFunctionCallOutput(createToolCall(), 'first', false);
    const outputItemId = (base.events[0] as any).item.id;
    acknowledgeHistoryCreate(base, 0, 'conversation.item.done');
    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.deleted',
        event_id: 'server_output_deleted',
        item_id: outputItemId,
      }),
    });

    expect(() =>
      base.sendFunctionCallOutput(createToolCall(), 'replacement', false),
    ).not.toThrow();
    expect(base.events).toHaveLength(2);
  });

  it('sendFunctionCallOutput logs errors when tool call parsing fails', () => {
    const base = new TestBase();
    const toolCall = {
      type: 'function_call',
      id: '1',
      callId: 'c1',
      name: 'tool',
      arguments: 123,
    } as any;

    base.sendFunctionCallOutput(toolCall, 'output', false);

    expect(logger.error).toHaveBeenCalled();
  });

  it.each([true, false])(
    'applies tool-data logging policy to malformed function call items (%s)',
    (redactToolData) => {
      const secret = 'SECRET_REALTIME_TOOL_VALUE_123';
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(
        redactToolData,
      );
      const base = new TestBase();
      const toolCall = {
        type: 'function_call',
        id: '1',
        callId: 'c1',
        name: 'tool',
        arguments: 123,
        secret,
      } as any;

      base.sendFunctionCallOutput(toolCall, secret, false);

      if (redactToolData) {
        expect(logger.error).toHaveBeenCalledWith(
          'Error parsing tool call item',
          'object',
        );
        expect(
          JSON.stringify(vi.mocked(logger.error).mock.calls),
        ).not.toContain(secret);
      } else {
        expect(logger.error).toHaveBeenCalledWith(
          'Error parsing tool call item',
          expect.any(Error),
          toolCall,
        );
      }
    },
  );

  it.each([true, false])(
    'applies model-data logging policy to invalid response events (%s)',
    (redactModelData) => {
      const secret = 'SECRET_REALTIME_MODEL_VALUE_123';
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        redactModelData,
      );
      vi.spyOn(responseDoneEventSchema, 'safeParse').mockReturnValueOnce({
        success: false,
        error: new Error(secret),
      } as any);
      const base = new TestBase();

      (base as any)._onMessage({
        data: JSON.stringify({
          type: 'response.done',
          event_id: 'response-invalid',
          response: { status: 'completed' },
        }),
      });

      if (redactModelData) {
        expect(logger.error).toHaveBeenCalledWith(
          'Error parsing response done event',
          'object',
        );
        expect(
          JSON.stringify(vi.mocked(logger.error).mock.calls),
        ).not.toContain(secret);
      } else {
        expect(logger.error).toHaveBeenCalledWith(
          'Error parsing response done event',
          expect.any(Error),
        );
      }
    },
  );

  it('sendAudio optionally commits', () => {
    const base = new TestBase();
    const buf = new TextEncoder().encode('a').buffer;
    base.sendAudio(buf, { commit: true });
    expect(base.events[0]).toEqual({
      type: 'input_audio_buffer.append',
      audio: expect.any(String),
    });
    expect(base.events[1]).toEqual({ type: 'input_audio_buffer.commit' });
  });

  it('resetHistory sends delete and create events', () => {
    const base = new TestBase();
    const oldHist = [
      {
        itemId: '1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'a' }],
      },
    ];
    const newHist = [
      {
        itemId: '2',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'b' }],
      },
    ];
    base.resetHistory(oldHist as any, newHist as any);

    expect(base.events[0]).toEqual({
      type: 'conversation.item.delete',
      event_id: expect.stringMatching(/^history_/),
      item_id: '1',
    });
    expect(base.events[1]).toEqual({
      type: 'conversation.item.create',
      event_id: expect.stringMatching(/^history_/),
      item: {
        id: '2',
        role: 'user',
        type: 'message',
        status: 'completed',
        content: [{ type: 'input_text', text: 'b' }],
      },
    });
  });

  it('resetHistory restores a function call and updates local history', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const newHist = [
      {
        itemId: 'f1',
        previousItemId: 'm1',
        type: 'function_call',
        status: 'in_progress',
        arguments: '{}',
        name: 'calc',
        output: null,
      },
    ];

    base.resetHistory([], newHist as any);

    expect(updates).toEqual([]);

    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        previous_item_id: 'm1',
        item: {
          id: 'f1',
          type: 'function_call',
          arguments: '{}',
          name: 'calc',
          call_id: 'f1',
        },
      },
    ]);
    acknowledgeHistoryCreate(base, 0);
    expect(updates).toEqual([
      {
        ...newHist[0],
        callId: 'f1',
      },
    ]);
  });

  it('resetHistory omits a null previous item ID for a function call', () => {
    const base = new TestBase();
    const item = {
      itemId: 'f1',
      previousItemId: null,
      type: 'function_call' as const,
      status: 'in_progress' as const,
      arguments: '{}',
      name: 'calc',
      output: null,
    };

    base.resetHistory([], [item]);

    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        item: {
          id: 'f1',
          type: 'function_call',
          arguments: '{}',
          name: 'calc',
          call_id: 'f1',
        },
      },
    ]);
  });

  it('resetHistory preserves local order for mixed message and function call additions', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const addedItems: string[] = [];
    session.on('history_added', (item) => addedItems.push(item.itemId));

    session.updateHistory([
      {
        itemId: 'm1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'use the tool' }],
      },
      {
        itemId: 'f1',
        previousItemId: 'm1',
        type: 'function_call',
        status: 'in_progress',
        arguments: '{}',
        name: 'calc',
        output: null,
      },
    ]);

    expect(session.history).toEqual([]);
    expect(addedItems).toEqual([]);

    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'server_m1',
        previous_item_id: null,
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'use the tool' }],
        },
      }),
    });

    expect(session.history.map((item) => item.itemId)).toEqual(['m1']);
    expect(addedItems).toEqual(['m1']);

    acknowledgeHistoryCreate(transport, 1);

    expect(session.history.map((item) => item.itemId)).toEqual(['m1', 'f1']);
    expect(addedItems).toEqual(['m1', 'f1']);
  });

  it('resetHistory recreates an updated predecessor before a dependent function call', () => {
    const base = new TestBase();
    const oldMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'old' }],
    };
    const updatedMessage = {
      ...oldMessage,
      content: [{ type: 'input_text' as const, text: 'updated' }],
    };

    base.resetHistory(
      [oldMessage],
      [
        updatedMessage,
        {
          itemId: 'f1',
          previousItemId: 'm1',
          type: 'function_call',
          status: 'in_progress',
          arguments: '{}',
          name: 'calc',
          output: null,
        },
      ],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: 'm1',
      },
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'updated' }],
        },
      },
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        previous_item_id: 'm1',
        item: {
          id: 'f1',
          type: 'function_call',
          arguments: '{}',
          name: 'calc',
          call_id: 'f1',
        },
      },
    ]);
  });

  it('resetHistory preserves recreated predecessor order after server echoes', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const receive = (event: Record<string, any>) => {
      (transport as any)._onMessage({ data: JSON.stringify(event) });
    };
    const messageEvent = (text: string) => ({
      type: 'conversation.item.added',
      event_id: `message_${text}`,
      previous_item_id: null,
      item: {
        id: 'm1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text }],
      },
    });
    receive(messageEvent('old'));

    session.updateHistory([
      {
        itemId: 'm1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'updated' }],
      },
      {
        itemId: 'f1',
        previousItemId: 'm1',
        type: 'function_call',
        status: 'in_progress',
        arguments: '{}',
        name: 'calc',
        output: null,
      },
    ]);
    expect(session.history.map((item) => item.itemId)).toEqual(['m1']);

    receive({
      type: 'conversation.item.deleted',
      event_id: 'delete_m1',
      item_id: 'm1',
    });
    receive(messageEvent('updated'));
    acknowledgeHistoryCreate(transport, 2);

    expect(session.history.map((item) => item.itemId)).toEqual(['m1', 'f1']);
  });

  it('retires projected create ownership before recreating a deleted item ID', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const desiredCall = {
      itemId: 'f1',
      callId: 'call_1',
      type: 'function_call' as const,
      status: 'in_progress' as const,
      arguments: '{}',
      name: 'calc',
      output: null,
    };
    const addedItems: string[] = [];
    session.on('history_added', (item) => addedItems.push(item.itemId));

    session.updateHistory([desiredCall]);
    acknowledgeHistoryCreate(transport, 0);
    expect(session.history).toEqual([desiredCall]);

    let restoreAfterDelete = true;
    session.on('history_updated', (history) => {
      if (restoreAfterDelete && history.length === 0) {
        restoreAfterDelete = false;
        session.updateHistory([desiredCall]);
      }
    });
    session.updateHistory([]);
    acknowledgeHistoryDelete(transport, 1);

    expect(transport.events[2]).toMatchObject({
      type: 'conversation.item.create',
      item: { id: 'f1', type: 'function_call' },
    });
    acknowledgeHistoryCreate(transport, 2);
    acknowledgeHistoryCreate(transport, 2, 'conversation.item.done');

    expect(session.history).toEqual([desiredCall]);
    expect(addedItems).toEqual(['f1', 'f1']);
  });

  it('coalesces a queued message replacement during deletion reentry', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const oldMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'old' }],
    };
    const replacement = {
      ...oldMessage,
      content: [{ type: 'input_text' as const, text: 'replacement' }],
    };
    const addedItems: string[] = [];
    session.on('history_added', (item) => addedItems.push(item.itemId));

    session.updateHistory([oldMessage]);
    acknowledgeHistoryCreate(transport, 0);

    let reapplyAfterDelete = true;
    session.on('history_updated', (history) => {
      if (reapplyAfterDelete && history.length === 0) {
        reapplyAfterDelete = false;
        session.updateHistory([replacement]);
      }
    });
    session.updateHistory([replacement]);
    expect(transport.events).toHaveLength(3);

    acknowledgeHistoryDelete(transport, 1);
    expect(transport.events).toHaveLength(3);
    acknowledgeHistoryCreate(transport, 2);
    acknowledgeHistoryCreate(transport, 2, 'conversation.item.done');

    expect(session.history).toEqual([replacement]);
    expect(addedItems).toEqual(['m1', 'm1']);
  });

  it('rejects a conflicting message while its replacement is pending', () => {
    const base = new TestBase();
    const oldMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'old' }],
    };
    const replacement = {
      ...oldMessage,
      content: [{ type: 'input_text' as const, text: 'replacement' }],
    };

    base.resetHistory([], [oldMessage]);
    acknowledgeHistoryCreate(base, 0);
    base.resetHistory([oldMessage], [replacement]);
    acknowledgeHistoryDelete(base, 1);

    expect(() =>
      base.resetHistory(
        [],
        [
          {
            ...replacement,
            content: [{ type: 'input_text', text: 'conflicting' }],
          },
        ],
      ),
    ).toThrow(
      'History message m1 cannot change while its creation is awaiting acknowledgement.',
    );
    expect(base.events).toHaveLength(3);
  });

  it('keeps desired message state through a status-omitting added acknowledgement', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const desiredMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'hello' }],
    };
    let reapplyOnce = true;
    session.on('history_updated', () => {
      if (reapplyOnce) {
        reapplyOnce = false;
        session.updateHistory([desiredMessage]);
      }
    });

    session.updateHistory([desiredMessage]);
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'server_added',
        previous_item_id: null,
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      }),
    });

    expect(session.history).toEqual([desiredMessage]);
    expect(transport.events).toHaveLength(1);
    acknowledgeHistoryCreate(transport, 0, 'conversation.item.done');
    session.updateHistory([desiredMessage]);
    expect(transport.events).toHaveLength(1);
  });

  it('snapshots desired messages before their acknowledgement', () => {
    const base = new TestBase();
    const desiredMessage: RealtimeMessageItem = {
      itemId: 'm1',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [{ type: 'input_text', text: 'original' }],
    };
    const projectedItems: RealtimeMessageItem[] = [];
    base.on('item_update', (item) => {
      if (item.type === 'message') {
        projectedItems.push(item);
      }
    });

    base.resetHistory([], [desiredMessage]);
    const sentEvent = structuredClone(base.events[0]);
    desiredMessage.status = 'incomplete';
    const retainedContent = desiredMessage.content[0];
    if (retainedContent.type !== 'input_text') {
      throw new Error('Expected input_text content');
    }
    retainedContent.text = 'mutated';
    acknowledgeHistoryCreate(base, 0);

    expect(base.events[0]).toEqual(sentEvent);
    expect(projectedItems).toEqual([
      {
        itemId: 'm1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'original' }],
      },
    ]);
  });

  it('resetHistory sends the projected insertion order to the server', () => {
    const base = new TestBase();
    const firstMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'first' }],
    };
    const trailingMessage = {
      itemId: 'm2',
      previousItemId: 'm1',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      content: [{ type: 'output_text' as const, text: 'trailing' }],
    };

    base.resetHistory(
      [firstMessage, trailingMessage],
      [
        firstMessage,
        {
          itemId: 'm-inserted',
          previousItemId: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'inserted' }],
        },
        {
          itemId: 'f1',
          previousItemId: 'm-inserted',
          type: 'function_call',
          status: 'in_progress',
          arguments: '{}',
          name: 'calc',
          output: null,
        },
        trailingMessage,
      ],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        previous_item_id: 'm1',
        item: {
          id: 'm-inserted',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'inserted' }],
        },
      },
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        previous_item_id: 'm-inserted',
        item: {
          id: 'f1',
          type: 'function_call',
          arguments: '{}',
          name: 'calc',
          call_id: 'f1',
        },
      },
    ]);
  });

  it('resetHistory preserves a recreated message chain after server acknowledgements', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const receive = (event: Record<string, any>) => {
      (transport as any)._onMessage({ data: JSON.stringify(event) });
    };
    const messageEvent = (
      type: 'conversation.item.added' | 'conversation.item.done',
      itemId: string,
      previousItemId: string | null,
      text: string,
    ) => ({
      type,
      event_id: `${type}_${itemId}_${text}`,
      previous_item_id: previousItemId,
      item: {
        id: itemId,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text }],
      },
    });
    receive(messageEvent('conversation.item.added', 'm0', null, 'old zero'));
    receive(messageEvent('conversation.item.added', 'm1', 'm0', 'old one'));

    session.updateHistory([
      {
        itemId: 'm0',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'new zero' }],
      },
      {
        itemId: 'm1',
        previousItemId: 'm0',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'new one' }],
      },
      {
        itemId: 'f1',
        previousItemId: 'm1',
        type: 'function_call',
        status: 'in_progress',
        arguments: '{}',
        name: 'calc',
        output: null,
      },
    ]);
    expect(session.history.map((item) => item.itemId)).toEqual(['m0', 'm1']);

    receive({
      type: 'conversation.item.deleted',
      event_id: 'delete_m0',
      item_id: 'm0',
    });
    receive({
      type: 'conversation.item.deleted',
      event_id: 'delete_m1',
      item_id: 'm1',
    });
    receive(messageEvent('conversation.item.added', 'm0', null, 'new zero'));
    receive(messageEvent('conversation.item.done', 'm0', null, 'new zero'));
    receive(messageEvent('conversation.item.added', 'm1', 'm0', 'new one'));
    receive(messageEvent('conversation.item.done', 'm1', 'm0', 'new one'));
    acknowledgeHistoryCreate(transport, 4);

    expect(session.history.map((item) => item.itemId)).toEqual([
      'm0',
      'm1',
      'f1',
    ]);
  });

  it('resetHistory keeps public predecessors when the wire uses a hidden output item', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const retainedCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: 'one',
    };
    session.updateHistory([retainedCall]);
    acknowledgeHistoryCreate(transport, 0);
    acknowledgeHistoryCreate(transport, 1);
    const retainedHistory = [
      retainedCall,
      {
        itemId: 'm1',
        previousItemId: 'f1',
        type: 'message' as const,
        role: 'user' as const,
        status: 'completed' as const,
        content: [{ type: 'input_text' as const, text: 'next' }],
      },
    ];

    session.updateHistory(retainedHistory);
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'message_m1_added',
        previous_item_id: 'fco_1',
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      }),
    });
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.done',
        event_id: 'message_m1_done',
        previous_item_id: 'fco_1',
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      }),
    });

    expect(session.history[1]).toMatchObject({
      itemId: 'm1',
      previousItemId: 'f1',
    });
    const sentEventCount = transport.events.length;
    session.updateHistory([
      ...retainedHistory,
      {
        itemId: 'm2',
        previousItemId: 'm1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'later' }],
      },
    ]);

    expect(transport.events.slice(sentEventCount)).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        previous_item_id: 'm1',
        item: {
          id: 'm2',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'later' }],
        },
      },
    ]);
  });

  it('resetHistory clears stale output identity from a call without output', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const item = {
      itemId: 'f1',
      outputItemId: 'stale-output-id',
      type: 'function_call' as const,
      status: 'in_progress' as const,
      arguments: '{}',
      name: 'calc',
      output: null,
    };

    base.resetHistory([], [item]);

    acknowledgeHistoryCreate(base, 0);

    expect(updates).toEqual([
      {
        ...item,
        callId: 'f1',
        outputItemId: undefined,
      },
    ]);
  });

  it('resetHistory restores a completed function call and its output as a pair', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const item = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{"x":1}',
      name: 'calc',
      callId: 'call_1',
      output: '42',
    };

    base.resetHistory([], [item]);

    const callEvent = base.events[0] as any;
    const outputEvent = base.events[1] as any;
    expect(callEvent).toMatchObject({
      type: 'conversation.item.create',
      item: {
        id: 'f1',
        type: 'function_call',
        call_id: 'call_1',
      },
    });
    expect(outputEvent).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'f1',
      item: {
        id: expect.stringMatching(/^fco_/),
        type: 'function_call_output',
        call_id: 'call_1',
        output: '42',
      },
    });
    expect(outputEvent.item.id).toHaveLength(32);

    acknowledgeHistoryCreate(base, 0);
    acknowledgeHistoryCreate(base, 1);

    expect(updates).toEqual([
      {
        ...item,
        status: 'in_progress',
        output: null,
      },
      {
        ...item,
        outputItemId: outputEvent.item.id,
      },
    ]);
  });

  it('resetHistory anchors a later function call after the prior call output', () => {
    const base = new TestBase();

    base.resetHistory(
      [],
      [
        {
          itemId: 'f1',
          type: 'function_call',
          status: 'completed',
          arguments: '{}',
          name: 'first',
          callId: 'call_1',
          output: 'one',
        },
        {
          itemId: 'f2',
          previousItemId: 'f1',
          type: 'function_call',
          status: 'completed',
          arguments: '{}',
          name: 'second',
          callId: 'call_2',
          output: 'two',
        },
      ],
    );

    const firstOutputId = (base.events[1] as any).item.id;
    expect(firstOutputId).toMatch(/^fco_/);
    expect(base.events[2]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: firstOutputId,
      item: {
        id: 'f2',
        type: 'function_call',
        call_id: 'call_2',
      },
    });
    expect(base.events[3]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'f2',
      item: {
        type: 'function_call_output',
        call_id: 'call_2',
        output: 'two',
      },
    });
  });

  it('resetHistory anchors a later message after the prior call output', () => {
    const base = new TestBase();
    const firstCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'first',
      output: 'one',
    };

    base.resetHistory(
      [firstCall],
      [
        firstCall,
        {
          itemId: 'm1',
          previousItemId: 'f1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      ],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        previous_item_id: 'fco_1',
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      },
    ]);
  });

  it('resetHistory rejects a hidden output predecessor without an item ID before sending', () => {
    const base = new TestBase();
    const firstCall = {
      itemId: 'f1',
      callId: 'call_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'first',
      output: 'one',
    };

    expect(() =>
      base.resetHistory(
        [firstCall],
        [
          firstCall,
          {
            itemId: 'f2',
            previousItemId: 'f1',
            type: 'function_call',
            status: 'in_progress',
            arguments: '{}',
            name: 'second',
            callId: 'call_2',
            output: null,
          },
        ],
      ),
    ).toThrow(
      'Function call history item f2 cannot follow function call f1 because its output item ID is unavailable.',
    );
    expect(base.events).toEqual([]);
  });

  it('resetHistory preserves generated identities across repeated updates', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    base.resetHistory([], [retainedCall]);
    acknowledgeHistoryCreate(base, 0);
    acknowledgeHistoryCreate(base, 1);
    base.events = [];
    base.resetHistory(
      [updates.at(-1)],
      [
        retainedCall,
        {
          itemId: 'm2',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      ],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        item: {
          id: 'm2',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      },
    ]);
  });

  it('normalizes restored completed calls without outputs before later completion', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const restoredCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: null,
    };

    session.updateHistory([restoredCall]);
    acknowledgeHistoryCreate(transport, 0, 'conversation.item.done');

    expect(session.history).toMatchObject([
      { itemId: 'f1', status: 'in_progress', output: null },
    ]);

    session.updateHistory([restoredCall]);
    expect(transport.events).toHaveLength(1);

    session.updateHistory([
      { ...restoredCall, status: 'completed', output: '42' },
    ]);
    const outputItemId = (transport.events[1] as any).item.id;
    expect(transport.events[1]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'f1',
      item: {
        id: outputItemId,
        type: 'function_call_output',
        call_id: 'f1',
        output: '42',
      },
    });
    acknowledgeHistoryCreate(transport, 1, 'conversation.item.done');
    expect(session.history).toEqual([
      {
        ...restoredCall,
        callId: 'f1',
        outputItemId,
        output: '42',
      },
    ]);
  });

  it('coalesces a retained completion reapplied from history_updated', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([retainedCall]);
    const pendingOutputId = (transport.events[1] as any).item.id;
    session.on('history_updated', (history) => {
      if (
        history.length === 1 &&
        history[0]?.type === 'function_call' &&
        history[0].output === null
      ) {
        session.updateHistory([retainedCall]);
      }
    });

    acknowledgeHistoryCreate(transport, 0);

    expect(transport.events).toHaveLength(2);
    acknowledgeHistoryCreate(transport, 1);
    expect(session.history).toEqual([
      {
        ...retainedCall,
        callId: 'f1',
        outputItemId: pendingOutputId,
      },
    ]);
  });

  it('coalesces repeated completed restores before the first acknowledgement', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([retainedCall]);
    const pendingOutputId = (transport.events[1] as any).item.id;
    session.updateHistory([retainedCall]);

    expect(transport.events).toHaveLength(2);
    expect((transport.events[1] as any).item.id).toBe(pendingOutputId);
    acknowledgeHistoryCreate(transport, 0);
    acknowledgeHistoryCreate(transport, 1);
    expect(session.history).toEqual([
      {
        ...retainedCall,
        callId: 'f1',
        outputItemId: pendingOutputId,
      },
    ]);
  });

  it('rejects a conflicting repeated restore before the first acknowledgement', () => {
    const base = new TestBase();
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    base.resetHistory([], [retainedCall]);

    expect(() =>
      base.resetHistory([], [{ ...retainedCall, output: 'changed' }]),
    ).toThrow(
      'Function call history item f1 cannot change its output while the previous output is awaiting acknowledgement.',
    );
    expect(base.events).toHaveLength(2);
  });

  it('retries only the missing output after a synchronous partial send', () => {
    const base = new ThrowingTestBase(2);
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    expect(() => base.resetHistory([], [retainedCall])).toThrow('send failed');
    expect(base.events).toHaveLength(1);

    base.resetHistory([], [retainedCall]);

    expect(base.events).toHaveLength(2);
    expect(base.events.map((event) => (event as any).item.type)).toEqual([
      'function_call',
      'function_call_output',
    ]);
  });

  it('rejects a changed completion while its output is pending', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    base.resetHistory([], [retainedCall]);
    acknowledgeHistoryCreate(base, 0);

    expect(() =>
      base.resetHistory(
        [updates.at(-1)],
        [{ ...retainedCall, output: 'changed' }],
      ),
    ).toThrow(
      'Function call history item f1 cannot change its output while the previous output is awaiting acknowledgement.',
    );
    expect(base.events).toHaveLength(2);
  });

  it('resetHistory reuses a supplied output item ID across repeated updates', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const retainedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      callId: 'call_1',
      outputItemId: 'fco_persisted_output',
      output: '42',
    };

    base.resetHistory([], [retainedCall]);
    acknowledgeHistoryCreate(base, 0);
    acknowledgeHistoryCreate(base, 1);

    expect((base.events[1] as any).item.id).toBe('fco_persisted_output');
    expect(updates.at(-1)).toEqual(retainedCall);

    base.events = [];
    base.resetHistory(
      [updates.at(-1)],
      [
        retainedCall,
        {
          itemId: 'm2',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      ],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.stringMatching(/^history_/),
        item: {
          id: 'm2',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'next' }],
        },
      },
    ]);
  });

  it('resetHistory forwards an empty supplied output item ID', () => {
    const base = new TestBase();
    const item = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      callId: 'call_1',
      outputItemId: '',
      output: '42',
    };

    base.resetHistory([], [item]);

    expect((base.events[1] as any).item.id).toBe('');

    base.events = [];
    base.resetHistory([item], []);

    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: '',
      },
    ]);
    acknowledgeHistoryDelete(base, 0);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: '',
      },
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: 'f1',
      },
    ]);
  });

  it('resetHistory deletes a function call after its output acknowledgement', () => {
    const base = new TestBase();
    base.resetHistory(
      [
        {
          itemId: 'f1',
          outputItemId: 'fo1',
          type: 'function_call',
          status: 'completed',
          arguments: '{}',
          name: 'calc',
          output: '42',
        },
      ] as any,
      [],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: 'fo1',
      },
    ]);
    acknowledgeHistoryDelete(base, 0);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: 'fo1',
      },
      {
        type: 'conversation.item.delete',
        event_id: expect.stringMatching(/^history_/),
        item_id: 'f1',
      },
    ]);
  });

  it('resetHistory rejects unsupported function call mutations before sending events', () => {
    const original = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    const missingOutputId = new TestBase();
    expect(() => missingOutputId.resetHistory([original], [])).toThrow(
      'output item ID is unavailable',
    );
    expect(missingOutputId.events).toEqual([]);

    const update = new TestBase();
    expect(() =>
      update.resetHistory(
        [{ ...original, output: null }],
        [{ ...original, output: '43' }],
      ),
    ).toThrow('cannot be updated in place');
    expect(update.events).toEqual([]);

    const incompleteOutput = new TestBase();
    expect(() =>
      incompleteOutput.resetHistory(
        [],
        [{ ...original, status: 'in_progress' }],
      ),
    ).toThrow('must be completed when it has an output');
    expect(incompleteOutput.events).toEqual([]);

    const retainedIncompleteOutput = new TestBase();
    const retainedIncompleteCall = {
      ...original,
      outputItemId: 'fco_1',
      status: 'in_progress' as const,
    };
    expect(() =>
      retainedIncompleteOutput.resetHistory(
        [retainedIncompleteCall],
        [
          retainedIncompleteCall,
          {
            itemId: 'm1',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'next' }],
          },
        ],
      ),
    ).toThrow('must be completed when it has an output');
    expect(retainedIncompleteOutput.events).toEqual([]);

    const duplicate = new TestBase();
    expect(() =>
      duplicate.resetHistory(
        [],
        [
          { ...original, output: null },
          { ...original, output: null },
        ],
      ),
    ).toThrow('appears more than once');
    expect(duplicate.events).toHaveLength(0);

    const mixedDuplicate = new TestBase();
    expect(() =>
      mixedDuplicate.resetHistory([], [
        { ...original, output: null },
        {
          itemId: 'f1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'same ID' }],
        },
      ] as any),
    ).toThrow('appears more than once');
    expect(mixedDuplicate.events).toHaveLength(0);

    const unchangedDuplicate = new TestBase();
    expect(() =>
      unchangedDuplicate.resetHistory(
        [{ ...original, output: null }],
        [
          { ...original, output: null },
          { ...original, output: null },
        ],
      ),
    ).toThrow('appears more than once');
    expect(unchangedDuplicate.events).toHaveLength(0);

    const duplicateMessages = new TestBase();
    expect(() =>
      duplicateMessages.resetHistory(
        [],
        [
          {
            itemId: 'm1',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'first' }],
          },
          {
            itemId: 'm1',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'second' }],
          },
        ],
      ),
    ).toThrow('appears more than once');
    expect(duplicateMessages.events).toHaveLength(0);
  });

  it('resetHistory rejects cross-kind reuse of a pending item ID', () => {
    const message = {
      itemId: 'same',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'message' }],
    };
    const functionCall = {
      itemId: 'same',
      type: 'function_call' as const,
      status: 'in_progress' as const,
      arguments: '{}',
      name: 'tool',
      output: null,
    };

    const messageThenCall = new TestBase();
    messageThenCall.resetHistory([], [message]);
    expect(() => messageThenCall.resetHistory([], [functionCall])).toThrow(
      'cannot change type while its creation is awaiting acknowledgement',
    );
    expect(messageThenCall.events).toHaveLength(1);

    const callThenMessage = new TestBase();
    callThenMessage.resetHistory([], [functionCall]);
    expect(() => callThenMessage.resetHistory([], [message])).toThrow(
      'cannot change type while its creation is awaiting acknowledgement',
    );
    expect(callThenMessage.events).toHaveLength(1);
  });

  it('resetHistory rejects duplicate output item IDs before sending events', () => {
    const base = new TestBase();
    const completedCall = {
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      outputItemId: 'fco_shared',
      output: '42',
    };

    expect(() =>
      base.resetHistory(
        [
          { ...completedCall, itemId: 'f1', callId: 'call_1' },
          { ...completedCall, itemId: 'f2', callId: 'call_2' },
        ],
        [],
      ),
    ).toThrow(
      'Function call output item fco_shared appears more than once in the current history.',
    );
    expect(base.events).toEqual([]);
  });

  it('resetHistory rejects output item IDs that collide with visible item IDs', () => {
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };
    const message = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'visible' }],
    };

    const currentCollision = new TestBase();
    expect(() =>
      currentCollision.resetHistory(
        [message, { ...completedCall, outputItemId: 'm1' }],
        [],
      ),
    ).toThrow(
      'Function call output item m1 conflicts with a visible item ID in the current history.',
    );
    expect(currentCollision.events).toEqual([]);

    const updatedCollision = new TestBase();
    expect(() =>
      updatedCollision.resetHistory(
        [],
        [
          { ...completedCall, outputItemId: 'f2' },
          {
            ...completedCall,
            itemId: 'f2',
            callId: 'call_2',
            status: 'in_progress',
            output: null,
          },
        ],
      ),
    ).toThrow(
      'Function call output item f2 conflicts with a visible item ID in the updated history.',
    );
    expect(updatedCollision.events).toEqual([]);
  });

  it('resetHistory rejects reusing a removed call output ID for a visible item', () => {
    const base = new TestBase();
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_existing',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    expect(() =>
      base.resetHistory(
        [completedCall],
        [
          {
            itemId: 'fco_existing',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'replacement' }],
          },
        ],
      ),
    ).toThrow(
      'Function call output item fco_existing conflicts with a visible item ID in the updated history.',
    );
    expect(base.events).toEqual([]);
  });

  it('resetHistory rejects a visible ID owned by a pending completion output', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const completedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    base.resetHistory([], [completedCall]);
    const pendingOutputItemId = (base.events[1] as any).item.id;
    acknowledgeHistoryCreate(base, 0, 'conversation.item.done');

    expect(() =>
      base.resetHistory(
        [updates.at(-1)],
        [
          completedCall,
          {
            itemId: pendingOutputItemId,
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'next' }],
          },
        ],
      ),
    ).toThrow(
      `Function call output item ${pendingOutputItemId} conflicts with a visible item ID in the updated history.`,
    );
    expect(base.events).toHaveLength(2);
  });

  it('resetHistory rejects a replacement ID owned by a pending output', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const completedCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    base.resetHistory([], [completedCall]);
    const pendingOutputItemId = (base.events[1] as any).item.id;
    acknowledgeHistoryCreate(base, 0, 'conversation.item.done');

    expect(() =>
      base.resetHistory(
        [updates.at(-1)],
        [
          {
            itemId: pendingOutputItemId,
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'replacement' }],
          },
        ],
      ),
    ).toThrow(
      `Function call output item ${pendingOutputItemId} conflicts with a visible item ID in the updated history.`,
    );
    expect(base.events).toHaveLength(2);
  });

  it('resetHistory does not project a mixed batch when a synchronous send fails', () => {
    const base = new ThrowingTestBase(2);
    const updates: any[] = [];
    const deletions: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    base.on('item_deleted', (item) => deletions.push(item));
    const oldMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'old' }],
    };

    expect(() =>
      base.resetHistory(
        [oldMessage],
        [
          {
            ...oldMessage,
            content: [{ type: 'input_text', text: 'updated' }],
          },
          {
            itemId: 'f1',
            previousItemId: 'm1',
            type: 'function_call',
            status: 'in_progress',
            arguments: '{}',
            name: 'calc',
            output: null,
          },
        ],
      ),
    ).toThrow('send failed');
    expect(updates).toEqual([]);
    expect(deletions).toEqual([]);

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.deleted',
        event_id: 'delete_m1',
        item_id: 'm1',
      }),
    });
    expect(deletions).toEqual([{ itemId: 'm1' }]);
  });

  it('sendMcpResponse emits approval response items', () => {
    const base = new TestBase();
    base.sendMcpResponse(
      {
        itemId: 'mcp1',
        type: 'mcp_approval_request',
        serverLabel: 'srv',
        name: 'tool',
        arguments: { foo: 'bar' },
        approved: null,
      },
      true,
    );

    expect(base.events[0]).toEqual({
      type: 'conversation.item.create',
      previous_item_id: 'mcp1',
      item: {
        type: 'mcp_approval_response',
        approval_request_id: 'mcp1',
        approve: true,
      },
    });
  });

  it('sendMcpResponse includes rejection reasons when provided', () => {
    const base = new TestBase();
    base.sendMcpResponse(
      {
        itemId: 'mcp2',
        type: 'mcp_approval_request',
        serverLabel: 'srv',
        name: 'tool',
        arguments: { foo: 'bar' },
        approved: null,
      },
      false,
      'Denied by policy',
    );

    expect(base.events[0]).toEqual({
      type: 'conversation.item.create',
      previous_item_id: 'mcp2',
      item: {
        type: 'mcp_approval_response',
        approval_request_id: 'mcp2',
        approve: false,
        reason: 'Denied by policy',
      },
    });
  });

  it('routes response.done usage and turn events', () => {
    const base = new TestBase();
    const usages: any[] = [];
    const turns: any[] = [];
    base.on('usage_update', (u) => usages.push(u));
    base.on('turn_done', (t) => turns.push(t));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.done',
        event_id: 'e1',
        response: {
          id: 'r1',
          output: [{ type: 'output_text', text: 'hi' }],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      }),
    });

    expect(usages[0]?.totalTokens).toBe(5);
    expect(turns[0]?.response.id).toBe('r1');
    expect(turns[0]?.response.output).toHaveLength(1);
  });

  it('handles audio done and fires afterAudioDoneEvent', () => {
    const base = new TestBase();
    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_audio.done',
        event_id: 'e2',
        item_id: 'it1',
        content_index: 0,
        output_index: 0,
        response_id: 'r2',
      }),
    });
    expect(base.afterAudioDoneCalled).toBe(1);
    expect(base.events).toHaveLength(0);
  });

  it('requests item retrieval on transcription completion or truncation', () => {
    const completedBase = new TestBase();
    (completedBase as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'c_done',
        item_id: 'x2',
        content_index: 0,
        transcript: 'done',
      }),
    });
    expect(completedBase.events[0]).toEqual({
      type: 'conversation.item.retrieve',
      item_id: 'x2',
    });

    const truncatedBase = new TestBase();
    (truncatedBase as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.truncated',
        event_id: 'c_trunc',
        item_id: 'x3',
        audio_end_ms: 10,
        content_index: 0,
      }),
    });
    expect(truncatedBase.events[0]).toEqual({
      type: 'conversation.item.retrieve',
      item_id: 'x3',
    });
  });

  it('emits message and mcp approval items on item updates', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    const approvals: any[] = [];
    base.on('mcp_approval_request', (req) => approvals.push(req));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'c1',
        item: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
          status: 'in_progress',
        },
        previous_item_id: null,
      }),
    });

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.done',
        event_id: 'c2',
        item: {
          id: 'a1',
          type: 'mcp_approval_request',
          server_label: 's1',
          name: 'tool',
          arguments: '{"x":1}',
          approved: null,
        },
      }),
    });

    expect(updates.some((u) => u.type === 'message')).toBe(true);
    expect(approvals[0]?.serverLabel).toBe('s1');
  });

  it('reaches session history when the server omits status', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');

    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const historyEvents: any[][] = [];
    session.on('history_updated', (history) =>
      historyEvents.push([...history]),
    );

    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'e1',
        item: {
          id: 'u1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        previous_item_id: null,
      }),
    });

    expect(session.history.map((item) => item.itemId)).toEqual(['u1']);
    expect(session.history[0]).toMatchObject({ status: 'in_progress' });
    expect(historyEvents.at(-1)?.map((item) => item.itemId)).toEqual(['u1']);
  });

  it('normalizes missing statuses and preserves explicit statuses', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));

    const send = (type: string, id: string, status?: string) =>
      (base as any)._onMessage({
        data: JSON.stringify({
          type,
          event_id: `e_${id}`,
          item: {
            id,
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
            ...(status ? { status } : {}),
          },
          previous_item_id: null,
        }),
      });

    send('conversation.item.added', 'a1');
    send('conversation.item.done', 'd1');
    send('conversation.item.retrieved', 'r1');
    send('conversation.item.done', 'p1', 'in_progress');
    send('conversation.item.done', 'i1', 'incomplete');

    expect(updates.map((update) => [update.itemId, update.status])).toEqual([
      ['a1', 'in_progress'],
      ['d1', 'completed'],
      ['r1', 'completed'],
      ['p1', 'in_progress'],
      ['i1', 'incomplete'],
    ]);
  });

  it('emits function_call and mcp call updates on output items', () => {
    const base = new TestBase();
    const funcs: any[] = [];
    base.on('function_call', (f) => funcs.push(f));
    const updates: any[] = [];
    base.on('item_update', (i) => updates.push(i));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'o1',
        response_id: 'r3',
        output_index: 0,
        item: {
          id: 'f1',
          type: 'function_call',
          status: 'completed',
          arguments: '{}',
          name: 'calc',
          call_id: 'c1',
        },
      }),
    });

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.added',
        event_id: 'o2',
        response_id: 'r4',
        output_index: 0,
        item: {
          id: 'mcp1',
          type: 'mcp_call',
          status: 'in_progress',
          arguments: '{}',
          name: 'list',
          output: null,
        },
      }),
    });

    expect(funcs[0]?.name).toBe('calc');
    expect(funcs[0]?.responseId).toBe('r3');
    expect(updates.find((u) => u.itemId === 'f1')?.callId).toBe('c1');
    expect(updates.find((u) => (u as any).itemId === 'mcp1')).toBeTruthy();
  });

  it('preserves GA output_audio content on output item messages', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (i) => updates.push(i));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.added',
        event_id: 'o3',
        response_id: 'r5',
        output_index: 0,
        item: {
          id: 'audio1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_audio',
              audio: 'base64data',
              transcript: 'hi',
            },
          ],
        },
      }),
    });

    expect(updates[0]).toMatchObject({
      itemId: 'audio1',
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [
        {
          type: 'output_audio',
          audio: 'base64data',
          transcript: 'hi',
        },
      ],
    });
  });

  it('normalizes legacy audio content on output item messages', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (i) => updates.push(i));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'o4',
        response_id: 'r6',
        output_index: 0,
        item: {
          id: 'audio2',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'audio',
              audio: 'legacydata',
              transcript: 'hello',
            },
          ],
        },
      }),
    });

    expect(updates[0]).toMatchObject({
      itemId: 'audio2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_audio',
          audio: 'legacydata',
          transcript: 'hello',
        },
      ],
    });
  });

  it('retrieves MCP tool call items on in-progress signals', () => {
    const base = new TestBase();

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.mcp_call.in_progress',
        event_id: 'm1',
        response_id: 'r5',
        output_index: 0,
        item_id: 'm1',
      }),
    });
    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'mcp_list_tools.in_progress',
        item_id: 'tools1',
      }),
    });

    expect(base.events).toEqual([
      { type: 'conversation.item.retrieve', item_id: 'm1' },
      { type: 'conversation.item.retrieve', item_id: 'tools1' },
    ]);
  });

  it('emits audio transcript delta events', () => {
    const base = new TestBase();
    const deltas: any[] = [];
    base.on('audio_transcript_delta', (delta) => deltas.push(delta));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        event_id: 'd1',
        item_id: 'item1',
        content_index: 0,
        delta: 'hi',
        output_index: 0,
        response_id: 'r1',
      }),
    });

    expect(deltas[0]).toMatchObject({
      delta: 'hi',
      itemId: 'item1',
      responseId: 'r1',
    });
  });

  it('emits output text delta events', () => {
    const base = new TestBase();
    const deltas: any[] = [];
    base.on('output_text_delta', (delta) => deltas.push(delta));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_text.delta',
        event_id: 'd1',
        item_id: 'item1',
        content_index: 0,
        delta: 'hi',
        output_index: 0,
        response_id: 'r1',
      }),
    });

    expect(deltas[0]).toMatchObject({
      type: 'output_text_delta',
      delta: 'hi',
      itemId: 'item1',
      responseId: 'r1',
    });
  });

  it('emits mcp_tools_listed for completed list tools items', () => {
    const base = new TestBase();
    const listed: any[] = [];
    base.on('mcp_tools_listed', (event) => listed.push(event));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.done',
        event_id: 'c3',
        item: {
          id: 'tools1',
          type: 'mcp_list_tools',
          server_label: 'srv',
          tools: [{ name: 'tool', description: 'desc' }],
        },
      }),
    });

    expect(listed[0]).toMatchObject({
      serverLabel: 'srv',
      tools: [{ name: 'tool', description: 'desc' }],
    });
  });

  it.each([true, false])(
    'applies tool-data logging policy when MCP tool events fail (%s)',
    (redactToolData) => {
      const secret = 'SECRET_MCP_EVENT_VALUE_123';
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(
        redactToolData,
      );
      const base = new TestBase();
      base.on('mcp_tools_listed', () => {
        throw new Error(secret);
      });

      (base as any)._onMessage({
        data: JSON.stringify({
          type: 'conversation.item.done',
          event_id: 'mcp-secret-event',
          item: {
            id: 'tools1',
            type: 'mcp_list_tools',
            server_label: 'srv',
            tools: [{ name: 'tool', description: secret }],
          },
        }),
      });

      if (redactToolData) {
        expect(logger.error).toHaveBeenCalledWith(
          'Error emitting mcp_tools_listed',
          'object',
        );
        expect(
          JSON.stringify(vi.mocked(logger.error).mock.calls),
        ).not.toContain(secret);
      } else {
        expect(logger.error).toHaveBeenCalledWith(
          'Error emitting mcp_tools_listed',
          expect.any(Error),
          expect.objectContaining({
            tools: [{ name: 'tool', description: secret }],
          }),
        );
      }
    },
  );

  it('emits error events when server reports errors', () => {
    const base = new TestBase();
    const errors: any[] = [];
    base.on('error', (err) => errors.push(err));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'e1',
        error: { message: 'nope' },
      }),
    });

    expect(errors[0]?.error?.error?.message).toBe('nope');
  });

  it('stops suppressing a replay acknowledgement after its request errors', () => {
    const base = new TestBase();
    const errors: any[] = [];
    const updates: any[] = [];
    base.on('error', (error) => errors.push(error));
    base.on('item_update', (item) => updates.push(item));
    base.resetHistory(
      [],
      [
        {
          itemId: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        {
          itemId: 'f1',
          previousItemId: 'm1',
          type: 'function_call',
          status: 'in_progress',
          arguments: '{}',
          name: 'calc',
          output: null,
        },
      ],
    );
    const messageCreate = base.events.find(
      (event) =>
        event.type === 'conversation.item.create' &&
        event.item?.type === 'message',
    );
    expect(messageCreate?.event_id).toEqual(expect.stringMatching(/^history_/));

    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_error',
        error: {
          event_id: messageCreate?.event_id,
          message: 'create failed',
        },
      }),
    });
    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'message_added',
        previous_item_id: null,
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      }),
    });

    expect(errors).toHaveLength(1);
    expect(updates.filter((item) => item.itemId === 'm1')).toHaveLength(1);
  });

  it('keeps rejected replay creates out of session history so they can be retried', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    const desiredHistory = [
      {
        itemId: 'm1',
        type: 'message' as const,
        role: 'user' as const,
        status: 'completed' as const,
        content: [{ type: 'input_text' as const, text: 'hello' }],
      },
      {
        itemId: 'f1',
        previousItemId: 'm1',
        type: 'function_call' as const,
        status: 'in_progress' as const,
        arguments: '{}',
        name: 'calc',
        output: null,
      },
    ];

    session.updateHistory(desiredHistory);
    expect(session.history).toEqual([]);

    for (const event of transport.events) {
      (transport as any)._onMessage({
        data: JSON.stringify({
          type: 'error',
          event_id: `server_error_${event.event_id}`,
          error: {
            event_id: event.event_id,
            message: 'create failed',
          },
        }),
      });
    }

    expect(session.history).toEqual([]);
    const firstAttemptCount = transport.events.length;
    session.updateHistory(desiredHistory);

    expect(transport.events).toHaveLength(firstAttemptCount + 2);
    expect(
      transport.events.slice(firstAttemptCount).map((event) => event.item?.id),
    ).toEqual(['m1', 'f1']);
  });

  it('keeps a rejected replay deletion in session history so it can be retried', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'server_existing_message',
        previous_item_id: null,
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'keep me' }],
        },
      }),
    });

    session.updateHistory([]);
    const firstDelete = transport.events[0];
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_delete_error',
        error: {
          event_id: firstDelete.event_id,
          message: 'delete failed',
        },
      }),
    });

    expect(session.history.map((item) => item.itemId)).toEqual(['m1']);
    session.updateHistory([]);
    expect(transport.events).toHaveLength(2);
    expect(transport.events[1]).toMatchObject({
      type: 'conversation.item.delete',
      item_id: 'm1',
    });
  });

  it('projects a successful output deletion when the call deletion is rejected', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([completedCall]);
    acknowledgeHistoryCreate(transport, 0, 'conversation.item.done');
    acknowledgeHistoryCreate(transport, 1, 'conversation.item.done');
    expect(session.history).toEqual([completedCall]);

    session.updateHistory([]);
    acknowledgeHistoryDelete(transport, 2);
    expect(session.history).toEqual([
      {
        ...completedCall,
        status: 'in_progress',
        outputItemId: undefined,
        output: null,
      },
    ]);

    const callDelete = transport.events[3];
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_call_delete_error',
        error: {
          event_id: callDelete.event_id,
          message: 'delete failed',
        },
      }),
    });

    expect(session.history).toEqual([
      {
        ...completedCall,
        status: 'in_progress',
        outputItemId: undefined,
        output: null,
      },
    ]);

    session.updateHistory([completedCall]);
    expect(transport.events[4]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'f1',
      item: {
        id: 'fco_1',
        type: 'function_call_output',
        call_id: 'call_1',
        output: '42',
      },
    });
  });

  it('coalesces a reentrant call deletion after output deletion is acknowledged', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([completedCall]);
    acknowledgeHistoryCreate(transport, 0);
    acknowledgeHistoryCreate(transport, 1);

    let emptyHistoryUpdates = 0;
    session.on('history_updated', (history) => {
      if (history.length === 0) {
        emptyHistoryUpdates += 1;
      }
      if (
        history.length === 1 &&
        history[0]?.type === 'function_call' &&
        history[0].output === null
      ) {
        session.updateHistory([]);
      }
    });

    session.updateHistory([]);
    acknowledgeHistoryDelete(transport, 2);

    const callDeletes = transport.events.filter(
      (event) =>
        event.type === 'conversation.item.delete' && event.item_id === 'f1',
    );
    expect(callDeletes).toHaveLength(1);
    acknowledgeHistoryDelete(transport, 3);
    expect(session.history).toEqual([]);
    expect(emptyHistoryUpdates).toBe(1);
  });

  it('coalesces output replay while the paired call deletion is pending', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([completedCall]);
    acknowledgeHistoryCreate(transport, 0, 'conversation.item.done');
    acknowledgeHistoryCreate(transport, 1, 'conversation.item.done');
    session.on('history_updated', (history) => {
      if (
        history.length === 1 &&
        history[0]?.type === 'function_call' &&
        history[0].output === null
      ) {
        session.updateHistory([completedCall]);
      }
    });

    session.updateHistory([]);
    acknowledgeHistoryDelete(transport, 2);

    const outputCreates = transport.events.filter(
      (event) =>
        event.type === 'conversation.item.create' &&
        event.item.type === 'function_call_output',
    );
    expect(outputCreates).toHaveLength(1);
    expect(transport.events[3]).toMatchObject({
      type: 'conversation.item.delete',
      item_id: 'f1',
    });
    acknowledgeHistoryDelete(transport, 3);
    expect(session.history).toEqual([]);
  });

  it('pairs deletion with an output restore awaiting acknowledgement', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([completedCall]);
    const pendingOutputId = (transport.events[1] as any).item.id;
    session.on('history_updated', (history) => {
      if (
        history.length === 1 &&
        history[0]?.type === 'function_call' &&
        history[0].output === null
      ) {
        session.updateHistory([]);
      }
    });

    acknowledgeHistoryCreate(transport, 0, 'conversation.item.done');

    expect(transport.events[2]).toMatchObject({
      type: 'conversation.item.delete',
      item_id: pendingOutputId,
    });
    expect(
      transport.events.filter(
        (event) =>
          event.type === 'conversation.item.delete' && event.item_id === 'f1',
      ),
    ).toHaveLength(0);

    acknowledgeHistoryCreate(transport, 1, 'conversation.item.done');
    acknowledgeHistoryDelete(transport, 2);
    expect(transport.events[3]).toMatchObject({
      type: 'conversation.item.delete',
      item_id: 'f1',
    });
    acknowledgeHistoryDelete(transport, 3);
    expect(session.history).toEqual([]);
  });

  it('retries call deletion after a pending output and its deletion are rejected', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([completedCall]);
    acknowledgeHistoryCreate(transport, 0, 'conversation.item.done');
    session.updateHistory([]);
    const outputCreate = transport.events[1];
    const outputDelete = transport.events[2];

    for (const event of [outputCreate, outputDelete]) {
      (transport as any)._onMessage({
        data: JSON.stringify({
          type: 'error',
          event_id: `server_error_${event.event_id}`,
          error: {
            event_id: event.event_id,
            message: 'request rejected',
          },
        }),
      });
    }

    expect(session.history).toMatchObject([
      { itemId: 'f1', status: 'in_progress', output: null },
    ]);
    session.updateHistory([]);
    expect(transport.events[3]).toMatchObject({
      type: 'conversation.item.delete',
      item_id: 'f1',
    });
    acknowledgeHistoryDelete(transport, 3);
    expect(session.history).toEqual([]);
  });

  it('retries output deletion before sending the paired call deletion', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    const completedCall = {
      itemId: 'f1',
      callId: 'call_1',
      outputItemId: 'fco_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([completedCall]);
    acknowledgeHistoryCreate(transport, 0);
    acknowledgeHistoryCreate(transport, 1);
    session.updateHistory([]);
    const rejectedOutputDelete = transport.events[2];
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_output_delete_error',
        error: {
          event_id: rejectedOutputDelete.event_id,
          message: 'output delete rejected',
        },
      }),
    });

    expect(session.history).toEqual([completedCall]);
    expect(transport.events).toHaveLength(3);

    session.updateHistory([]);
    expect(transport.events).toHaveLength(4);
    expect(transport.events[3]).toMatchObject({
      type: 'conversation.item.delete',
      item_id: 'fco_1',
    });
  });

  it('retries a rejected function call output without recreating the call', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    session.on('error', () => {});
    await session.connect({ apiKey: 'test' });
    const desiredCall = {
      itemId: 'f1',
      type: 'function_call' as const,
      status: 'completed' as const,
      arguments: '{}',
      name: 'calc',
      output: '42',
    };

    session.updateHistory([desiredCall]);
    acknowledgeHistoryCreate(transport, 0);
    const rejectedOutput = transport.events[1];
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'server_output_error',
        error: {
          event_id: rejectedOutput.event_id,
          message: 'output rejected',
        },
      }),
    });
    expect(session.history).toMatchObject([
      {
        itemId: 'f1',
        callId: 'f1',
        status: 'in_progress',
        output: null,
      },
    ]);

    session.updateHistory([desiredCall]);

    expect(transport.events).toHaveLength(3);
    expect(transport.events[2]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'f1',
      item: {
        id: expect.stringMatching(/^fco_/),
        type: 'function_call_output',
        call_id: 'f1',
        output: '42',
      },
    });
    acknowledgeHistoryCreate(transport, 2);
    expect(session.history).toMatchObject([
      {
        ...desiredCall,
        callId: 'f1',
        outputItemId: (transport.events[2] as any).item.id,
      },
    ]);
  });

  it('projects an acknowledged explicit-root function call at the beginning', async () => {
    const { RealtimeSession } = await import('../src/realtimeSession');
    const { RealtimeAgent } = await import('../src/realtimeAgent');
    const transport = new TestBase();
    const session = new RealtimeSession(new RealtimeAgent({ name: 'a' }), {
      transport,
    });
    await session.connect({ apiKey: 'test' });
    const trailingMessage = {
      itemId: 'm1',
      type: 'message' as const,
      role: 'user' as const,
      status: 'completed' as const,
      content: [{ type: 'input_text' as const, text: 'existing' }],
    };
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'server_existing_message',
        previous_item_id: null,
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'existing' }],
        },
      }),
    });

    session.updateHistory([
      {
        itemId: 'f1',
        previousItemId: 'root',
        type: 'function_call',
        status: 'in_progress',
        arguments: '{}',
        name: 'calc',
        output: null,
      },
      trailingMessage,
    ]);

    const callCreateIndex = transport.events.findIndex(
      (event) =>
        event.type === 'conversation.item.create' &&
        event.item?.type === 'function_call',
    );
    expect(transport.events[callCreateIndex]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'root',
      item: { id: 'f1', type: 'function_call' },
    });
    for (const [index, event] of transport.events.entries()) {
      if (event.type === 'conversation.item.delete') {
        acknowledgeHistoryDelete(transport, index);
      } else {
        acknowledgeHistoryCreate(transport, index);
      }
    }
    expect(session.history.map((item) => item.itemId)).toEqual(['f1', 'm1']);
  });

  it('clears replay acknowledgement ownership when the transport closes', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (item) => updates.push(item));
    base.resetHistory(
      [],
      [
        {
          itemId: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        {
          itemId: 'f1',
          previousItemId: 'm1',
          type: 'function_call',
          status: 'in_progress',
          arguments: '{}',
          name: 'calc',
          output: null,
        },
      ],
    );

    (base as any)._onClose();
    (base as any)._onMessage({
      data: JSON.stringify({
        type: 'conversation.item.added',
        event_id: 'message_added',
        previous_item_id: null,
        item: {
          id: 'm1',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      }),
    });

    expect(updates.filter((item) => item.itemId === 'm1')).toHaveLength(1);
  });

  it('maps input_image content and merges provider data', () => {
    const base = new TestBase();
    base.sendMessage(
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image: 'data:image/png;base64,abc',
            providerData: { detail: 'high' },
          },
        ],
      },
      { extra: 'meta' },
      { triggerResponse: false },
    );

    expect(base.events[0]).toEqual({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,abc',
            detail: 'high',
          },
        ],
      },
      extra: 'meta',
    });
    expect(base.events).toHaveLength(1);
  });

  it('emits connection events on open/close hooks', () => {
    const base = new TestBase();
    const connected: any[] = [];
    const disconnected: any[] = [];
    base.on('connected', () => connected.push(true));
    base.on('disconnected', () => disconnected.push(true));

    (base as any)._onOpen();
    (base as any)._onClose();

    expect(connected).toHaveLength(1);
    expect(disconnected).toHaveLength(1);
  });

  it('enforces tracing config transitions', () => {
    const base = new TestBase();
    const sendSpy = vi.spyOn(base, 'sendEvent');

    // turn on auto
    (base as any)._updateTracingConfig('auto');
    // set explicit config first time
    (base as any)._updateTracingConfig({
      group_id: 'g1',
      workflow_name: 'wf',
      metadata: { a: 1 },
    });
    (base as any)._tracingConfig = {
      group_id: 'g1',
      workflow_name: 'wf',
      metadata: { a: 1 },
    };
    // attempt incompatible change should warn and not send
    (base as any)._updateTracingConfig({
      group_id: 'g2',
      workflow_name: 'wf2',
    });
    expect(logger.warn).toHaveBeenCalled();

    // disable tracing
    (base as any)._updateTracingConfig(null);

    const sentTypes = sendSpy.mock.calls.map((c) => c[0].type);
    expect(sentTypes).toContain('session.update');
  });
});
