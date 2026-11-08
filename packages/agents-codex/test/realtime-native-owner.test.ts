import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import {
  createNativeRealtimeOwner,
  type NativeRealtimeOptions,
  type NativeRealtimeCall,
} from '../src/runtime/realtime';
import type { NativeEvent } from '../src/runtime/events';
import type { Session } from '../src/runtime/session';

function deferred<T>() {
  return Promise.withResolvers<T>();
}
function fixture(options: NativeRealtimeOptions = {}) {
  const waits: Array<ReturnType<typeof deferred<{ finalOutput: unknown }>>> =
    [];
  const cancellations: ReturnType<typeof vi.fn>[] = [];
  const inputs: string[] = [];
  const admit = () => {
    const result = deferred<{ finalOutput: unknown }>();
    void result.promise.catch(() => {});
    waits.push(result);
    const cancel = vi.fn(async () =>
      result.reject(new Error('owned turn cancelled')),
    );
    cancellations.push(cancel);
    return { wait: () => result.promise, cancel, events: vi.fn() };
  };
  const session = {
    submit: vi.fn(async (input: string) => {
      inputs.push(input);
      return admit();
    }),
    _submitRealtimeTools: vi.fn(
      async (
        _generation: string,
        _responseId: string,
        _callIds: readonly string[],
      ) => admit(),
    ),
    _realtimeFunctionTools: vi.fn(async (_tools: readonly unknown[]) => ({
      tools: [],
      selectionId: null,
    })),
    close: vi.fn(),
    _checkVoiceOperation: vi.fn(),
    _runVoiceCallback: vi.fn(async (callback: () => unknown) => callback()),
    _realtimeCurrentProfile: vi.fn(async () => null),
    _realtimeProfileTarget: vi.fn((target: unknown) => target ?? null),
    _realtimeGuardrailSource: vi.fn((_receipt: unknown) => ({
      agent: { name: 'captured Agent' } as never,
      context: undefined,
    })),
  };
  let generation = '';
  const responses = new Set<string>();
  const release = vi.fn();
  const event = (
    type: string,
    msg: Record<string, unknown> = {},
    id = generation,
  ) => owner._ingest({ id, msg: { type, ...msg } } as NativeEvent);
  const payload = (value: unknown, input?: string, id = generation) => {
    if (value && typeof value === 'object')
      for (const item of Object.values(value))
        if (
          item &&
          typeof item === 'object' &&
          'response_id' in item &&
          typeof item.response_id === 'string'
        )
          responses.add(item.response_id);
    return event(
      'realtime_conversation_realtime',
      { payload: value, ...(input ? { _sdk_native_input: input } : {}) },
      id,
    );
  };
  const call = vi.fn<NativeRealtimeCall>(async (operation, params) => {
    if (operation === 'realtime_conversation_start_sdk') {
      generation = params.generation as string;
      event('realtime_conversation_started');
    }
    if (operation === 'realtime_conversation_interrupt_sdk')
      return {
        retired_response_ids:
          typeof params.response_id === 'string'
            ? [params.response_id]
            : [...responses],
      };
    if (operation === 'realtime_conversation_close_sdk')
      event('realtime_conversation_closed', { reason: 'requested' });
  });
  const graphClose = vi.fn(async (_generation: string) => {});
  const owner = createNativeRealtimeOwner(
    session as unknown as Session<unknown>,
    call,
    release,
    options,
    graphClose,
  );
  return {
    owner,
    event,
    payload,
    call,
    graphClose,
    release,
    session,
    inputs,
    waits,
    cancellations,
    get generation() {
      return generation;
    },
  };
}

it('uses Core-prepared input and only accepted output, retaining caller context and deduplicating handoffs', async () => {
  const context = new AsyncLocalStorage<string>();
  const peer = context.run('voice entry', () => fixture());
  const original = peer.session.submit.getMockImplementation()!;
  peer.session.submit.mockImplementation(async (input) => {
    expect(context.getStore()).toBe('voice entry');
    return original(input);
  });
  await peer.owner._start();
  peer.payload(
    {
      HandoffRequested: {
        handoff_id: 'one',
        input_transcript: 'bare incomplete input',
      },
    },
    'Core-rendered transcript and context',
  );
  peer.payload(
    { HandoffRequested: { handoff_id: 'one' } },
    'duplicate must not execute',
  );
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  expect(peer.inputs).toEqual(['Core-rendered transcript and context']);
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_complete_sdk',
    ),
  ).toBe(false);
  peer.waits[0].resolve({ finalOutput: 'validated repaired answer' });
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.find(
        ([op]) => op === 'realtime_conversation_complete_sdk',
      )?.[1],
    ).toMatchObject({ handoff_id: 'one', text: 'validated repaired answer' }),
  );
  peer.payload({ HandoffRequested: { handoff_id: 'two' } }, 'second turn');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(2));
  peer.waits[1].resolve({ finalOutput: 'second accepted answer' });
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.filter(
        ([op]) => op === 'realtime_conversation_complete_sdk',
      ),
    ).toHaveLength(2),
  );
  await peer.owner.close();
  expect(peer.session.close).not.toHaveBeenCalled();
  expect(peer.release).toHaveBeenCalledOnce();
});

it.each(['reject', 'structured'] as const)(
  'returns a fixed native failure result without draft/exception text: %s',
  async (mode) => {
    const peer = fixture();
    await peer.owner._start();
    peer.payload({ HandoffRequested: { handoff_id: 'unsafe' } }, 'question');
    await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
    if (mode === 'reject')
      peer.waits[0].reject(new Error('private exception draft'));
    else peer.waits[0].resolve({ finalOutput: { secret: 'private draft' } });
    await vi.waitFor(() =>
      expect(
        peer.call.mock.calls.some(
          ([op]) => op === 'realtime_conversation_fail_sdk',
        ),
      ).toBe(true),
    );
    expect(JSON.stringify(peer.call.mock.calls)).not.toContain('private');
    expect(
      peer.call.mock.calls.some(
        ([op]) => op === 'realtime_conversation_complete_sdk',
      ),
    ).toBe(false);
    await peer.owner.close();
  },
);

it('joins exact native cancellation on unexpected transport EOF without waiting for a player', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload({ HandoffRequested: { handoff_id: 'pending' } }, 'question');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  peer.event('realtime_conversation_closed', { reason: 'transport_closed' });
  await expect(peer.owner.events().next()).rejects.toThrow(
    'closed unexpectedly',
  );
  await peer.owner.close();
  expect(peer.cancellations[0]).toHaveBeenCalledOnce();
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_complete_sdk',
    ),
  ).toBe(false);
  expect(peer.session.close).not.toHaveBeenCalled();
});

it('fails bounded media/control delivery while control cleanup continues without event consumption', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload({ InputTranscriptDone: { text: 'x'.repeat(2 * 1024 * 1024) } });
  await expect(peer.owner.events().next()).rejects.toThrow('buffer overflow');
  await peer.owner.close();
  expect(peer.release).toHaveBeenCalledOnce();
});

it('ignores old generations, leaves unknown backend sources untouched on scoped interrupt, and joins them on default interrupt', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload(
    { HandoffRequested: { handoff_id: 'old' } },
    'old input',
    'retired generation',
  );
  expect(peer.inputs).toEqual([]);
  peer.payload({ ResponseCreated: { response_id: 'r1' } });
  peer.payload({ HandoffRequested: { handoff_id: 'one' } }, 'question');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  peer.payload({ ResponseCreated: { response_id: 'r2' } });
  await peer.owner.interrupt('r1');
  expect(peer.cancellations[0]).not.toHaveBeenCalled();
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_interrupt_sdk',
    ),
  ).toBe(true);
  await peer.owner.interrupt();
  expect(peer.cancellations[0]).toHaveBeenCalledOnce();
  expect(
    peer.call.mock.calls.findLast(
      ([op]) => op === 'realtime_conversation_interrupt_sdk',
    )?.[1],
  ).toMatchObject({ response_id: null });
  await peer.owner.close();
});

it('retains cancelled admission and closes its generation before rejecting publication', async () => {
  const controller = new AbortController();
  const peer = fixture({ signal: controller.signal });
  const admitted = deferred<void>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (op, params) => {
    await original(op, params);
    if (op === 'realtime_conversation_start_sdk') await admitted.promise;
  });
  const pending = peer.owner._start();
  controller.abort(new Error('cancel admission'));
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  admitted.resolve();
  await expect(pending).rejects.toThrow('cancel admission');
  expect(peer.release).toHaveBeenCalledOnce();
  expect(
    peer.call.mock.calls.filter(
      ([op]) => op === 'realtime_conversation_close_sdk',
    ),
  ).toHaveLength(1);
});

it.each(['submit', 'wait', 'cancel'] as const)(
  'verified graph teardown releases public-wrapper %s without weakening normal cancellation',
  async (phase) => {
    const peer = fixture();
    await peer.owner._start();
    const publicClose = deferred<never>();
    void publicClose.promise.catch(() => {});
    if (phase === 'submit')
      peer.session.submit.mockReturnValueOnce(publicClose.promise);
    peer.payload({ HandoffRequested: { handoff_id: 'owned' } }, 'question');
    await vi.waitFor(() => expect(peer.session.submit).toHaveBeenCalledOnce());
    if (phase !== 'submit')
      await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
    if (phase === 'cancel')
      peer.cancellations[0].mockImplementation(() => publicClose.promise);
    const pendingCancel = phase === 'cancel' ? peer.owner.close() : undefined;
    if (phase === 'cancel')
      await vi.waitFor(() =>
        expect(peer.cancellations[0]).toHaveBeenCalledOnce(),
      );
    peer.owner._retireFromSession();
    await peer.owner._nativeShutdown();
    await pendingCancel;
    expect(peer.release).toHaveBeenCalledOnce();
    expect(
      peer.call.mock.calls.some(
        ([op]) => op === 'realtime_conversation_complete_sdk',
      ),
    ).toBe(false);
    publicClose.reject(new Error('global Session close finally settled'));
  },
);

it('joins canonical history tail before normal close and drops queued audio', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload({
    AudioOut: {
      data: Buffer.from([1, 0]).toString('base64'),
      sample_rate: 24000,
      num_channels: 1,
    },
  });
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (op, params) => {
    if (op === 'realtime_conversation_close_sdk') {
      peer.payload({
        HistoryItemCompleted: {
          id: 'tail',
          realtime_session_id: 'provider',
          type: 'transcript_segment',
          role: 'assistant',
          text: 'final canonical text',
        },
      });
    }
    return original(op, params);
  });
  await peer.owner.close();
  expect(peer.owner.history).toEqual([
    expect.objectContaining({ id: 'tail', text: 'final canonical text' }),
  ]);
  expect(await peer.owner.events().next()).toMatchObject({
    value: { type: 'lifecycle', status: 'closed' },
  });
});

it('still cancels exact work when media close fails and retains cleanup for retry', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload({ HandoffRequested: { handoff_id: 'owned' } }, 'question');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  const original = peer.call.getMockImplementation()!;
  let first = true;
  peer.call.mockImplementation(async (op, params) => {
    if (op === 'realtime_conversation_close_sdk' && first) {
      first = false;
      throw new Error('media cleanup failed');
    }
    return original(op, params);
  });
  await expect(peer.owner.close()).rejects.toThrow('media cleanup failed');
  expect(peer.cancellations[0]).toHaveBeenCalledOnce();
  expect(peer.release).not.toHaveBeenCalled();
  await peer.owner.close();
  expect(peer.release).toHaveBeenCalledOnce();
});

it('forwards captured typed initial settings and sparse updates through the same generation', async () => {
  const settings = {
    transcription: { model: 'gpt-transcribe', language: 'fr' },
    turnDetection: null,
    tracing: null,
    outputVoice: { id: 'voice_custom' },
  };
  const peer = fixture({ settings });
  settings.transcription.language = 'changed after capture';
  await peer.owner._start();
  const start = peer.call.mock.calls.find(
    ([op]) => op === 'realtime_conversation_start_sdk',
  )![1];
  expect(start.settings).toEqual({
    transcription: { model: 'gpt-transcribe', language: 'fr' },
    turn_detection: null,
    tracing: null,
    output_voice: { id: 'voice_custom' },
  });
  await peer.owner.update({ outputSpeed: 1.25 });
  expect(
    peer.call.mock.calls.find(
      ([op]) => op === 'realtime_conversation_update_sdk',
    )?.[1],
  ).toEqual({ generation: peer.generation, update: { output_speed: 1.25 } });
  const count = peer.call.mock.calls.length;
  await expect(peer.owner.update({ outputSpeed: NaN })).rejects.toThrow();
  expect(peer.call.mock.calls).toHaveLength(count);
  await peer.owner.close();
});

it('forwards explicit G711 bytes with8kHz framing and preserves complete PCM input', async () => {
  const peer = fixture({
    settings: { inputFormat: 'g711_ulaw', outputFormat: 'g711_alaw' },
  });
  await peer.owner._start();
  const data = Uint8Array.from([255, 127, 0]);
  await peer.owner.sendAudio({ format: 'g711_ulaw', data });
  expect([...data]).toEqual([255, 127, 0]);
  expect(
    peer.call.mock.calls.find(
      ([op]) => op === 'realtime_conversation_audio_sdk',
    )?.[1].frame,
  ).toMatchObject({
    data: Buffer.from(data).toString('base64'),
    format: 'g711_ulaw',
    sample_rate: 8000,
    samples_per_channel: 3,
  });
  const count = peer.call.mock.calls.length;
  await expect(peer.owner.sendAudio({ format: 'pcm16', data })).rejects.toThrow(
    'complete two-byte',
  );
  expect(peer.call.mock.calls).toHaveLength(count);
  await peer.owner.close();
});

it('retains exact local delegation error while sending only a fixed failure to the provider', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({ HandoffRequested: { handoff_id: 'error-owner' } }, 'question');
  await events.next();
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  const original = new Error('private original');
  peer.waits[0].reject(original);
  expect((await events.next()).value).toMatchObject({
    type: 'delegation',
    status: 'failed',
    error: original,
  });
  expect(JSON.stringify(peer.call.mock.calls)).not.toContain(
    'private original',
  );
  await peer.owner.close();
});

it('keeps original primary failure if sending the fixed provider failure also rejects', async () => {
  const peer = fixture();
  await peer.owner._start();
  const original = new Error('private original');
  const implementation = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_fail_sdk')
      throw new Error('provider send failed');
    return implementation(operation, params);
  });
  peer.payload({ HandoffRequested: { handoff_id: 'failed-send' } }, 'question');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  peer.waits[0].reject(original);
  await vi.waitFor(() => expect(peer.release).toHaveBeenCalledOnce());
  await expect(peer.owner.events().next()).rejects.toBe(original);
});

it('scopes a late interruption to the actual producing backend response rather than the latest response', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload(
    { HandoffRequested: { handoff_id: 'owned-a', response_id: 'A' } },
    'question',
  );
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  peer.payload({ ResponseCreated: { response_id: 'B' } });
  await peer.owner.interrupt('A');
  expect(peer.cancellations[0]).toHaveBeenCalledOnce();
  expect(
    peer.call.mock.calls.find(
      ([op]) => op === 'realtime_conversation_interrupt_sdk',
    )?.[1],
  ).toMatchObject({ response_id: 'A' });
  expect(
    peer.call.mock.calls.some(
      ([op]) =>
        op === 'realtime_conversation_complete_sdk' ||
        op === 'realtime_conversation_fail_sdk',
    ),
  ).toBe(false);
  await peer.owner.close();
});

it('releases failed admission after confirmed idle close without requiring an invented Closed event', async () => {
  const peer = fixture();
  const original = new Error('connection setup failed');
  peer.call.mockImplementation(async (operation) => {
    if (operation === 'realtime_conversation_start_sdk') throw original;
  });
  await expect(peer.owner._start()).rejects.toBe(original);
  expect(peer.call.mock.calls.map(([operation]) => operation)).toEqual([
    'realtime_conversation_start_sdk',
    'realtime_conversation_close_sdk',
  ]);
  expect(peer.release).toHaveBeenCalledOnce();
});

it('admits one exact response batch for parallel functions and reports only authoritative per-call outcomes', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({ FunctionCallRequested: { call_id: 'one', name: 'first' } });
  peer.payload({ FunctionCallRequested: { call_id: 'two', name: 'second' } });
  peer.payload({ FunctionCallRequested: { call_id: 'one', name: 'first' } });
  expect(peer.session._submitRealtimeTools).not.toHaveBeenCalled();
  const done = {
    ResponseDone: {
      response_id: 'response',
      function_call_ids: ['one', 'two'],
    },
  };
  peer.payload(done);
  peer.payload(done);
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  expect(peer.session._submitRealtimeTools).toHaveBeenCalledExactlyOnceWith(
    peer.generation,
    'response',
    ['one', 'two'],
  );
  expect(peer.session.submit).not.toHaveBeenCalled();
  expect((await events.next()).value).toMatchObject({
    type: 'function_call',
    callId: 'one',
    status: 'started',
  });
  expect((await events.next()).value).toMatchObject({
    type: 'function_call',
    callId: 'two',
    status: 'started',
  });
  await events.next();
  await events.next(); // response lifecycle, including duplicate provider done
  peer.waits[0].resolve({ finalOutput: undefined });
  await Promise.resolve();
  peer.payload({ FunctionCallFinished: { call_id: 'one', succeeded: true } });
  peer.payload({ FunctionCallFinished: { call_id: 'two', succeeded: false } });
  expect((await events.next()).value).toMatchObject({
    callId: 'one',
    status: 'completed',
  });
  expect((await events.next()).value).toMatchObject({
    callId: 'two',
    status: 'failed',
  });
  await peer.owner.close();
});

it('reports original busy admission locally and fails only unclaimed correlated functions', async () => {
  const peer = fixture();
  await peer.owner._start();
  const original = new Error('caller root busy');
  peer.session._submitRealtimeTools.mockRejectedValueOnce(original);
  const implementation = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_fail_sdk')
      peer.payload({
        FunctionCallFinished: { call_id: params.handoff_id, succeeded: false },
      });
    return implementation(operation, params);
  });
  const events = peer.owner.events();
  await events.next();
  peer.payload({
    FunctionCallRequested: { call_id: 'busy', name: 'first', response_id: 'r' },
  });
  peer.payload({
    ResponseDone: { response_id: 'r', function_call_ids: ['busy'] },
  });
  await events.next();
  await events.next();
  expect((await events.next()).value).toMatchObject({
    type: 'tool_batch_error',
    error: original,
  });
  expect((await events.next()).value).toMatchObject({
    type: 'function_call',
    callId: 'busy',
    status: 'failed',
  });
  expect(peer.session.submit).not.toHaveBeenCalled();
  expect(peer.cancellations).toHaveLength(0);
  expect(JSON.stringify(peer.call.mock.calls)).not.toContain(
    'caller root busy',
  );
  await peer.owner.close();
});

it('joins the exact late-published tool batch on close and releases its wrapper after verified graph shutdown', async () => {
  const peer = fixture();
  await peer.owner._start();
  const admission = deferred<never>();
  peer.session._submitRealtimeTools.mockReturnValueOnce(admission.promise);
  peer.payload({ FunctionCallRequested: { call_id: 'held', name: 'first' } });
  peer.payload({
    ResponseDone: { response_id: 'r', function_call_ids: ['held'] },
  });
  await vi.waitFor(() =>
    expect(peer.session._submitRealtimeTools).toHaveBeenCalledOnce(),
  );
  peer.owner._retireFromSession();
  await peer.owner._nativeShutdown();
  expect(peer.release).toHaveBeenCalledOnce();
  admission.reject(new Error('public submission retired later'));
});

it.each(['close', 'interrupt'] as const)(
  'cancels exact batch work before a stalled media %s acknowledgement',
  async (operation) => {
    const peer = fixture();
    await peer.owner._start();
    peer.payload({
      FunctionCallRequested: { call_id: 'active', name: 'first' },
    });
    peer.payload({
      ResponseDone: { response_id: 'r', function_call_ids: ['active'] },
    });
    await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
    const gate = deferred<void>();
    const implementation = peer.call.getMockImplementation()!;
    peer.call.mockImplementation(async (name, params) => {
      if (name === `realtime_conversation_${operation}_sdk`) await gate.promise;
      return implementation(name, params);
    });
    const stopping = peer.owner[operation]();
    await vi.waitFor(() =>
      expect(peer.cancellations[0]).toHaveBeenCalledOnce(),
    );
    gate.resolve();
    await stopping;
    if (operation === 'interrupt') await peer.owner.close();
  },
);

it('preserves producing audio identity, bounds playback to received samples, and keeps default barge-in separate from its played item', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  const data = Buffer.alloc(160, 255);
  peer.payload({
    AudioOut: {
      data: data.toString('base64'),
      sample_rate: 8000,
      num_channels: 1,
      format: 'g711_ulaw',
      response_id: 'A',
      item_id: 'item-A',
      content_index: 1,
      output_index: 0,
    },
  });
  const audio = (await events.next()).value;
  expect(audio).toMatchObject({
    type: 'audio',
    format: 'g711_ulaw',
    sampleRate: 8000,
    responseId: 'A',
    itemId: 'item-A',
    contentIndex: 1,
    outputIndex: 0,
  });
  const playback = {
    responseId: 'A',
    itemId: 'item-A',
    contentIndex: 1,
    audioEndMs: 10,
  };
  peer.owner.reportPlayback(playback);
  expect(() =>
    peer.owner.reportPlayback({ ...playback, audioEndMs: 21 }),
  ).toThrow('exceeds');
  expect(() =>
    peer.owner.reportPlayback({ ...playback, audioEndMs: 9 }),
  ).toThrow('backwards');
  expect(() =>
    peer.owner.reportPlayback({ ...playback, itemId: 'unknown' }),
  ).toThrow('identify');
  peer.payload({ ResponseCreated: { response_id: 'B' } });
  await peer.owner.interrupt(undefined, { playback });
  expect(
    peer.call.mock.calls.find(
      ([op]) => op === 'realtime_conversation_interrupt_sdk',
    )?.[1],
  ).toMatchObject({
    response_id: null,
    playback: {
      response_id: 'A',
      item_id: 'item-A',
      content_index: 1,
      audio_end_ms: 10,
    },
  });
  await peer.owner.close();
});

it('does not admit stale function response completions after exact or default interruption', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload({
    FunctionCallRequested: { call_id: 'late', name: 'first', response_id: 'A' },
  });
  await peer.owner.interrupt('A');
  peer.payload({
    ResponseDone: { response_id: 'A', function_call_ids: ['late'] },
  });
  peer.payload({
    FunctionCallRequested: { call_id: 'unknown', name: 'second' },
  });
  await peer.owner.interrupt();
  peer.payload({
    ResponseDone: { response_id: 'B', function_call_ids: ['unknown'] },
  });
  await Promise.resolve();
  expect(peer.session._submitRealtimeTools).not.toHaveBeenCalled();
  await peer.owner.close();
});

it('returns the native WebRTC call receipt and rejects SIP audio before transport admission', async () => {
  const peer = fixture({ transport: { type: 'webrtc', offerSdp: 'offer' } });
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (op, params) => {
    await original(op, params);
    return op === 'realtime_conversation_start_sdk'
      ? JSON.stringify({ call_id: 'native-call', sdp: 'answer' })
      : undefined;
  });
  await peer.owner._start();
  expect(peer.owner.callId).toBe('native-call');
  expect(peer.owner.answerSdp).toBe('answer');
  expect(peer.call.mock.calls[0][1].params).toMatchObject({
    transport: { type: 'webrtc', sdp: 'offer' },
  });
  await peer.owner.close();
  const sip = fixture({ transport: { type: 'sip', callId: 'accepted-call' } });
  await sip.owner._start();
  const count = sip.call.mock.calls.length;
  await expect(sip.owner.sendAudio(new Int16Array([1]))).rejects.toThrow('SIP');
  expect(sip.call.mock.calls).toHaveLength(count);
  await sip.owner.close();
});

it('uses actual interrupt effects to discard old audio atomically while preserving a newer response', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({ ResponseCreated: { response_id: 'B' } });
  const gate = deferred<void>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (op, params) => {
    if (op === 'realtime_conversation_interrupt_sdk') {
      await gate.promise;
      return { retired_response_ids: ['A', 'B'], cancelled_response_id: 'B' };
    }
    return original(op, params);
  });
  const stopping = peer.owner.interrupt();
  const audio = (response_id: string) => ({
    AudioOut: {
      data: Buffer.from([1, 0]).toString('base64'),
      sample_rate: 24000,
      num_channels: 1,
      format: 'pcm16',
      response_id,
      item_id: `item-${response_id}`,
      content_index: 0,
    },
  });
  peer.payload(audio('A'));
  peer.payload(audio('C'));
  gate.resolve();
  await stopping;
  expect((await events.next()).value).toMatchObject({
    type: 'response',
    responseId: 'B',
  });
  expect((await events.next()).value).toMatchObject({
    type: 'audio',
    responseId: 'C',
  });
  expect((await events.next()).value).toMatchObject({
    type: 'playback_interrupted',
    retiredResponseIds: ['A', 'B'],
    cancelledResponseId: 'B',
  });
  peer.payload(audio('A'));
  peer.payload({
    OutputTranscriptDelta: { delta: 'retired', response_id: 'B' },
  });
  peer.payload({ InputAudioSpeechStopped: {} });
  expect((await events.next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'speech_stopped',
  });
  await peer.owner.close();
});

it('surfaces failed startup cleanup distinctly from the exact caller abort and retains cleanup for retry', async () => {
  const controller = new AbortController();
  const peer = fixture({ signal: controller.signal });
  const admitted = deferred<void>();
  const abort = new Error('bridge-owned abort');
  const cleanup = new Error('hangup failed');
  const original = peer.call.getMockImplementation()!;
  let rejectClose = true;
  peer.call.mockImplementation(async (op, params) => {
    if (op === 'realtime_conversation_start_sdk') await admitted.promise;
    if (op === 'realtime_conversation_close_sdk' && rejectClose) throw cleanup;
    return original(op, params);
  });
  const opening = peer.owner._start();
  controller.abort(abort);
  admitted.resolve();
  const result = await opening.catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.cause).toBe(abort);
  expect(result.errors).toEqual([abort, cleanup]);
  expect(peer.release).not.toHaveBeenCalled();
  rejectClose = false;
  await peer.owner.close();
  expect(peer.release).toHaveBeenCalledOnce();
});

it('inherits native tools atomically by default and preserves an explicit empty selection', async () => {
  const inherited = fixture();
  await inherited.owner._start();
  expect(inherited.call.mock.calls[0][1].function_tools).toBeNull();
  expect(inherited.session._realtimeFunctionTools).not.toHaveBeenCalled();
  await inherited.owner.close();
  const selected = fixture({ tools: [] });
  await selected.owner._start();
  expect(
    selected.session._realtimeFunctionTools,
  ).toHaveBeenCalledExactlyOnceWith([]);
  expect(selected.call.mock.calls[0][1].function_tools).toEqual([]);
  await selected.owner.close();
});

it('runs source-stamped frontend guardrails in the voice entry context and scopes a delayed trip away from newer output', async () => {
  const scope = new AsyncLocalStorage<string>();
  const gate = deferred<void>();
  const context = { request: 'caller' };
  const inputs: unknown[] = [];
  const peer = scope.run('voice scope', () =>
    fixture({
      guardrailTextThreshold: null,
      outputGuardrails: [
        {
          name: 'policy',
          feedback: 'developer policy',
          callback: async (input) => {
            expect(scope.getStore()).toBe('voice scope');
            inputs.push(input);
            if (input.responseId === 'A') await gate.promise;
            return {
              tripwireTriggered: input.responseId === 'A',
              outputInfo: 'private diagnostic',
            };
          },
        },
      ],
    }),
  );
  peer.session._realtimeGuardrailSource.mockImplementation((receipt) => ({
    agent: { name: (receipt as { profile_id: string }).profile_id } as never,
    context,
  }));
  await peer.owner._start();
  const collected: unknown[] = [];
  const consuming = (async () => {
    for await (const event of peer.owner.events()) collected.push(event);
  })();
  const text = (id: string) => ({
    OutputTranscriptDone: {
      text: `answer ${id}`,
      response_id: id,
      item_id: `item-${id}`,
      content_index: 0,
      output_kind: 'text',
      profile_receipt: { profile_id: id, epoch: 1 },
    },
  });
  peer.payload(text('A'));
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  peer.payload({ ResponseCreated: { response_id: 'B' } });
  peer.payload(text('B'));
  await vi.waitFor(() =>
    expect(collected).toContainEqual(
      expect.objectContaining({
        type: 'guardrail',
        input: expect.objectContaining({ responseId: 'B' }),
      }),
    ),
  );
  gate.resolve();
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.find(
        ([op]) => op === 'realtime_conversation_interrupt_sdk',
      )?.[1],
    ).toMatchObject({ response_id: 'A', feedback: 'developer policy' }),
  );
  expect(inputs).toContainEqual(
    expect.objectContaining({
      agent: expect.objectContaining({ name: 'A' }),
      context,
    }),
  );
  expect(JSON.stringify(peer.call.mock.calls)).not.toContain(
    'private diagnostic',
  );
  await peer.owner.close();
  await consuming;
});
