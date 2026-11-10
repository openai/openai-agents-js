import { expect, it, vi } from 'vitest';
import { Session } from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';
import type { NativeRealtimeSipConfigOptions } from '../src/runtime/realtime';
import type { Engine, NativeThread } from '../src/runtime/binding';

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
      settings,
      ...(selection === 'explicit' ? { tools } : {}),
    };
    f.native.call.mockResolvedValueOnce('{}');
    const pending = f.session.buildRealtimeSipConfig(options);
    await started.promise;
    options.model = 'changed-model';
    options.voice = 'cedar';
    options.instructions = 'Changed instructions.';
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
      },
    });
    expect(params).not.toHaveProperty('hosted_mcp_auto_response');
    expect(params.function_tools).toEqual(selection === 'explicit' ? [] : null);
    if (selection === 'explicit') {
      expect(selectTools).toHaveBeenCalledWith([]);
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
