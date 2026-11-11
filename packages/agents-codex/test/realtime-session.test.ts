import { expect, it, vi } from 'vitest';
import type { NativeRealtimeResponseOptions } from '../src';
import { Session } from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';
import type { NativeRealtimeSipConfigOptions } from '../src/runtime/realtime';
import type { Engine, NativeThread, JsonObject } from '../src/runtime/binding';

// A native event source, so these exercise the actual sole Session reader and
// public lifecycle rather than calling the Realtime owner's control route.
function fixture(providerFailure?: Error) {
  let waiting = Promise.withResolvers<string[]>();
  const queued: string[][] = [];
  let reading = false;
  const emit = (
    id: string,
    type: string,
    fields: Record<string, unknown> = {},
  ) => {
    const batch = [JSON.stringify({ id, msg: { type, ...fields } })];
    if (reading) {
      reading = false;
      waiting.resolve(batch);
      waiting = Promise.withResolvers<string[]>();
    } else queued.push(batch);
  };
  let generation = '';
  const mediaCleanup = { close: vi.fn(async (_generation: string) => {}) };
  const native = {
    id: 'native-root',
    _realtime_cleanup: () => mediaCleanup,
    _next_session_events: vi.fn(async () => {
      if (queued.length) return queued.shift()!;
      reading = true;
      return waiting.promise;
    }),
    _finish_child_event_reader: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _close_report: vi.fn(async () => {
      emit('', 'shutdown_complete');
      return null;
    }),
    call: vi.fn(async (operation: string, raw: string) => {
      const params = JSON.parse(raw);
      if (operation === 'realtime_conversation_prepare_sdk') {
        generation = params.generation;
        return JSON.stringify({ generation });
      }
      if (operation === 'realtime_conversation_activate_sdk') {
        emit(generation, 'realtime_conversation_started');
      }
      if (operation === 'realtime_conversation_close_sdk')
        emit(generation, 'realtime_conversation_closed', {
          reason: 'requested',
        });
      return 'null';
    }),
  };
  const engine = { _close_report: vi.fn(async () => null) };
  const carrier = {
    close: vi.fn(async () => {
      if (providerFailure) throw providerFailure;
    }),
  };
  const session = new Session(
    engine as unknown as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    {},
    {},
    null,
    carrier as never,
  );
  return {
    session,
    mediaCleanup,
    native,
    engine,
    carrier,
    emit: (type: string, fields: Record<string, unknown> = {}) =>
      emit(generation, type, fields),
  };
}

it.each(['websocket', 'sip'] as const)(
  'scopes a %s URL and credentials to one connection',
  async (transport) => {
    const f = fixture();
    await f.session._start();
    const apiKey = vi.fn(async () => 'synthetic-override-key');
    const url = 'wss://gateway.invalid/tenant/voice?token=synthetic-route';
    const voice = await f.session.realtime({
      url,
      apiKey,
      ...(transport === 'sip'
        ? { transport: { type: 'sip' as const, callId: 'synthetic-call' } }
        : {}),
    });
    expect(apiKey).toHaveBeenCalledOnce();
    expect(
      f.native.call.mock.calls
        .filter(
          ([operation]) => operation === 'realtime_conversation_activate_sdk',
        )
        .map(([, raw]) => JSON.parse(raw)),
    ).toEqual([
      expect.objectContaining({
        api_key: 'synthetic-override-key',
        connection_options: { url, headers: null },
      }),
    ]);
    await voice.close();
    const next = await f.session.realtime();
    const activations = f.native.call.mock.calls.filter(
      ([operation]) => operation === 'realtime_conversation_activate_sdk',
    );
    expect(JSON.parse(activations[1][1])).not.toHaveProperty(
      'connection_options',
    );
    expect(JSON.parse(activations[1][1]).api_key).toBeNull();
    expect(apiKey).toHaveBeenCalledOnce();
    await next.close();
    await f.session.close();
  },
);

it.each([
  '',
  'not a URL',
  'https://gateway.invalid/realtime',
  'wss://user:password@gateway.invalid/realtime',
  'wss://gateway.invalid/realtime#fragment',
  'wss://gateway.invalid/realtime#',
])(
  'rejects invalid WebSocket URL %s before credentials and native work',
  async (url) => {
    const f = fixture();
    await f.session._start();
    f.native.call.mockClear();
    const apiKey = vi.fn(() => 'synthetic-unused-key');
    await expect(f.session.realtime({ url, apiKey })).rejects.toThrow(/URL/);
    expect(apiKey).not.toHaveBeenCalled();
    expect(f.native.call).not.toHaveBeenCalled();
    await f.session.close();
  },
);

it.each([
  { transport: { type: 'webrtc' as const, offerSdp: 'synthetic-offer' } },
  { adapter: { connect: vi.fn() } },
])(
  'rejects a URL override with WebRTC or custom transports before side effects',
  async (options) => {
    const f = fixture();
    await f.session._start();
    f.native.call.mockClear();
    const apiKey = vi.fn(() => 'synthetic-unused-key');
    await expect(
      f.session.realtime({
        ...options,
        url: 'wss://gateway.invalid/realtime',
        apiKey,
      }),
    ).rejects.toThrow('url requires the built-in WebSocket transport');
    expect(apiKey).not.toHaveBeenCalled();
    expect(f.native.call).not.toHaveBeenCalled();
    if (options.adapter) expect(options.adapter.connect).not.toHaveBeenCalled();
    await f.session.close();
  },
);

it('detaches live usage views and event-time totals across connection replacement', async () => {
  const f = fixture();
  await f.session._start();
  expect(f.session.realtimeUsage).toBeUndefined();
  const voice = await f.session.realtime();
  const events = voice.events();
  await events.next(); // Startup lifecycle.
  for (const [index, count] of [7, 3].entries())
    f.emit('realtime_conversation_realtime', {
      payload: {
        ResponseDone: {
          response_id: `usage-${index}`,
          usage: {
            total_tokens: count,
            input_token_details: { audio_tokens: count },
          },
        },
      },
    });
  await vi.waitFor(() =>
    expect(f.session.realtimeUsage?.total_tokens).toBe(10),
  );
  const first = (await events.next()).value;
  const second = (await events.next()).value;
  expect(first).toMatchObject({
    type: 'response',
    usage: { total_tokens: 7 },
    cumulativeUsage: { total_tokens: 7 },
  });
  expect(second).toMatchObject({
    type: 'response',
    usage: { total_tokens: 3 },
    cumulativeUsage: { total_tokens: 10 },
  });
  if (first?.type !== 'response') throw new Error('Missing first usage event');
  (
    first.cumulativeUsage!.input_token_details as { audio_tokens: number }
  ).audio_tokens = 999;
  const live = f.session.realtimeUsage!;
  (live.input_token_details as { audio_tokens: number }).audio_tokens = 888;
  expect(voice.usage?.input_token_details?.audio_tokens).toBe(10);
  expect(first.usage?.input_token_details?.audio_tokens).toBe(7);
  await events.return(undefined);
  await voice.close();
  expect(f.session.realtimeUsage).toBeUndefined();
  expect(voice.usage?.total_tokens).toBe(10);
  const next = await f.session.realtime();
  expect(f.session.realtimeUsage).toBeUndefined();
  await next.close();
  await f.session.close();
});

it('routes native Realtime before passive observation and joins its real Session reader on close', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime({
    settings: { transcription: null, turnDetection: null },
  });
  await expect(f.session.realtime()).rejects.toThrow();
  f.emit('realtime_conversation_realtime', {
    payload: {
      AudioOut: { data: 'AQACAA==', sample_rate: 24000, num_channels: 1 },
    },
  });
  const events = voice.events();
  expect((await events.next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'started',
  });
  expect((await events.next()).value).toMatchObject({
    type: 'audio',
    data: new Uint8Array([1, 0, 2, 0]),
  });
  await f.session.close();
  expect((await events.next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'closed',
  });
  expect((await events.next()).done).toBe(true);
  expect(f.native._finish_child_event_reader).toHaveBeenCalledOnce();
  expect(f.engine._close_report).toHaveBeenCalledOnce();
  expect(f.carrier.close).toHaveBeenCalledOnce();
});

it.each([undefined, 'text'] as const)(
  'forwards initial output modality %s through Session startup',
  async (outputModality) => {
    const f = fixture();
    await f.session._start();
    const voice = await f.session.realtime({ outputModality });
    const prepare = f.native.call.mock.calls.find(
      ([operation]) => operation === 'realtime_conversation_prepare_sdk',
    );
    expect(JSON.parse(prepare![1]).params.output_modality).toBe(
      outputModality ?? 'audio',
    );
    await voice.close();
    await f.session.close();
  },
);

it('captures per-response options before enqueue and preserves the no-argument DTO', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const blocked = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.native.call.mockImplementationOnce(async () => {
    entered.resolve();
    await blocked.promise;
    return 'null';
  });
  const text = voice.sendText('Before the response');
  await entered.promise;
  const options = {
    instructions: 'Reply briefly.',
    outputModality: 'text' as 'text' | 'audio',
    maxOutputTokens: 32 as number | 'inf',
  } satisfies NativeRealtimeResponseOptions;
  const pending = voice.requestResponse(options);
  options.instructions = 'Changed after enqueue';
  options.outputModality = 'audio';
  options.maxOutputTokens = 'inf';
  blocked.resolve();
  await Promise.all([text, pending]);
  await voice.requestResponse();
  await voice.requestResponse({ maxOutputTokens: 'inf' });
  const calls = f.native.call.mock.calls
    .filter(([operation]) => operation === 'realtime_conversation_response_sdk')
    .map(([, raw]) => JSON.parse(raw));
  expect(calls).toEqual([
    {
      generation: expect.any(String),
      response: {
        instructions: 'Reply briefly.',
        output_modality: 'text',
        max_output_tokens: 32,
      },
    },
    { generation: calls[0].generation },
    { generation: calls[0].generation, response: { max_output_tokens: 'inf' } },
  ]);
  await voice.close();
  await f.session.close();
});

it.each([
  {
    name: 'numeric options',
    response: 17 as unknown as NativeRealtimeResponseOptions,
  },
  {
    name: 'array options',
    response: [] as unknown as NativeRealtimeResponseOptions,
  },
  {
    name: 'unsupported fields',
    response: { instructions: 'Reply briefly.', tools: [] },
  },
  {
    name: 'oversized instructions',
    response: { instructions: '界'.repeat(350000) },
  },
])('rejects $name before dispatch', async ({ response }) => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const before = f.native.call.mock.calls.length;
  await expect(voice.requestResponse(response)).rejects.toThrow();
  expect(f.native.call.mock.calls).toHaveLength(before);
  await voice.close();
  await f.session.close();
});

it('native graph retirement releases a pending delegation even when later provider cleanup fails', async () => {
  const failure = new Error('provider release failed');
  const f = fixture(failure);
  await f.session._start();
  const publicResult = Promise.withResolvers<never>();
  void publicResult.promise.catch(() => {});
  const cancel = vi.fn(async () => {
    await f.session.close();
  });
  vi.spyOn(f.session, 'submit').mockResolvedValue({
    wait: () => publicResult.promise,
    cancel,
  } as never);
  const voice = await f.session.realtime();
  f.emit('realtime_conversation_realtime', {
    payload: {
      HandoffRequested: { handoff_id: 'h', input_transcript: 'ignored' },
    },
    _sdk_native_input: 'Core prepared text',
  });
  await vi.waitFor(() =>
    expect(f.session.submit).toHaveBeenCalledWith('Core prepared text'),
  );
  await expect(f.session.close()).rejects.toBe(failure);
  publicResult.reject(new Error('retired native result'));
  expect(f.native._close_report).toHaveBeenCalledOnce();
  expect(f.engine._close_report).toHaveBeenCalledOnce();
  expect(f.carrier.close).toHaveBeenCalledOnce();
  expect((await voice.events().next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'closed',
  });
});

it.each(['voice', 'session'] as const)(
  'retries retained postgraph media cleanup through %s without repeating released resources',
  async (retry) => {
    const f = fixture();
    await f.session._start();
    const voice = await f.session.realtime();
    const failure = new Error('hangup409');
    f.mediaCleanup.close.mockRejectedValueOnce(failure);
    await expect(f.session.close()).rejects.toBe(failure);
    expect(f.mediaCleanup.close).toHaveBeenCalledOnce();
    expect(f.carrier.close).toHaveBeenCalledOnce();
    if (retry === 'voice') await voice.close();
    else await f.session.close();
    await f.session.close();
    expect(f.mediaCleanup.close).toHaveBeenCalledTimes(2);
    expect(f.mediaCleanup.close.mock.calls[1]).toEqual(
      f.mediaCleanup.close.mock.calls[0],
    );
    expect(f.engine._close_report).toHaveBeenCalledOnce();
    expect(f.carrier.close).toHaveBeenCalledOnce();
  },
);

it('rejects callback lifecycle reentrancy before mutating or joining its own Realtime work', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const before = f.native.call.mock.calls.length;
  await expect(
    f.session._runVoiceCallback(() => voice.close()),
  ).rejects.toThrow();
  await expect(
    f.session._runVoiceCallback(() => voice.interrupt()),
  ).rejects.toThrow();
  await expect(
    f.session._runVoiceCallback(() =>
      voice.sendEvent({ type: 'response.cancel' }),
    ),
  ).rejects.toThrow();
  expect(f.native.call.mock.calls).toHaveLength(before);
  await voice.sendText('still open');
  await voice.close();
  await f.session.close();
});

it('builds SIP acceptance configuration before admission without media admission', async () => {
  const f = fixture();
  await f.session._start();
  const prepareMcp = vi.spyOn(f.session, '_prepareRealtimeMcp');
  const config = {
    type: 'realtime',
    model: 'gpt-realtime',
    instructions: 'Captured instructions',
    tools: [{ type: 'function', name: 'handoff_to_support' }],
  };
  f.native.call.mockImplementationOnce(async (operation) => {
    expect(operation).toBe('realtime_conversation_config_sdk');
    return JSON.stringify(config);
  });
  await expect(
    f.session.buildRealtimeSipConfig({ model: 'gpt-realtime' }),
  ).resolves.toEqual(config);
  expect(prepareMcp).toHaveBeenCalledOnce();
  expect(f.native.call).toHaveBeenCalledOnce();
  const params = JSON.parse(f.native.call.mock.calls[0][1]);
  expect(params).not.toHaveProperty('generation');
  expect(params).not.toHaveProperty('hosted_mcp_auto_response');
  expect(params).toMatchObject({
    function_tools: null,
    expected_selection_id: null,
    params: { model: 'gpt-realtime', client_managed_handoffs: true },
  });
  // Building acceptance configuration leaves the Session free to attach sideband.
  const voice = await f.session.realtime({
    transport: { type: 'sip', callId: 'incoming-call' },
    automaticallyTriggerResponseForMcpToolCalls: false,
  });
  const prepare = f.native.call.mock.calls.find(
    ([operation]) => operation === 'realtime_conversation_prepare_sdk',
  )!;
  expect(JSON.parse(prepare[1]).hosted_mcp_auto_response).toBe(false);
  await voice.close();
  await f.session.close();
});

it('uses the same native configuration inputs for SIP acceptance and connection', async () => {
  const f = fixture();
  await f.session._start();
  const options = {
    model: 'gpt-realtime',
    instructions: 'Follow the captured Agent.',
    voice: 'marin',
    tools: [],
    settings: { transcription: null, turnDetection: null },
  };
  f.native.call.mockResolvedValueOnce('{}');
  await f.session.buildRealtimeSipConfig(options);
  const configParams = JSON.parse(f.native.call.mock.calls[0][1]);
  const voice = await f.session.realtime(options);
  const prepare = f.native.call.mock.calls.find(
    ([operation]) => operation === 'realtime_conversation_prepare_sdk',
  )!;
  const {
    generation: _generation,
    hosted_mcp_auto_response,
    ...prepareParams
  } = JSON.parse(prepare[1]);
  expect(hosted_mcp_auto_response).toBe(true);
  expect(configParams).not.toHaveProperty('hosted_mcp_auto_response');
  expect(configParams).toEqual(prepareParams);
  expect(configParams.function_tools).toEqual([]);
  await voice.close();
  await f.session.close();
});

it.each([
  {
    apiKey: () => {
      throw new Error('must never resolve');
    },
  },
  { transport: { type: 'sip', callId: 'incoming-call' } },
  { adapter: { connect() {} } },
  { model: 123 },
  { tools: {} },
  { automaticallyTriggerResponseForMcpToolCalls: 'yes' },
  { automaticallyTriggerResponseForMcpToolCalls: true },
  { automaticallyTriggerResponseForMcpToolCalls: false },
])(
  'rejects unsupported SIP builder inputs before native work: %o',
  async (options) => {
    const f = fixture();
    await f.session._start();
    const prepareMcp = vi.spyOn(f.session, '_prepareRealtimeMcp');
    await expect(
      f.session.buildRealtimeSipConfig(options as never),
    ).rejects.toThrow(TypeError);
    expect(f.native.call).not.toHaveBeenCalled();
    expect(prepareMcp).not.toHaveBeenCalled();
    await f.session.close();
  },
);

it('rejects SIP configuration after Session close', async () => {
  const f = fixture();
  await f.session._start();
  await f.session.close();
  await expect(f.session.buildRealtimeSipConfig()).rejects.toThrow(
    'open Session',
  );
  expect(f.native.call).not.toHaveBeenCalled();
});

it('reconciles and retrieves provider history without replacing canonical history', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const items = [
    {
      id: 'provider-1',
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_audio', audio: 'AQACAA==', transcript: 'hello' },
      ],
    },
  ];
  const canonical = voice.history;
  f.native.call.mockResolvedValueOnce('null');
  await voice.updateHistory(items);
  const update = f.native.call.mock.calls.at(-1)!;
  expect(update[0]).toBe('realtime_conversation_update_history_sdk');
  const params = JSON.parse(update[1]);
  expect(params.items).toEqual(items);
  expect(params).not.toHaveProperty('expected_items');
  expect(params.generation).toEqual(expect.any(String));
  f.native.call.mockResolvedValueOnce(JSON.stringify(items[0]));
  await expect(voice.retrieveConversationItem('provider-1')).resolves.toEqual(
    items[0],
  );
  expect(f.native.call).toHaveBeenLastCalledWith(
    'realtime_conversation_retrieve_item_sdk',
    JSON.stringify({ generation: params.generation, item_id: 'provider-1' }),
  );
  f.native.call.mockResolvedValueOnce(JSON.stringify(items));
  await expect(voice.retrieveConversationHistory()).resolves.toEqual(items);
  expect(f.native.call).toHaveBeenLastCalledWith(
    'realtime_conversation_retrieve_history_sdk',
    JSON.stringify({ generation: params.generation }),
  );
  expect(voice.history).toEqual(canonical);
  await voice.close();
  const calls = f.native.call.mock.calls.length;
  await expect(voice.retrieveConversationItem('provider-1')).rejects.toThrow();
  await expect(voice.retrieveConversationHistory()).rejects.toThrow();
  await expect(voice.updateHistory([])).rejects.toThrow();
  expect(f.native.call.mock.calls).toHaveLength(calls);
  await f.session.close();
});

it('rejects invalid provider history controls before dispatch and preserves native failures', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const calls = f.native.call.mock.calls.length;
  await expect(voice.updateHistory([null] as never)).rejects.toThrow(TypeError);
  await expect(voice.retrieveConversationItem(' ')).rejects.toThrow(TypeError);
  expect(f.native.call.mock.calls).toHaveLength(calls);
  const failure = new Error('active response cannot reconcile history');
  f.native.call.mockRejectedValueOnce(failure);
  await expect(voice.updateHistory([])).rejects.toBe(failure);
  f.native.call.mockResolvedValueOnce('{}');
  await expect(voice.retrieveConversationHistory()).rejects.toThrow(
    'provider history',
  );
  await voice.close();
  await f.session.close();
});

it.each(['inherited', 'explicit'] as const)(
  'captures SIP options before awaiting %s tool preparation',
  async (selection) => {
    const f = fixture();
    await f.session._start();
    const blocked = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const prepareMcp = vi
      .spyOn(f.session, '_prepareRealtimeMcp')
      .mockImplementationOnce(async () => {
        started.resolve();
        await blocked.promise;
      });
    const selectTools = vi
      .spyOn(f.session, '_realtimeFunctionTools')
      .mockImplementationOnce(async () => {
        started.resolve();
        await blocked.promise;
        return { tools: [], selectionId: null };
      });
    const tools: never[] = [];
    const settings = { outputSpeed: 1.1 };
    const options: NativeRealtimeSipConfigOptions = {
      model: 'captured-model',
      voice: 'marin',
      instructions: 'Captured instructions.',
      outputModality: 'text',
      settings,
      ...(selection === 'explicit' ? { tools } : {}),
    };
    f.native.call.mockResolvedValueOnce('{}');
    const pending = f.session.buildRealtimeSipConfig(options);
    await started.promise;
    options.model = 'changed-model';
    options.voice = 'cedar';
    options.instructions = 'Changed instructions.';
    options.outputModality = 'audio';
    options.tools = [];
    tools.push({ name: 'injected' } as never);
    settings.outputSpeed = 1.7;
    blocked.resolve();
    await pending;
    const params = JSON.parse(f.native.call.mock.calls[0][1]);
    expect(params).toMatchObject({
      settings: { output_speed: 1.1 },
      params: {
        model: 'captured-model',
        voice: 'marin',
        prompt: 'Captured instructions.',
        output_modality: 'text',
      },
    });
    expect(params).not.toHaveProperty('hosted_mcp_auto_response');
    expect(params.function_tools).toEqual(selection === 'explicit' ? [] : null);
    if (selection === 'explicit') {
      expect(selectTools).toHaveBeenCalledOnce();
      expect(selectTools.mock.calls[0][0]).toEqual([]);
      expect(prepareMcp).not.toHaveBeenCalled();
    } else {
      expect(prepareMcp).toHaveBeenCalledOnce();
      expect(selectTools).not.toHaveBeenCalled();
    }
    await f.session.close();
  },
);

it.each(['ascii', 'cjk-value', 'cjk-key'] as const)(
  'rejects oversized provider history %s before native dispatch',
  async (kind) => {
    const f = fixture();
    await f.session._start();
    const voice = await f.session.realtime();
    const calls = f.native.call.mock.calls.length;
    const text =
      kind === 'ascii'
        ? 'A'.repeat(3 * 1024 * 1024)
        : kind === 'cjk-value'
          ? '界'.repeat(800000)
          : 'small';
    await expect(
      voice.updateHistory([
        {
          id: 'oversized',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
          ...(kind === 'cjk-key' ? { ['界'.repeat(800000)]: 'metadata' } : {}),
        },
      ]),
    ).rejects.toThrow(/history.*input queue.*budget/);
    expect(f.native.call.mock.calls).toHaveLength(calls);
    await voice.close();
    await f.session.close();
  },
);

it.each(
  [
    { character: 'A', count: (3 * 1024 * 1024) / 4, label: 'ASCII' },
    { character: '界', count: (3 * 1024 * 1024) / 12, label: 'CJK' },
    { character: '😀', count: (3 * 1024 * 1024) / 16, label: 'emoji' },
  ].flatMap((sample) =>
    [false, true].map((failure) => ({ ...sample, failure })),
  ),
)(
  'charges queued $label history allocations and releases capacity (failure=$failure)',
  async ({ character, count, failure }) => {
    const f = fixture();
    await f.session._start();
    const voice = await f.session.realtime();
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.native.call.mockImplementationOnce(async (operation) => {
      expect(operation).toBe('realtime_conversation_update_history_sdk');
      entered.resolve();
      await blocked.promise;
      if (failure) throw new Error('provider rejected history');
      return 'null';
    });
    const items = [
      {
        id: 'recording',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: character.repeat(count) }],
      },
    ];
    const first = voice.updateHistory(items);
    const firstResult = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const queued = voice.updateHistory(items);
    const calls = f.native.call.mock.calls.length;
    await expect(voice.updateHistory(items)).rejects.toThrow(
      /history.*input queue.*budget/,
    );
    expect(f.native.call.mock.calls).toHaveLength(calls);
    blocked.resolve();
    const result = await firstResult;
    if (failure) expect(result).toEqual(new Error('provider rejected history'));
    else expect(result).toBeUndefined();
    await queued;
    await expect(voice.updateHistory(items)).resolves.toBeUndefined();
    await voice.close();
    await f.session.close();
  },
);

it('releases the input reservation when provider history cannot be copied as JSON', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const recording = {
    id: 'recording',
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_audio', audio: 'A'.repeat((3 * 1024 * 1024) / 4) },
    ],
  };
  const calls = f.native.call.mock.calls.length;
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(
      voice.updateHistory([{ ...recording, invalid: undefined }] as never),
    ).rejects.toThrow('finite JSON');
  }
  expect(f.native.call.mock.calls).toHaveLength(calls);
  await expect(voice.updateHistory([recording])).resolves.toBeUndefined();
  await voice.close();
  await f.session.close();
});

it('admits repeated SIP acceptance options as the expected native configuration', async () => {
  const f = fixture();
  await f.session._start();
  const options = {
    model: 'accepted-model',
    voice: 'marin',
    instructions: 'Accepted instructions.',
    tools: [],
    settings: { turnDetection: null, transcription: null },
  };
  f.native.call.mockResolvedValueOnce('{}');
  await f.session.buildRealtimeSipConfig(options);
  const voice = await f.session.realtime({
    ...options,
    transport: { type: 'sip', callId: 'accepted-call' },
  });
  const prepare = f.native.call.mock.calls.find(
    ([operation]) => operation === 'realtime_conversation_prepare_sdk',
  )!;
  expect(JSON.parse(prepare[1])).toMatchObject({
    params: {
      model: options.model,
      voice: options.voice,
      prompt: options.instructions,
      transport: { type: 'existing_call', call_id: 'accepted-call' },
    },
    function_tools: [],
  });
  await voice.close();
  await f.session.close();
});

it('captures raw provider events in input order and returns nullable native results', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const blocked = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.native.call.mockImplementationOnce(async () => {
    entered.resolve();
    await blocked.promise;
    return 'null';
  });
  const prior = voice.sendText('Before the raw event');
  await entered.promise;
  const event = {
    type: 'response.create',
    event_id: 'client-request',
    response: { metadata: { topic: 'original' } },
  };
  const pending = voice.sendEvent(event);
  event.response.metadata.topic = 'changed';
  blocked.resolve();
  await prior;
  await expect(pending).resolves.toBeNull();
  const sent = f.native.call.mock.calls.find(
    ([operation]) => operation === 'realtime_conversation_send_event_sdk',
  );
  expect(JSON.parse(sent![1])).toEqual({
    generation: expect.any(String),
    event: {
      type: 'response.create',
      event_id: 'client-request',
      response: { metadata: { topic: 'original' } },
    },
  });
  const item = {
    id: 'provider-item',
    type: 'message',
    role: 'user',
    content: [],
  };
  f.native.call.mockImplementationOnce(async () => JSON.stringify(item));
  await expect(
    voice.sendEvent({
      type: 'conversation.item.retrieve',
      item_id: 'provider-item',
    }),
  ).resolves.toEqual(item);
  await voice.close();
  const calls = f.native.call.mock.calls.length;
  await expect(voice.sendEvent({ type: 'response.create' })).rejects.toThrow();
  expect(f.native.call.mock.calls).toHaveLength(calls);
  await f.session.close();
});

it('rejects non-JSON and oversized raw events before native dispatch', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const cyclic: Record<string, unknown> = { type: 'response.create' };
  cyclic.self = cyclic;
  const calls = f.native.call.mock.calls.length;
  for (const event of [
    null,
    [],
    { type: 'response.create', ignored: undefined },
    { type: 'response.create', value: Infinity },
    cyclic,
    { type: 'response.create', instructions: '界'.repeat(800000) },
  ]) {
    await expect(voice.sendEvent(event as JsonObject)).rejects.toThrow();
  }
  expect(f.native.call.mock.calls).toHaveLength(calls);
  await voice.close();
  await f.session.close();
});

it('charges raw events to the shared input allocation budget and releases capacity', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const blocked = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.native.call.mockImplementationOnce(async () => {
    entered.resolve();
    await blocked.promise;
    return 'null';
  });
  const event = {
    type: 'response.create',
    response: { instructions: 'A'.repeat(750000) },
  };
  const first = voice.sendEvent(event);
  await entered.promise;
  const second = voice.sendEvent(event);
  const calls = f.native.call.mock.calls.length;
  await expect(voice.sendEvent(event)).rejects.toThrow(
    /event.*input queue.*budget/,
  );
  expect(f.native.call.mock.calls).toHaveLength(calls);
  blocked.resolve();
  await Promise.all([first, second]);
  await expect(voice.sendEvent(event)).resolves.toBeNull();
  await voice.close();
  await f.session.close();
});

it('applies the native raw cancellation receipt to buffered output without returning private fields', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const events = voice.events();
  expect((await events.next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'started',
  });
  f.emit('realtime_conversation_realtime', {
    payload: {
      AudioOut: {
        data: 'AQACAA==',
        sample_rate: 24000,
        num_channels: 1,
        response_id: 'retired',
      },
    },
  });
  // Let the sole Session reader buffer the old audio before cancellation.
  await vi.waitFor(() =>
    expect(f.native._next_session_events.mock.calls.length).toBeGreaterThan(2),
  );
  f.native.call.mockImplementationOnce(async (operation) => {
    expect(operation).toBe('realtime_conversation_send_event_sdk');
    return JSON.stringify({
      retired_response_ids: ['retired'],
      cancelled_response_id: 'retired',
      joined_root_turn_ids: [],
    });
  });
  await expect(
    voice.sendEvent({
      type: 'response.cancel',
      response_id: 'retired',
      event_id: 'cancel-request',
    }),
  ).resolves.toBeNull();
  expect((await events.next()).value).toMatchObject({
    type: 'playback_interrupted',
    responseId: 'retired',
    retiredResponseIds: ['retired'],
    cancelledResponseId: 'retired',
  });
  const raw = f.native.call.mock.calls.find(
    ([operation]) => operation === 'realtime_conversation_send_event_sdk',
  );
  expect(JSON.parse(raw![1]).event).toEqual({
    type: 'response.cancel',
    response_id: 'retired',
    event_id: 'cancel-request',
  });
  await voice.close();
  await f.session.close();
});

it('keeps the owner live when native validation rejects a malformed raw cancellation', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  f.native.call.mockRejectedValueOnce(
    new Error('Invalid response.cancel field'),
  );
  await expect(
    voice.sendEvent({ type: 'response.cancel', unexpected: true }),
  ).rejects.toThrow('Invalid response.cancel field');
  await expect(
    voice.sendText('Still accepting input.'),
  ).resolves.toBeUndefined();
  await voice.close();
  await f.session.close();
});

it('keeps newer response output when an unscoped raw cancel receipt arrives late', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const events = voice.events();
  await events.next();
  const entered = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<string>();
  f.native.call.mockImplementationOnce(async () => {
    entered.resolve();
    return receipt.promise;
  });
  const cancelling = voice.sendEvent({ type: 'response.cancel' });
  await entered.promise;
  const reads = f.native._next_session_events.mock.calls.length;
  f.emit('realtime_conversation_realtime', {
    payload: { ResponseCreated: { response_id: 'newer' } },
  });
  f.emit('realtime_conversation_realtime', {
    payload: {
      AudioOut: {
        data: 'AwAEAA==',
        sample_rate: 24000,
        num_channels: 1,
        response_id: 'newer',
      },
    },
  });
  // The created response proves that newer work has started before the receipt.
  expect((await events.next()).value).toMatchObject({
    type: 'response',
    responseId: 'newer',
    status: 'created',
  });
  await vi.waitFor(() =>
    expect(f.native._next_session_events.mock.calls.length).toBeGreaterThan(
      reads + 1,
    ),
  );
  receipt.resolve(
    JSON.stringify({
      retired_response_ids: ['older'],
      cancelled_response_id: 'older',
      joined_root_turn_ids: [],
    }),
  );
  await expect(cancelling).resolves.toBeNull();
  expect((await events.next()).value).toMatchObject({
    type: 'audio',
    responseId: 'newer',
    data: new Uint8Array([3, 0, 4, 0]),
  });
  expect((await events.next()).value).toMatchObject({
    type: 'playback_interrupted',
    retiredResponseIds: ['older'],
  });
  f.emit('realtime_conversation_realtime', {
    payload: {
      AudioOut: {
        data: 'BQAGAA==',
        sample_rate: 24000,
        num_channels: 1,
        response_id: 'newer',
      },
    },
  });
  expect((await events.next()).value).toMatchObject({
    type: 'audio',
    responseId: 'newer',
  });
  await voice.close();
  await f.session.close();
});

it('rejects adapter text behind a queued raw event and releases the admission barrier afterward', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  f.native.call.mockImplementationOnce(async () => {
    entered.resolve();
    await proceed.promise;
    await expect(
      f.session._runVoiceCallback(() => voice.sendText('nested text'), voice),
    ).rejects.toThrow('Realtime adapter callback cannot');
    await expect(
      f.session._runVoiceCallback(
        () => voice.sendMessage('nested message'),
        voice,
      ),
    ).rejects.toThrow('Realtime adapter callback cannot');
    return 'null';
  });
  const prior = voice.sendText('outer input');
  await entered.promise;
  const raw = voice.sendEvent({ type: 'response.create' });
  proceed.resolve();
  await Promise.all([prior, raw]);
  await expect(
    f.session._runVoiceCallback(() => voice.sendText('after raw event'), voice),
  ).resolves.toBeUndefined();
  const texts = f.native.call.mock.calls
    .filter(([operation]) => operation === 'realtime_conversation_text_sdk')
    .map(([, raw]) => JSON.parse(raw).text);
  expect(texts).toEqual(['outer input', 'after raw event']);
  await voice.close();
  await f.session.close();
});

it('releases the raw cancellation queue before joining guardrail cleanup that sends text', async () => {
  const f = fixture();
  await f.session._start();
  vi.spyOn(f.session, '_realtimeGuardrailSource').mockReturnValue({
    agent: {} as never,
    context: null,
  });
  const entered = Promise.withResolvers<void>();
  const voice = await f.session.realtime({
    guardrailTextThreshold: null,
    outputGuardrails: [
      {
        name: 'reentrant-cleanup',
        callback: async (input) => {
          entered.resolve();
          await new Promise<void>((resolve) =>
            input.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          await voice.sendText('guardrail cleanup input');
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  f.emit('realtime_conversation_realtime', {
    payload: {
      OutputTranscriptDone: {
        text: 'Retire this output.',
        response_id: 'retired',
        item_id: 'guarded-item',
        content_index: 0,
        output_kind: 'text',
      },
    },
  });
  await entered.promise;
  f.native.call.mockImplementationOnce(async () =>
    JSON.stringify({
      retired_response_ids: ['retired'],
      cancelled_response_id: 'retired',
      joined_root_turn_ids: [],
    }),
  );
  await expect(
    voice.sendEvent({ type: 'response.cancel' }),
  ).resolves.toBeNull();
  expect(
    f.native.call.mock.calls
      .filter(([operation]) => operation === 'realtime_conversation_text_sdk')
      .map(([, raw]) => JSON.parse(raw).text),
  ).toContain('guardrail cleanup input');
  await voice.close();
  await f.session.close();
}, 3000);

it('releases raw cancellation dispatch while native waits for a host callback to send text', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  f.native.call.mockImplementationOnce(async (operation) => {
    expect(operation).toBe('realtime_conversation_send_event_sdk');
    // Native cancellation joins an already entered host callback before its receipt.
    await f.session._runVoiceCallback(() =>
      voice.sendText('entered host callback input'),
    );
    return JSON.stringify({
      retired_response_ids: ['retired'],
      cancelled_response_id: 'retired',
      joined_root_turn_ids: [],
    });
  });
  await expect(
    voice.sendEvent({ type: 'response.cancel' }),
  ).resolves.toBeNull();
  expect(
    f.native.call.mock.calls
      .filter(([operation]) => operation === 'realtime_conversation_text_sdk')
      .map(([, raw]) => JSON.parse(raw).text),
  ).toContain('entered host callback input');
  await voice.close();
  await f.session.close();
}, 3000);

it('runs a history updater once after preceding input and preserves its original provider snapshot', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const applying = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const original = f.native.call.getMockImplementation()!;
  const provider = [
    { id: 'provider-first', type: 'message', content: [{ text: 'original' }] },
  ];
  const operations: string[] = [];
  f.native.call.mockImplementation(async (operation, raw) => {
    operations.push(operation);
    if (
      operation === 'realtime_conversation_text_sdk' &&
      operations.length === 1
    ) {
      entered.resolve();
      await release.promise;
    }
    if (operation === 'realtime_conversation_retrieve_history_sdk')
      return JSON.stringify(provider);
    if (operation === 'realtime_conversation_update_history_sdk') {
      applying.resolve();
      await accepted.promise;
    }
    return original(operation, raw);
  });
  const prior = voice.sendText('before updater');
  await entered.promise;
  const update = vi.fn((history: JsonObject[]) => {
    expect(history).toEqual(provider);
    (history[0].content as JsonObject[])[0].text = 'corrected';
    return history;
  });
  const pending = voice.updateHistory(update);
  const later = voice.sendText('after updater');
  expect(update).not.toHaveBeenCalled();
  await expect(
    f.session._runVoiceCallback(
      () => voice.sendText('nested queued input'),
      voice,
    ),
  ).rejects.toThrow('Realtime adapter callback cannot');
  release.resolve();
  await applying.promise;
  expect(update).toHaveBeenCalledOnce();
  expect(operations).toEqual([
    'realtime_conversation_text_sdk',
    'realtime_conversation_retrieve_history_sdk',
    'realtime_conversation_update_history_sdk',
  ]);
  const request = f.native.call.mock.calls.find(
    ([operation]) => operation === 'realtime_conversation_update_history_sdk',
  )!;
  expect(JSON.parse(request[1])).toMatchObject({
    expected_items: provider,
    items: [{ ...provider[0], content: [{ text: 'corrected' }] }],
  });
  accepted.resolve();
  await Promise.all([prior, pending, later]);
  expect(operations.at(-1)).toBe('realtime_conversation_text_sdk');
  await expect(
    f.session._runVoiceCallback(
      () => voice.sendText('after acceptance'),
      voice,
    ),
  ).resolves.toBeUndefined();
  await voice.close();
  await f.session.close();
});

it('preserves stale-snapshot rejection without retrying a history updater', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const provider = [{ id: 'known', type: 'message', content: [] }];
  const failure = new Error('Provider history changed since retrieval');
  f.native.call.mockResolvedValueOnce(JSON.stringify(provider));
  f.native.call.mockRejectedValueOnce(failure);
  const update = vi.fn(() => []);
  await expect(voice.updateHistory(update)).rejects.toBe(failure);
  expect(update).toHaveBeenCalledOnce();
  expect(JSON.parse(f.native.call.mock.calls.at(-1)![1])).toMatchObject({
    items: [],
    expected_items: provider,
  });
  await expect(voice.updateHistory([])).resolves.toBeUndefined();
  await voice.close();
  await f.session.close();
});

it.each(['throw', 'invalid', 'oversize', 'non-json'] as const)(
  'releases a history updater reservation after %s before any replacement',
  async (failure) => {
    const f = fixture();
    await f.session._start();
    const voice = await f.session.realtime();
    const original = f.native.call.getMockImplementation()!;
    f.native.call.mockImplementation(async (operation, raw) =>
      operation === 'realtime_conversation_retrieve_history_sdk'
        ? JSON.stringify([{ id: 'original', type: 'message', content: [] }])
        : original(operation, raw),
    );
    const update = () => {
      if (failure === 'throw') throw new Error('updater failed');
      if (failure === 'invalid') return null as never;
      return [
        {
          id: 'new',
          text: failure === 'oversize' ? 'A'.repeat(3 * 1024 * 1024) : 'text',
          ...(failure === 'non-json' ? { invalid: undefined } : {}),
        },
      ] as unknown as JsonObject[];
    };
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(voice.updateHistory(update)).rejects.toThrow();
    expect(
      f.native.call.mock.calls.filter(
        ([operation]) =>
          operation === 'realtime_conversation_update_history_sdk',
      ),
    ).toEqual([]);
    await expect(
      voice.updateHistory([{ id: 'large-valid', text: 'A'.repeat(1500000) }]),
    ).resolves.toBeUndefined();
    await expect(
      f.session._runVoiceCallback(() => voice.sendText('released'), voice),
    ).resolves.toBeUndefined();
    await voice.close();
    await f.session.close();
  },
);

it('charges both the expected history and mutable updater input before invoking the callback', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const original = f.native.call.getMockImplementation()!;
  f.native.call.mockImplementation(async (operation, raw) =>
    operation === 'realtime_conversation_retrieve_history_sdk'
      ? JSON.stringify([{ id: 'large-provider', text: 'A'.repeat(1100000) }])
      : original(operation, raw),
  );
  const update = vi.fn(() => []);
  await expect(voice.updateHistory(update)).rejects.toThrow(
    /history.*input queue.*budget/,
  );
  expect(update).not.toHaveBeenCalled();
  await expect(
    voice.updateHistory([{ id: 'after-failure', text: 'A'.repeat(1500000) }]),
  ).resolves.toBeUndefined();
  await voice.close();
  await f.session.close();
});

it('does not invoke a history updater when the owner closes during retrieval', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.native.call.getMockImplementation()!;
  f.native.call.mockImplementation(async (operation, raw) => {
    if (operation === 'realtime_conversation_retrieve_history_sdk') {
      entered.resolve();
      await release.promise;
      return '[]';
    }
    return original(operation, raw);
  });
  const update = vi.fn(() => []);
  const pending = voice.updateHistory(update);
  const rejection = expect(pending).rejects.toThrow('not open');
  await entered.promise;
  await voice.close();
  release.resolve();
  await rejection;
  expect(update).not.toHaveBeenCalled();
  expect(
    f.native.call.mock.calls.some(
      ([operation]) => operation === 'realtime_conversation_update_history_sdk',
    ),
  ).toBe(false);
  await f.session.close();
});
