import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RealtimeClientMessage } from '../src/clientMessages';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';
import logger from '../src/logger';

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

function createToolCall() {
  return {
    type: 'function_call' as const,
    id: '1',
    callId: 'c1',
    name: 'tool',
    arguments: '{}',
  };
}

describe('OpenAIRealtimeBase helpers', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves api keys from options', async () => {
    const base = new TestBase({ apiKey: () => 'fromCtor' });
    const key1 = await (base as any)._getApiKey({});
    const key2 = await (base as any)._getApiKey({ apiKey: 'override' });

    expect(key1).toBe('fromCtor');
    expect(key2).toBe('override');
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
      model: 'gpt-realtime',
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
      model: 'gpt-realtime',
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

  it('sendFunctionCallOutput emits item_update and response.create', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (e) => updates.push(e));
    base.sendFunctionCallOutput(createToolCall(), 'output', true);

    expect(base.events[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', output: 'output', call_id: 'c1' },
    });
    expect(base.events[1]).toEqual({ type: 'response.create' });
    expect(updates.length).toBe(1);
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
      item_id: '1',
    });
    expect(base.events[1]).toEqual({
      type: 'conversation.item.create',
      item: {
        id: '2',
        role: 'user',
        type: 'message',
        status: 'completed',
        content: [{ type: 'input_text', text: 'b' }],
      },
    });
  });

  it('resetHistory warns on function call additions', () => {
    const base = new TestBase();
    const newHist = [
      {
        itemId: 'f1',
        type: 'function_call',
        status: 'completed',
        arguments: '{}',
        name: 'calc',
        output: null,
      },
    ];

    base.resetHistory([], newHist as any);

    expect(logger.warn).toHaveBeenCalledWith(
      'Function calls cannot be manually added or updated at the moment. Ignoring.',
    );
    expect(base.events).toHaveLength(0);
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
    expect(updates.find((u) => (u as any).itemId === 'mcp1')).toBeTruthy();
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
