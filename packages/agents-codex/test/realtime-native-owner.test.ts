import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import { NativeRealtimePlayback } from '../src/runtime/realtime-playback';
import {
  createNativeRealtimeOwner,
  type NativeRealtimeOptions,
  type NativeRealtimeCall,
} from '../src/runtime/realtime';
import type { NativeEvent } from '../src/runtime/events';
import type { Session } from '../src/runtime/session';
import type {
  NativeRealtimeAdapterBridge,
  NativeRealtimeAdapterHandle,
} from '../src/runtime/realtime-adapter';

function deferred<T>() {
  return Promise.withResolvers<T>();
}
function fixture(
  options: NativeRealtimeOptions = {},
  adapterBridge?: NativeRealtimeAdapterBridge,
) {
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
    return {
      turnId: `root-${waits.length}`,
      wait: vi.fn(() => result.promise),
      cancel,
      events: vi.fn(),
    };
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
        _signal?: AbortSignal,
      ) => admit(),
    ),
    _prepareRealtimeMcp: vi.fn(async () => {}),
    _realtimeFunctionTools: vi.fn(async (_tools: readonly unknown[]) => ({
      tools: [],
      selectionId: null,
    })),
    close: vi.fn(),
    _checkVoiceOperation: vi.fn(),
    _checkVoiceAdapterOperation: vi.fn(),
    _runVoiceCallback: vi.fn(async (callback: () => unknown) => callback()),
    _realtimeCurrentProfile: vi.fn(async () => null),
    _realtimeProfileTarget: vi.fn((target: unknown) => target ?? null),
    _realtimeGuardrailSource: vi.fn((_receipt: unknown) => ({
      agent: { name: 'captured Agent' } as never,
      context: undefined as unknown,
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
    if (operation === 'realtime_conversation_prepare_sdk') {
      generation = params.generation as string;
      return { generation };
    }
    if (operation === 'realtime_conversation_activate_sdk') {
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
    adapterBridge && {
      create: adapterBridge.create,
      prepare: (params, handle) => {
        generation = params.generation as string;
        return adapterBridge.prepare(params, handle);
      },
    },
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
    const result = await original(op, params);
    if (op === 'realtime_conversation_activate_sdk') await admitted.promise;
    return result;
  });
  const pending = peer.owner._start();
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.some(
        ([op]) => op === 'realtime_conversation_activate_sdk',
      ),
    ).toBe(true),
  );
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

it('retries failed native cleanup even when the transport has already reported Closed', async () => {
  const peer = fixture();
  await peer.owner._start();
  peer.payload({ HandoffRequested: { handoff_id: 'owned' } }, 'question');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  const original = peer.call.getMockImplementation()!;
  let first = true;
  peer.call.mockImplementation(async (op, params) => {
    if (op === 'realtime_conversation_close_sdk' && first) {
      first = false;
      peer.event('realtime_conversation_closed', {
        reason: 'transport_closed',
      });
      throw new Error('media cleanup failed');
    }
    return original(op, params);
  });
  await expect(peer.owner.close()).rejects.toThrow('media cleanup failed');
  expect(peer.cancellations[0]).toHaveBeenCalledOnce();
  expect(peer.release).not.toHaveBeenCalled();
  await peer.owner.close();
  expect(
    peer.call.mock.calls.filter(
      ([op]) => op === 'realtime_conversation_close_sdk',
    ),
  ).toHaveLength(2);
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
    ([op]) => op === 'realtime_conversation_prepare_sdk',
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
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_prepare_sdk')
      return { generation: params.generation };
    if (operation === 'realtime_conversation_activate_sdk') throw original;
  });
  await expect(peer.owner._start()).rejects.toBe(original);
  expect(peer.call.mock.calls.map(([operation]) => operation)).toEqual([
    'realtime_conversation_prepare_sdk',
    'realtime_conversation_activate_sdk',
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
    expect.any(AbortSignal),
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
  'retires exact batch admission before a stalled media %s acknowledgement',
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
    expect(peer.cancellations[0]).not.toHaveBeenCalled();
    expect(peer.session._submitRealtimeTools.mock.calls[0][3]?.aborted).toBe(
      true,
    );
    gate.resolve();
    // Model the root terminal that follows Core joining the retired batch.
    peer.waits[0].resolve({ finalOutput: undefined });
    await stopping;
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
    const result = await original(op, params);
    return op === 'realtime_conversation_activate_sdk'
      ? JSON.stringify({ call_id: 'native-call', sdp: 'answer' })
      : result;
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
    if (op === 'realtime_conversation_activate_sdk') await admitted.promise;
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

it('issues one-shot hosted MCP approvals and restores a live locally rejected attempt', async () => {
  const peer = fixture({ automaticallyTriggerResponseForMcpToolCalls: false });
  const other = fixture();
  await peer.owner._start();
  await other.owner._start();
  expect(peer.call.mock.calls[0][1]).toHaveProperty(
    'hosted_mcp_auto_response',
    false,
  );
  const events = peer.owner.events();
  await events.next();
  peer.payload({
    HostedMcpApprovalRequested: {
      approval_id: 'private-token',
      request_id: 'request-1',
      server_label: 'docs',
      tool_name: 'search',
      arguments: '{"query":"hello"}',
      response_id: 'response-1',
    },
  });
  const event = (await events.next()).value;
  if (!event || event.type !== 'hosted_mcp_approval_requested')
    throw new Error('Missing approval event');
  expect(Object.isFrozen(event)).toBe(true);
  expect(event).not.toHaveProperty('approval_id');
  expect(
    peer.call.mock.calls.filter(
      ([operation]) =>
        operation === 'realtime_conversation_hosted_mcp_approval_sdk',
    ),
  ).toHaveLength(0);
  await expect(
    peer.owner.approveHostedMcp({ ...event }, { approve: true }),
  ).rejects.toThrow('issued');
  await expect(
    other.owner.approveHostedMcp(event, { approve: true }),
  ).rejects.toThrow('issued');
  await expect(
    peer.owner.approveHostedMcp(event, { approve: 'yes' } as never),
  ).rejects.toThrow('boolean');
  const original = peer.call.getMockImplementation()!;
  let rejected = false;
  peer.call.mockImplementation(async (operation, params) => {
    if (
      operation === 'realtime_conversation_hosted_mcp_approval_sdk' &&
      !rejected
    ) {
      rejected = true;
      throw new Error('local rejected admission');
    }
    return original(operation, params);
  });
  await expect(
    peer.owner.approveHostedMcp(event, { approve: true }),
  ).rejects.toThrow('local rejected');
  await peer.owner.approveHostedMcp(event, {
    approve: false,
    reason: 'Application decision',
  });
  expect(peer.call.mock.calls.at(-1)).toEqual([
    'realtime_conversation_hosted_mcp_approval_sdk',
    {
      generation: peer.generation,
      approval_id: 'private-token',
      approve: false,
      reason: 'Application decision',
    },
  ]);
  await expect(
    peer.owner.approveHostedMcp(event, { approve: true }),
  ).rejects.toThrow('submitted');
  await events.return(undefined);
  await peer.owner.close();
  await other.owner.close();
});

it('fences concurrent hosted approval attempts before the first native reply', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({
    HostedMcpApprovalRequested: {
      approval_id: 'token',
      request_id: 'request',
      server_label: 'docs',
      tool_name: 'lookup',
      arguments: '{}',
    },
  });
  const request = (await events.next()).value;
  if (!request || request.type !== 'hosted_mcp_approval_requested')
    throw new Error('Missing request');
  const held = deferred<void>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation((operation, params) =>
    operation === 'realtime_conversation_hosted_mcp_approval_sdk'
      ? held.promise
      : original(operation, params),
  );
  const first = peer.owner.approveHostedMcp(request, { approve: true });
  await expect(
    peer.owner.approveHostedMcp(request, { approve: false }),
  ).rejects.toThrow('submitted');
  held.resolve();
  await first;
  await events.return(undefined);
  await peer.owner.close();
});

it.each([
  null,
  { profile_id: 'A', epoch: '1' },
  { profile_id: 'B', epoch: '2' },
])(
  'binds exact delegation source before forwarding accepted text (target=%j)',
  async (target) => {
    const peer = fixture();
    peer.session._realtimeCurrentProfile.mockResolvedValue(target as never);
    const held = deferred<void>();
    const original = peer.call.getMockImplementation()!;
    peer.call.mockImplementation((operation, params) =>
      operation === 'realtime_conversation_update_sdk'
        ? held.promise
        : original(operation, params),
    );
    await peer.owner._start();
    peer.payload(
      {
        HandoffRequested: { handoff_id: 'delegate', response_id: 'response-A' },
      },
      'native input',
    );
    await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
    peer.waits[0].resolve({ finalOutput: 'accepted B text' });
    await vi.waitFor(() =>
      expect(
        peer.call.mock.calls.find(
          ([operation]) => operation === 'realtime_conversation_update_sdk',
        )?.[1],
      ).toMatchObject({
        update: {},
        profile: {
          response_id: null,
          delegation_id: 'delegate',
          target,
          function_tools: null,
        },
      }),
    );
    expect(
      peer.call.mock.calls.some(
        ([operation]) => operation === 'realtime_conversation_complete_sdk',
      ),
    ).toBe(false);
    held.resolve();
    await vi.waitFor(() =>
      expect(
        peer.call.mock.calls.find(
          ([operation]) => operation === 'realtime_conversation_complete_sdk',
        )?.[1],
      ).toMatchObject({ text: 'accepted B text' }),
    );
    await peer.owner.close();
  },
);

it('keeps the reader moving during a bound ACK and joins its rejection on close', async () => {
  const context = new AsyncLocalStorage<string>();
  const peer = context.run('voice entry', () => fixture());
  const held = deferred<void>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation((operation, params) => {
    if (operation === 'realtime_conversation_update_sdk') {
      expect(context.getStore()).toBe('voice entry');
      return held.promise;
    }
    return original(operation, params);
  });
  await peer.owner._start();
  expect(
    peer.payload({
      FunctionBatchFinished: {
        response_id: 'response-A',
        target: { profile_id: 'B', epoch: '2' },
      },
    }),
  ).toBe(true);
  peer.payload({ SessionUpdated: { realtime_session_id: 'still-reading' } });
  let closed = false;
  const closing = peer.owner.close().then(() => {
    closed = true;
  });
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.some(
        ([operation]) => operation === 'realtime_conversation_close_sdk',
      ),
    ).toBe(true),
  );
  expect(closed).toBe(false);
  held.reject(new Error('ACK retired by close'));
  await closing;
  expect(peer.release).toHaveBeenCalledOnce();
});

it('cancels a slow native setup before joining its admission', async () => {
  const peer = fixture();
  const admission = deferred<never>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_activate_sdk')
      return admission.promise;
    if (operation === 'realtime_conversation_close_sdk')
      admission.reject(new Error('startup cancelled by Core close'));
    return original(operation, params);
  });
  const pending = peer.owner._start();
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.some(
        ([op]) => op === 'realtime_conversation_activate_sdk',
      ),
    ).toBe(true),
  );
  await peer.owner.close();
  await rejected;
  expect(peer.call.mock.calls.map(([operation]) => operation)).toEqual([
    'realtime_conversation_prepare_sdk',
    'realtime_conversation_activate_sdk',
    'realtime_conversation_close_sdk',
  ]);
  expect(peer.release).toHaveBeenCalledOnce();
}, 1000);

it('closes before delayed tool preparation without allowing a later native start', async () => {
  const peer = fixture({ tools: [] });
  const selection = deferred<{ tools: []; selectionId: null }>();
  peer.session._realtimeFunctionTools.mockReturnValueOnce(selection.promise);
  const pending = peer.owner._start();
  const rejected = expect(pending).rejects.toThrow();
  await peer.owner.close();
  await rejected;
  expect(peer.release).toHaveBeenCalledOnce();
  selection.resolve({ tools: [], selectionId: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(
    peer.call.mock.calls.some(
      ([operation]) => operation === 'realtime_conversation_activate_sdk',
    ),
  ).toBe(false);
}, 1000);

it('joins and retains a late successful call receipt after native close', async () => {
  const peer = fixture({ transport: { type: 'webrtc', offerSdp: 'offer' } });
  const admission = deferred<unknown>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation((operation, params) => {
    if (operation === 'realtime_conversation_activate_sdk') {
      void original(operation, params);
      return admission.promise;
    }
    return original(operation, params);
  });
  const pending = peer.owner._start();
  const rejected = expect(pending).rejects.toThrow();
  let closed = false;
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.some(
        ([op]) => op === 'realtime_conversation_activate_sdk',
      ),
    ).toBe(true),
  );
  const closing = peer.owner.close().then(() => {
    closed = true;
  });
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.some(
        ([operation]) => operation === 'realtime_conversation_close_sdk',
      ),
    ).toBe(true),
  );
  expect(closed).toBe(false);
  admission.resolve({ call_id: 'late-call', sdp: 'late-answer' });
  await closing;
  await rejected;
  expect(peer.owner.callId).toBe('late-call');
  expect(peer.owner.answerSdp).toBe('late-answer');
  expect(peer.release).toHaveBeenCalledOnce();
}, 1000);

it('captures the credential source and resolves it only after native preparation', async () => {
  const source = vi.fn(async () => {
    expect(peer.call.mock.calls.map(([operation]) => operation)).toEqual([
      'realtime_conversation_prepare_sdk',
    ]);
    return 'connection-only-key';
  });
  const options: NativeRealtimeOptions = { apiKey: source };
  const peer = fixture(options);
  options.apiKey = () => 'changed-after-capture';
  await peer.owner._start();
  expect(source).toHaveBeenCalledOnce();
  expect(
    peer.call.mock.calls.find(
      ([op]) => op === 'realtime_conversation_activate_sdk',
    )?.[1],
  ).toEqual({ generation: peer.generation, api_key: 'connection-only-key' });
  expect(peer.call.mock.calls[0][1]).not.toHaveProperty('api_key');
  await peer.owner.close();
});

it.each(['resolve', 'reject'] as const)(
  'closes without awaiting a noncooperative credential source and observes late %s',
  async (outcome) => {
    const key = deferred<string>();
    let suppliedSignal: AbortSignal | undefined;
    const source = vi.fn((signal?: AbortSignal) => {
      suppliedSignal = signal;
      return key.promise;
    });
    const peer = fixture({ apiKey: source });
    const opening = peer.owner._start();
    const rejected = expect(opening).rejects.toThrow();
    await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
    await peer.owner.close();
    await rejected;
    expect(suppliedSignal?.aborted).toBe(true);
    expect(peer.release).toHaveBeenCalledOnce();
    if (outcome === 'resolve') key.resolve('late-private-key');
    else key.reject(new Error('late-private-error'));
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.call.mock.calls.map(([op]) => op)).toEqual([
      'realtime_conversation_prepare_sdk',
      'realtime_conversation_close_sdk',
    ]);
  },
  1000,
);

it('aborts credential resolution with the caller signal', async () => {
  const controller = new AbortController();
  const key = deferred<string>();
  const source = vi.fn(() => key.promise);
  const peer = fixture({ apiKey: source, signal: controller.signal });
  const opening = peer.owner._start();
  const reason = new Error('caller cancelled credential resolution');
  const rejected = expect(opening).rejects.toBe(reason);
  await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
  controller.abort(reason);
  await rejected;
  expect(peer.release).toHaveBeenCalledOnce();
  key.resolve('late-key');
  await Promise.resolve();
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_activate_sdk',
    ),
  ).toBe(false);
});

it.each(['', null])(
  'rejects invalid resolved credentials %s before activation',
  async (value) => {
    const peer = fixture({ apiKey: () => value as string });
    await expect(peer.owner._start()).rejects.toThrow(
      'credential source must return a nonempty string',
    );
    expect(
      peer.call.mock.calls.some(
        ([op]) => op === 'realtime_conversation_activate_sdk',
      ),
    ).toBe(false);
    expect(peer.release).toHaveBeenCalledOnce();
  },
);

it('preserves a credential callback failure without sending it to Core', async () => {
  const problem = new Error('private credential failure');
  const peer = fixture({
    apiKey: async () => {
      throw problem;
    },
  });
  await expect(peer.owner._start()).rejects.toBe(problem);
  expect(JSON.stringify(peer.call.mock.calls)).not.toContain(problem.message);
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_activate_sdk',
    ),
  ).toBe(false);
  expect(peer.release).toHaveBeenCalledOnce();
});

it('joins dispatched preparation on close without invoking credentials afterward', async () => {
  const source = vi.fn(() => 'must-not-resolve');
  const peer = fixture({ apiKey: source });
  const prepared = deferred<unknown>();
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation((operation, params) => {
    if (operation === 'realtime_conversation_prepare_sdk') {
      void original(operation, params);
      return prepared.promise;
    }
    return original(operation, params);
  });
  const opening = peer.owner._start();
  const rejected = expect(opening).rejects.toThrow();
  let closed = false;
  const closing = peer.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  prepared.resolve({ generation: peer.generation });
  await closing;
  await rejected;
  expect(source).not.toHaveBeenCalled();
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_activate_sdk',
    ),
  ).toBe(false);
  expect(peer.release).toHaveBeenCalledOnce();
});

it.each([null, undefined])(
  'preserves a custom adapter rejection of %s through the owner',
  async (reason) => {
    type Request = Awaited<ReturnType<NativeRealtimeAdapterHandle['next']>>;
    let deliver: (request: Request) => void = () => {
      throw new Error('Driver is not waiting');
    };
    const handle: NativeRealtimeAdapterHandle = {
      next: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
      receive: async () => {},
      end: vi.fn(),
      finish: () => deliver(null),
    };
    const peer = fixture(
      {
        adapter: {
          connect: async () => {
            throw reason;
          },
        },
      },
      {
        create: () => handle,
        prepare: async (params) => ({ generation: params.generation }),
      },
    );
    const original = peer.call.getMockImplementation()!;
    peer.call.mockImplementation(async (operation, params) => {
      if (operation !== 'realtime_conversation_activate_sdk')
        return original(operation, params);
      const connected = await new Promise<boolean>((resolve) =>
        deliver({
          event_json: JSON.stringify({
            type: 'connect',
            url: 'wss://example.invalid/realtime',
            headers: {},
          }),
          complete: (success) => {
            resolve(success);
            return true;
          },
        }),
      );
      expect(connected).toBe(false);
      throw new Error('Native adapter connection failed');
    });
    const outcome = await peer.owner._start().then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    expect(outcome).toEqual({ status: 'rejected', error: reason });
    expect(peer.release).toHaveBeenCalledOnce();
  },
);

it('attaches overlapping responses to one root and scoped interruption preserves the sibling', async () => {
  const peer = fixture();
  await peer.owner._start();
  const submit = peer.session._submitRealtimeTools.getMockImplementation()!;
  const shared = submit('generation', 'A', ['a']);
  peer.session._submitRealtimeTools.mockImplementation(() => shared);
  const events: Array<{ type: string; callId?: string; status?: string }> = [];
  const reading = (async () => {
    for await (const event of peer.owner.events()) events.push(event);
  })();
  for (const [responseId, callId] of [
    ['A', 'a'],
    ['B', 'b'],
  ]) {
    peer.payload({
      FunctionCallRequested: {
        call_id: callId,
        name: 'tool',
        response_id: responseId,
      },
    });
    peer.payload({
      ResponseDone: { response_id: responseId, function_call_ids: [callId] },
    });
  }
  await vi.waitFor(() =>
    expect(peer.session._submitRealtimeTools).toHaveBeenCalledTimes(2),
  );
  const root = await shared;
  expect(root.wait).toHaveBeenCalledOnce();
  expect(peer.waits).toHaveLength(1);
  await peer.owner.interrupt('A');
  expect(root.cancel).not.toHaveBeenCalled();
  peer.payload({ FunctionCallFinished: { call_id: 'b', succeeded: true } });
  peer.payload({ FunctionBatchFinished: { response_id: 'B', target: null } });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'function_call',
        callId: 'b',
        status: 'completed',
      }),
    ),
  );
  peer.waits[0].resolve({ finalOutput: '' });
  await peer.owner.close();
  await reading;
  expect(root.wait).toHaveBeenCalledOnce();
  expect(root.cancel).not.toHaveBeenCalled();
});

it.each(['interrupt', 'close'] as const)(
  'retains pending batch admission after a failed %s ACK and joins successful close',
  async (operation) => {
    const peer = fixture();
    await peer.owner._start();
    const root = {
      turnId: 'root-1',
      wait: vi.fn(async () => ({ finalOutput: '' })),
      cancel: vi.fn(async () => {}),
      events: vi.fn(),
    };
    const admission = deferred<typeof root>();
    peer.session._submitRealtimeTools.mockReturnValueOnce(admission.promise);
    peer.payload({
      FunctionCallRequested: {
        call_id: 'held',
        name: 'tool',
        response_id: 'A',
      },
    });
    peer.payload({
      ResponseDone: { response_id: 'A', function_call_ids: ['held'] },
    });
    await vi.waitFor(() =>
      expect(peer.session._submitRealtimeTools).toHaveBeenCalledOnce(),
    );
    const original = peer.call.getMockImplementation()!;
    const primary = new Error('media cleanup failed');
    let fail = true;
    peer.call.mockImplementation((name, params) => {
      if (name === `realtime_conversation_${operation}_sdk` && fail) {
        fail = false;
        return Promise.reject(primary);
      }
      return original(name, params);
    });
    await expect(peer.owner[operation]()).rejects.toBe(primary);
    expect(root.cancel).not.toHaveBeenCalled();
    let stopped = false;
    const retry = peer.owner.close().then(() => {
      stopped = true;
    });
    await vi.waitFor(() =>
      expect(
        peer.call.mock.calls.filter(
          ([name]) => name === `realtime_conversation_close_sdk`,
        ),
      ).toHaveLength(operation === 'close' ? 2 : 1),
    );
    expect(stopped).toBe(false);
    admission.resolve(root);
    await retry;
    expect(root.cancel).not.toHaveBeenCalled();
    expect(peer.release).toHaveBeenCalledOnce();
  },
);

it('joins a late old-root attach without waiting for a newer response root', async () => {
  const peer = fixture();
  await peer.owner._start();
  const submit = peer.session._submitRealtimeTools.getMockImplementation()!;
  const first = await submit('generation', 'A', ['a']);
  const current = await submit('generation', 'C', ['c']);
  const late = deferred<typeof first>();
  peer.session._submitRealtimeTools
    .mockReturnValueOnce(Promise.resolve(first))
    .mockReturnValueOnce(late.promise)
    .mockReturnValueOnce(Promise.resolve(current));
  const request = (responseId: string, callId: string) => {
    peer.payload({
      FunctionCallRequested: {
        call_id: callId,
        name: 'tool',
        response_id: responseId,
      },
    });
    peer.payload({
      ResponseDone: { response_id: responseId, function_call_ids: [callId] },
    });
  };
  request('A', 'a');
  await vi.waitFor(() => expect(first.wait).toHaveBeenCalledOnce());
  request('B', 'b');
  await vi.waitFor(() =>
    expect(peer.session._submitRealtimeTools).toHaveBeenCalledTimes(2),
  );
  peer.payload({ FunctionBatchFinished: { response_id: 'A', target: null } });
  peer.waits[0].resolve({ finalOutput: '' });
  await first.wait();
  request('C', 'c');
  await vi.waitFor(() => expect(current.wait).toHaveBeenCalledOnce());
  late.resolve(first);
  await peer.owner.interrupt('B');
  expect(first.cancel).not.toHaveBeenCalled();
  expect(current.cancel).not.toHaveBeenCalled();
  peer.payload({ FunctionBatchFinished: { response_id: 'C', target: null } });
  peer.waits[1].resolve({ finalOutput: '' });
  await peer.owner.close();
  // One application call above also awaits first.wait().
  expect(first.wait).toHaveBeenCalledTimes(2);
  expect(current.wait).toHaveBeenCalledOnce();
});

it('releases an existing failed-interrupt admission waiter on verified graph shutdown', async () => {
  const peer = fixture();
  await peer.owner._start();
  const admission = deferred<never>();
  peer.session._submitRealtimeTools.mockReturnValueOnce(admission.promise);
  peer.payload({
    FunctionCallRequested: { call_id: 'held', name: 'tool', response_id: 'A' },
  });
  peer.payload({
    ResponseDone: { response_id: 'A', function_call_ids: ['held'] },
  });
  await vi.waitFor(() =>
    expect(peer.session._submitRealtimeTools).toHaveBeenCalledOnce(),
  );
  const original = peer.call.getMockImplementation()!;
  const primary = new Error('interrupt failed');
  peer.call.mockImplementation((operation, params) =>
    operation === 'realtime_conversation_interrupt_sdk'
      ? Promise.reject(primary)
      : original(operation, params),
  );
  await expect(peer.owner.interrupt('A')).rejects.toBe(primary);
  peer.owner._retireFromSession();
  await peer.owner._nativeShutdown();
  await expect(peer.owner.sendText('cannot continue')).rejects.toThrow();
  expect(peer.release).toHaveBeenCalledOnce();
  admission.reject(new Error('submission wrapper released later'));
});

it('reports a shared root fatal error and joins both admitted response batches', async () => {
  const peer = fixture();
  await peer.owner._start();
  const submit = peer.session._submitRealtimeTools.getMockImplementation()!;
  const shared = submit('generation', 'A', ['a']);
  peer.session._submitRealtimeTools.mockImplementation(() => shared);
  const reading = (async () => {
    for await (const _event of peer.owner.events()) {
      /* drain */
    }
  })();
  const primary = new Error('native root failed');
  const observed = expect(reading).rejects.toBe(primary);
  for (const [responseId, callId] of [
    ['A', 'a'],
    ['B', 'b'],
  ]) {
    peer.payload({
      FunctionCallRequested: {
        call_id: callId,
        name: 'tool',
        response_id: responseId,
      },
    });
    peer.payload({
      ResponseDone: { response_id: responseId, function_call_ids: [callId] },
    });
  }
  await vi.waitFor(() =>
    expect(peer.session._submitRealtimeTools).toHaveBeenCalledTimes(2),
  );
  peer.waits[0].reject(primary);
  await observed;
  await peer.owner.close();
  expect((await shared).wait).toHaveBeenCalledOnce();
  expect(peer.release).toHaveBeenCalledOnce();
});

it.each([undefined, '', 'Explicit voice instructions'])(
  'preserves initial instruction inheritance for %s',
  async (instructions) => {
    const peer = fixture(instructions === undefined ? {} : { instructions });
    await peer.owner._start();
    const preparation = peer.call.mock.calls.find(
      ([operation]) => operation === 'realtime_conversation_prepare_sdk',
    )![1];
    if (instructions === undefined)
      expect(preparation.params).not.toHaveProperty('prompt');
    else expect(preparation.params).toHaveProperty('prompt', instructions);
    await peer.owner.close();
  },
);

it('waits only for an exact native-joined root receipt before interrupt returns', async () => {
  const peer = fixture();
  await peer.owner._start();
  const request = (responseId: string, callId: string) => {
    peer.payload({
      FunctionCallRequested: {
        call_id: callId,
        name: 'tool',
        response_id: responseId,
      },
    });
    peer.payload({
      ResponseDone: { response_id: responseId, function_call_ids: [callId] },
    });
  };
  request('A', 'a');
  request('B', 'b');
  await vi.waitFor(() => expect(peer.waits).toHaveLength(2));
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation((operation, params) =>
    operation === 'realtime_conversation_interrupt_sdk'
      ? Promise.resolve({
          retired_response_ids: ['A'],
          joined_root_turn_ids: ['root-1'],
        })
      : original(operation, params),
  );
  let stopped = false;
  const stopping = peer.owner.interrupt('A').then(() => {
    stopped = true;
  });
  await vi.waitFor(() =>
    expect(
      peer.call.mock.calls.some(
        ([operation]) => operation === 'realtime_conversation_interrupt_sdk',
      ),
    ).toBe(true),
  );
  expect(stopped).toBe(false);
  peer.waits[0].resolve({ finalOutput: '' });
  await stopping;
  expect(
    peer.cancellations.every((cancel) => cancel.mock.calls.length === 0),
  ).toBe(true);
  peer.payload({ FunctionBatchFinished: { response_id: 'B', target: null } });
  peer.waits[1].resolve({ finalOutput: '' });
  await peer.owner.close();
});

it('associates a pending admission before joining the exact sealed root', async () => {
  const peer = fixture();
  await peer.owner._start();
  const terminal = deferred<{ finalOutput: unknown }>();
  const root = {
    turnId: 'delayed-root',
    wait: vi.fn(() => terminal.promise),
    cancel: vi.fn(async () => {}),
    events: vi.fn(),
  };
  const admission = deferred<typeof root>();
  peer.session._submitRealtimeTools.mockReturnValueOnce(admission.promise);
  peer.payload({
    FunctionCallRequested: { call_id: 'a', name: 'tool', response_id: 'A' },
  });
  peer.payload({
    ResponseDone: { response_id: 'A', function_call_ids: ['a'] },
  });
  await vi.waitFor(() =>
    expect(peer.session._submitRealtimeTools).toHaveBeenCalledOnce(),
  );
  const original = peer.call.getMockImplementation()!;
  peer.call.mockImplementation((operation, params) =>
    operation === 'realtime_conversation_interrupt_sdk'
      ? Promise.resolve({
          retired_response_ids: ['A'],
          joined_root_turn_ids: ['delayed-root'],
        })
      : original(operation, params),
  );
  let stopped = false;
  const stopping = peer.owner.interrupt('A').then(() => {
    stopped = true;
  });
  admission.resolve(root);
  await vi.waitFor(() => expect(root.wait).toHaveBeenCalledOnce());
  expect(stopped).toBe(false);
  terminal.resolve({ finalOutput: '' });
  await stopping;
  expect(root.cancel).not.toHaveBeenCalled();
  await peer.owner.close();
});

it('promotes inherited MCP before opening native media', async () => {
  const peer = fixture();
  const promoted = deferred<void>();
  peer.session._prepareRealtimeMcp.mockReturnValueOnce(promoted.promise);
  const opening = peer.owner._start();
  expect(peer.session._realtimeFunctionTools).not.toHaveBeenCalled();
  expect(peer.call).not.toHaveBeenCalled();
  promoted.resolve();
  await opening;
  expect(peer.session._realtimeFunctionTools).not.toHaveBeenCalled();
  expect(peer.call.mock.calls[0][0]).toBe('realtime_conversation_prepare_sdk');
  await peer.owner.close();
});

it.each([false, true])(
  'promotes MCP before a live inherited refresh and skips explicit tools (explicit=%s)',
  async (explicit) => {
    const peer = fixture(explicit ? { tools: [] } : {});
    await peer.owner._start();
    peer.session._prepareRealtimeMcp.mockClear();
    peer.call.mockClear();
    const promoted = deferred<void>();
    peer.session._prepareRealtimeMcp.mockReturnValueOnce(promoted.promise);
    const refreshing = peer.owner._syncProfile(true);
    if (explicit) {
      await refreshing;
      expect(peer.session._prepareRealtimeMcp).not.toHaveBeenCalled();
    } else {
      expect(peer.session._prepareRealtimeMcp).toHaveBeenCalledOnce();
      expect(peer.call).not.toHaveBeenCalled();
      promoted.resolve();
      await refreshing;
    }
    expect(peer.call.mock.calls[0][0]).toBe('realtime_conversation_update_sdk');
    await peer.owner.close();
  },
);

it('does not capture tools or start media after close during MCP promotion', async () => {
  const peer = fixture();
  const promoted = deferred<void>();
  peer.session._prepareRealtimeMcp.mockReturnValueOnce(promoted.promise);
  const opening = peer.owner._start();
  const rejected = expect(opening).rejects.toThrow();
  await peer.owner.close();
  await rejected;
  promoted.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(peer.session._realtimeFunctionTools).not.toHaveBeenCalled();
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_prepare_sdk',
    ),
  ).toBe(false);
  expect(
    peer.call.mock.calls.some(
      ([op]) => op === 'realtime_conversation_activate_sdk',
    ),
  ).toBe(false);
});

it.each([false, true])(
  'skips inherited MCP promotion for explicit voice tools (nonempty=%s)',
  async (nonempty) => {
    const tools = nonempty ? [{} as never] : [];
    const peer = fixture({ tools });
    await peer.owner._start();
    expect(peer.session._prepareRealtimeMcp).not.toHaveBeenCalled();
    expect(peer.session._realtimeFunctionTools).toHaveBeenCalledWith(tools);
    expect(peer.call.mock.calls[0][0]).toBe(
      'realtime_conversation_prepare_sdk',
    );
    await peer.owner.close();
  },
);

it('keeps ordinary graph batches live without validating a handoff target', async () => {
  const peer = fixture();
  peer.session._realtimeProfileTarget.mockImplementation(() => {
    throw new TypeError('Native source has no admitted Agent profile');
  });
  await peer.owner._start();
  peer.call.mockClear();
  peer.payload({
    FunctionBatchFinished: { response_id: 'ordinary-MCP', target: null },
  });
  await peer.owner.sendText('Keep listening after the ordinary result.');
  expect(peer.session._realtimeProfileTarget).not.toHaveBeenCalled();
  expect(
    peer.call.mock.calls.some(
      ([operation]) => operation === 'realtime_conversation_update_sdk',
    ),
  ).toBe(false);
  await peer.owner.close();
});

it('keeps complete input calls ordered and commits each audio call only after its final bounded frame', async () => {
  const peer = fixture();
  await peer.owner._start();
  const entered = deferred<void>();
  const release = deferred<void>();
  const base = peer.call.getMockImplementation()!;
  let held = false;
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_audio_sdk' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return base(operation, params);
  });
  const first = peer.owner.sendAudio(new Int16Array(40000).fill(1), {
    commit: true,
  });
  await entered.promise;
  const text = peer.owner.sendText('between audio calls');
  const second = peer.owner.sendAudio(new Int16Array([2]), { commit: true });
  const inputCalls = () =>
    peer.call.mock.calls.filter(([op]) =>
      [
        'realtime_conversation_audio_sdk',
        'realtime_conversation_audio_commit_sdk',
        'realtime_conversation_text_sdk',
      ].includes(op),
    );
  expect(inputCalls()).toHaveLength(1);
  release.resolve();
  await Promise.all([first, text, second]);
  expect(inputCalls().map(([op]) => op)).toEqual([
    'realtime_conversation_audio_sdk',
    'realtime_conversation_audio_sdk',
    'realtime_conversation_audio_commit_sdk',
    'realtime_conversation_text_sdk',
    'realtime_conversation_audio_sdk',
    'realtime_conversation_audio_commit_sdk',
  ]);
  expect(
    inputCalls()
      .filter(([op]) => op === 'realtime_conversation_audio_sdk')
      .map(
        ([, params]) =>
          (params.frame as { samples_per_channel: number }).samples_per_channel,
      ),
  ).toEqual([32768, 7232, 1]);
  await peer.owner.close();
});

it.each([null, [], { commit: 'yes' }, { commit: 1 }])(
  'rejects invalid audio commit options before any native input: %j',
  async (options) => {
    const peer = fixture();
    await peer.owner._start();
    const before = peer.call.mock.calls.length;
    await expect(
      peer.owner.sendAudio(new Int16Array([1]), options as never),
    ).rejects.toThrow();
    expect(peer.call).toHaveBeenCalledTimes(before);
    await peer.owner.close();
  },
);

it('never commits a failed append and lets a later input call complete', async () => {
  const peer = fixture();
  await peer.owner._start();
  const failure = new Error('append rejected');
  peer.call.mockRejectedValueOnce(failure);
  await expect(
    peer.owner.sendAudio(new Int16Array([1]), { commit: true }),
  ).rejects.toBe(failure);
  expect(
    peer.call.mock.calls.filter(
      ([op]) => op === 'realtime_conversation_audio_commit_sdk',
    ),
  ).toHaveLength(0);
  await peer.owner.sendAudio(new Int16Array([2]), { commit: true });
  expect(
    peer.call.mock.calls.filter(
      ([op]) => op === 'realtime_conversation_audio_commit_sdk',
    ),
  ).toHaveLength(1);
  await peer.owner.close();
});

it('keeps append-only default behavior and does not commit explicit false', async () => {
  const peer = fixture();
  await peer.owner._start();
  await peer.owner.sendAudio(new Int16Array([1]));
  await peer.owner.sendAudio(new Int16Array([2]), { commit: false });
  expect(
    peer.call.mock.calls.filter(
      ([op]) => op === 'realtime_conversation_audio_sdk',
    ),
  ).toHaveLength(2);
  expect(
    peer.call.mock.calls.filter(
      ([op]) => op === 'realtime_conversation_audio_commit_sdk',
    ),
  ).toHaveLength(0);
  await peer.owner.close();
});

it('captures ordered user content and response options before queued admission', async () => {
  const peer = fixture();
  await peer.owner._start();
  const release = deferred<void>();
  const entered = deferred<void>();
  const base = peer.call.getMockImplementation()!;
  let held = false;
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_audio_sdk' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return base(operation, params);
  });
  const audio = peer.owner.sendAudio(new Int16Array([0]), { commit: true });
  await entered.promise;
  const content = [
    { type: 'input_text' as const, text: 'original text' },
    {
      type: 'input_image' as const,
      image: 'data:image/png;base64,aW1hZ2U=',
      detail: 'low' as const,
    },
  ];
  const options = { triggerResponse: false };
  const message = peer.owner.sendMessage(
    { type: 'message', role: 'user', content },
    options,
  );
  content[0].text = 'mutated text';
  content[1].image = 'https://example.com/mutated.png';
  options.triggerResponse = true;
  const response = peer.owner.requestResponse();
  release.resolve();
  await Promise.all([audio, message, response]);
  expect(
    peer.call.mock.calls.filter(([op]) =>
      [
        'realtime_conversation_input_sdk',
        'realtime_conversation_response_sdk',
      ].includes(op),
    ),
  ).toEqual([
    [
      'realtime_conversation_input_sdk',
      {
        generation: peer.generation,
        trigger_response: false,
        content: [
          { type: 'input_text', text: 'original text' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,aW1hZ2U=',
            detail: 'low',
          },
        ],
      },
    ],
    ['realtime_conversation_response_sdk', { generation: peer.generation }],
  ]);
  await peer.owner.addImage('data:image/png;base64,aW1hZ2U=');
  expect(peer.call.mock.calls.at(-1)?.[1]).toMatchObject({
    trigger_response: true,
  });
  await peer.owner.close();
});

it.each([
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'input_text', text: 'forged' }],
  },
  {
    type: 'message',
    role: 'user',
    content: [{ type: 'function_call_output', output: 'forged' }],
  },
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'valid' },
      { type: 'input_image', file_id: 'file-id' },
    ],
  },
  {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_image',
        image: 'data:image/png;base64,aW1hZ2U=',
        detail: 'original',
      },
    ],
  },
  {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_image',
        image: 'data:image/png;base64,aW1hZ2U=',
        providerData: { type: 'function_call_output' },
      },
    ],
  },
])(
  'rejects unsupported structured input before native effects: %j',
  async (message) => {
    const peer = fixture();
    await peer.owner._start();
    const before = peer.call.mock.calls.length;
    await expect(peer.owner.sendMessage(message as never)).rejects.toThrow();
    expect(peer.call).toHaveBeenCalledTimes(before);
    await expect(
      peer.owner.sendMessage('valid', { triggerResponse: 'yes' } as never),
    ).rejects.toThrow();
    expect(peer.call).toHaveBeenCalledTimes(before);
    await peer.owner.close();
  },
);

it('waits for native deletion receipt and exposes provider IDs without erasing canonical audit', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({
    HistoryItemCompleted: {
      id: 'audit-original',
      realtime_session_id: 'session',
      type: 'user_message',
      text: 'kept audit',
    },
  });
  await events.next();
  peer.payload({
    ConversationItemObserved: {
      item_id: 'provider-item',
      kind: 'message',
      status: 'done',
      role: 'user',
      call_id: null,
    },
  });
  expect((await events.next()).value).toMatchObject({
    type: 'conversation_item',
    itemId: 'provider-item',
    kind: 'message',
    status: 'done',
    role: 'user',
  });
  const receipt = deferred<void>();
  const base = peer.call.getMockImplementation()!;
  peer.call.mockImplementation(async (operation, params) => {
    if (operation === 'realtime_conversation_delete_item_sdk')
      await receipt.promise;
    else return base(operation, params);
  });
  let finished = false;
  const deleting = peer.owner
    .deleteConversationItem('provider-item')
    .then(() => {
      finished = true;
    });
  expect(peer.call.mock.calls.at(-1)).toEqual([
    'realtime_conversation_delete_item_sdk',
    { generation: peer.generation, item_id: 'provider-item' },
  ]);
  expect(finished).toBe(false);
  expect(peer.owner.history.map((item) => item.id)).toEqual(['audit-original']);
  peer.payload({
    HistoryItemCompleted: {
      id: 'audit-delete',
      realtime_session_id: 'session',
      type: 'provider_item_deleted',
      provider_item_id: 'provider-item',
    },
  });
  expect((await events.next()).value).toMatchObject({
    type: 'history',
    item: { kind: 'provider_item_deleted', providerItemId: 'provider-item' },
  });
  peer.payload({ ConversationItemDeleted: { item_id: 'provider-item' } });
  expect((await events.next()).value).toEqual({
    type: 'conversation_item_deleted',
    itemId: 'provider-item',
  });
  receipt.resolve();
  await deleting;
  expect(peer.owner.history).toHaveLength(2);
  expect(peer.owner.history[0].text).toBe('kept audit');
  await peer.owner.close();
  await events.return(undefined);
});

it.each(['', '   ', null, 1])(
  'rejects invalid provider deletion ID before native effects: %j',
  async (id) => {
    const peer = fixture();
    await peer.owner._start();
    const before = peer.call.mock.calls.length;
    await expect(
      peer.owner.deleteConversationItem(id as never),
    ).rejects.toThrow();
    expect(peer.call).toHaveBeenCalledTimes(before);
    await peer.owner.close();
  },
);

it.each([true, false])(
  'reclaims completed played audio across a long-lived owner (done first: %s)',
  async (doneFirst) => {
    const peer = fixture();
    await peer.owner._start();
    const events = peer.owner.events();
    await events.next();
    try {
      for (let i = 0; i < 1030; i++) {
        const position = {
          responseId: `response-${i}`,
          itemId: `item-${i}`,
          contentIndex: 0,
          audioEndMs: 20,
        };
        peer.payload({
          AudioOut: {
            data: Buffer.alloc(160).toString('base64'),
            sample_rate: 8000,
            num_channels: 1,
            format: 'g711_ulaw',
            response_id: position.responseId,
            item_id: position.itemId,
            content_index: 0,
          },
        });
        expect((await events.next()).value).toMatchObject({
          type: 'audio',
          responseId: position.responseId,
        });
        if (!doneFirst) peer.owner.reportPlayback(position);
        peer.payload({
          ResponseDone: {
            response_id: position.responseId,
            function_call_ids: [],
          },
        });
        expect((await events.next()).value).toMatchObject({
          type: 'response',
          status: 'done',
        });
        if (doneFirst) peer.owner.reportPlayback(position);
      }
      await peer.owner.sendText('still live');
    } finally {
      await peer.owner.close();
    }
  },
);
function receivedPlayback(responseId: string) {
  return {
    responseId,
    itemId: `item-${responseId}`,
    contentIndex: 0,
    sampleRate: 8000,
    channels: 1,
    format: 'g711_ulaw' as const,
    data: new Uint8Array(160),
  };
}
function playedPlayback(responseId: string, audioEndMs = 20) {
  return {
    responseId,
    itemId: `item-${responseId}`,
    contentIndex: 0,
    audioEndMs,
  };
}
it('retains delayed playback and streaming audio while reclaiming only eligible completed content', () => {
  const playback = new NativeRealtimePlayback(2);
  playback.observe(receivedPlayback('delayed'));
  playback.complete('delayed');
  playback.observe(receivedPlayback('streaming'));
  playback.report(playedPlayback('streaming'));
  expect(() => playback.observe(receivedPlayback('next'))).toThrow('capacity');
  playback.report(playedPlayback('delayed', 10));
  expect(() => playback.report(playedPlayback('delayed', 9))).toThrow(
    'backwards',
  );
  expect(() => playback.observe(receivedPlayback('next'))).toThrow('capacity');
  playback.report(playedPlayback('delayed'));
  playback.observe(receivedPlayback('next'));
  expect(() => playback.report(playedPlayback('delayed'))).toThrow('identify');
  playback.observe(receivedPlayback('streaming'));
  expect(() => playback.report(playedPlayback('streaming', 41))).toThrow(
    'exceeds',
  );
  playback.report(playedPlayback('streaming', 40));
});
it('reclaims only authoritatively retired playback sources even when unplayed', () => {
  const playback = new NativeRealtimePlayback(2);
  playback.observe(receivedPlayback('retired'));
  playback.observe(receivedPlayback('live'));
  playback.retire(new Set(['retired']));
  playback.report(playedPlayback('retired', 10));
  playback.observe(receivedPlayback('next'));
  expect(() => playback.report(playedPlayback('retired'))).toThrow('identify');
  playback.report(playedPlayback('live', 10));
  expect(() => playback.observe(receivedPlayback('overflow'))).toThrow(
    'capacity',
  );
});

it('reclaims unplayed owner audio only after the exact native retirement receipt', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  try {
    for (let i = 0; i < 1024; i++) {
      peer.payload({
        AudioOut: {
          data: Buffer.alloc(160).toString('base64'),
          sample_rate: 8000,
          num_channels: 1,
          format: 'g711_ulaw',
          response_id: 'retired-source',
          item_id: `item-${i}`,
          content_index: 0,
        },
      });
      expect((await events.next()).value).toMatchObject({ type: 'audio' });
    }
    await peer.owner.interrupt('retired-source');
    expect((await events.next()).value).toMatchObject({
      type: 'playback_interrupted',
      retiredResponseIds: ['retired-source'],
    });
    const position = {
      responseId: 'retired-source',
      itemId: 'item-0',
      contentIndex: 0,
      audioEndMs: 10,
    };
    peer.owner.reportPlayback(position);
    peer.payload({
      AudioOut: {
        data: Buffer.alloc(160).toString('base64'),
        sample_rate: 8000,
        num_channels: 1,
        format: 'g711_ulaw',
        response_id: 'live-source',
        item_id: 'live-item',
        content_index: 0,
      },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'audio',
      responseId: 'live-source',
    });
    expect(() => peer.owner.reportPlayback(position)).toThrow('identify');
  } finally {
    await peer.owner.close();
  }
});

it('reclaims completed request IDs without forgetting live functions', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({ FunctionCallRequested: { call_id: 'live', name: 'held' } });
  try {
    for (let i = 0; i < 1030; i++) {
      const id = `completed-${i}`;
      peer.payload({ FunctionCallRequested: { call_id: id, name: 'tool' } });
      peer.payload({ FunctionCallFinished: { call_id: id, succeeded: true } });
      expect((await events.next()).value).toMatchObject({
        type: 'function_call',
        callId: id,
        status: 'completed',
      });
      // Recent terminal duplicates must not replace live records or execute again.
      peer.payload({
        FunctionCallRequested: { call_id: id, name: 'duplicate' },
      });
      peer.payload({ FunctionCallFinished: { call_id: id, succeeded: true } });
    }
    peer.payload({
      FunctionCallRequested: { call_id: 'live', name: 'duplicate' },
    });
    peer.payload({
      FunctionCallFinished: { call_id: 'live', succeeded: true },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'function_call',
      callId: 'live',
      name: 'held',
      status: 'completed',
    });
    await peer.owner.sendText('still live');
  } finally {
    await peer.owner.close();
  }
});

it('reclaims completed handoff IDs without forgetting live delegations', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload(
    { HandoffRequested: { handoff_id: 'live-handoff' } },
    'held input',
  );
  await events.next();
  await vi.waitFor(() => expect(peer.waits).toHaveLength(1));
  const original = peer.session.submit.getMockImplementation()!;
  peer.session.submit.mockImplementation(async (input) => {
    const turn = await original(input);
    peer.waits.at(-1)!.resolve({ finalOutput: 'accepted' });
    return turn;
  });
  try {
    for (let i = 0; i < 1030; i++) {
      const id = `handoff-${i}`;
      peer.payload({ HandoffRequested: { handoff_id: id } }, 'prepared input');
      expect((await events.next()).value).toMatchObject({
        type: 'delegation',
        status: 'started',
        handoffId: id,
      });
      expect((await events.next()).value).toMatchObject({
        type: 'delegation',
        status: 'completed',
        handoffId: id,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      peer.payload({ HandoffRequested: { handoff_id: id } }, 'duplicate input');
    }
    peer.payload(
      { HandoffRequested: { handoff_id: 'live-handoff' } },
      'duplicate live input',
    );
    expect(peer.inputs).toHaveLength(1031);
    expect(peer.inputs).not.toContain('duplicate input');
    expect(peer.inputs).not.toContain('duplicate live input');
    await peer.owner.sendText('still live');
  } finally {
    await peer.owner.close();
  }
});

it.each(['rejected', 'malformed'] as const)(
  'closes the owner after an uncertain explicit interruption: %s',
  async (mode) => {
    const peer = fixture();
    await peer.owner._start();
    peer.payload({ ResponseCreated: { response_id: 'active' } });
    const original = peer.call.getMockImplementation()!;
    const failure = new Error('interruption rejected');
    peer.call.mockImplementation((operation, params) => {
      if (operation === 'realtime_conversation_interrupt_sdk')
        return mode === 'rejected'
          ? Promise.reject(failure)
          : Promise.resolve({});
      return original(operation, params);
    });
    await expect(peer.owner.interrupt('active')).rejects.toThrow(
      mode === 'rejected'
        ? 'interruption rejected'
        : 'authoritative effect receipt',
    );
    await expect(peer.owner.sendText('cannot continue')).rejects.toThrow();
    await expect(peer.owner.events().next()).rejects.toThrow(
      mode === 'rejected'
        ? 'interruption rejected'
        : 'authoritative effect receipt',
    );
    await peer.owner.close();
    expect(peer.session.close).not.toHaveBeenCalled();
    expect(peer.release).toHaveBeenCalledOnce();
  },
);

it('bounds response retirement history without forgetting still-owned retired work', async () => {
  const peer = fixture();
  await peer.owner._start();
  const events = peer.owner.events();
  await events.next();
  peer.payload({
    FunctionCallRequested: {
      call_id: 'held',
      name: 'tool',
      response_id: 'held-response',
    },
  });
  await peer.owner.interrupt('held-response');
  await events.next();
  try {
    for (let i = 0; i < 1030; i++) {
      const responseId = `interrupted-${i}`;
      peer.payload({ ResponseCreated: { response_id: responseId } });
      await events.next();
      await peer.owner.interrupt(responseId);
      expect((await events.next()).value).toMatchObject({
        type: 'playback_interrupted',
        retiredResponseIds: [responseId],
      });
    }
    peer.payload({
      AudioOut: {
        response_id: 'held-response',
        item_id: 'held-audio',
        content_index: 0,
        data: Buffer.alloc(160).toString('base64'),
        sample_rate: 8000,
        num_channels: 1,
        format: 'g711_ulaw',
      },
    });
    peer.payload({ ResponseCreated: { response_id: 'next-live' } });
    expect((await events.next()).value).toMatchObject({
      type: 'response',
      responseId: 'next-live',
      status: 'created',
    });
    await peer.owner.sendText('still live');
  } finally {
    await peer.owner.close();
  }
});
