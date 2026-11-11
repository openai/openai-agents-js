import { expect, it, vi } from 'vitest';
import { VoiceConversationHistory } from '../src/voice/conversation-history';
import { VoiceEventObservers } from '../src/voice/event-observers';
import {
  createNativeRealtimeOwner,
  type NativeRealtimeOptions,
} from '../src/runtime/realtime';
import type { Session } from '../src/runtime/session';

const message = (id: string, text: string) => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_audio', transcript: text }],
});

it('retains provider input and output audio only with opt-in across item updates', () => {
  for (const storeAudio of [false, true]) {
    const history = new VoiceConversationHistory({ storeAudio });
    const input = {
      ...message('input', ''),
      role: 'user',
      content: [{ type: 'input_audio', audio: 'AQIDBA==' }],
    };
    history.observe({ type: 'conversation.item.retrieved', item: input });
    history.observe({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input',
      transcript: 'heard',
    });
    history.observe({
      type: 'response.output_item.added',
      item: message('output', ''),
    });
    history.observeAudio('output', 0, new Uint8Array([5, 6]), 2);
    const output = {
      ...message('output', 'spoken'),
      content: [
        { type: 'output_audio', audio: 'BQYHCA==', transcript: 'spoken' },
      ],
    };
    for (let i = 0; i < 2; i++)
      history.observe({
        type: 'response.done',
        response: { output: [output] },
      });
    expect(history.snapshot().map((item) => item.content)).toEqual([
      [
        {
          type: 'input_audio',
          transcript: 'heard',
          ...(storeAudio ? { audio: 'AQIDBA==' } : {}),
        },
      ],
      [
        {
          type: 'output_audio',
          transcript: 'spoken',
          ...(storeAudio ? { audio: 'BQYHCA==' } : {}),
        },
      ],
    ]);
    expect(history.providerSnapshot().map((item) => item.content)).toEqual([
      [{ type: 'input_audio', transcript: 'heard' }],
      [{ type: 'output_audio', transcript: 'spoken' }],
    ]);
    expect(JSON.parse(history.serializeSnapshot())).toEqual(history.snapshot());
    expect(input.content[0].audio).toBe('AQIDBA==');
    if (storeAudio) {
      history.observe({
        type: 'conversation.item.truncated',
        item_id: 'output',
        content_index: 0,
        audio_end_ms: 1,
      });
      expect(history.snapshot()[1].content).toEqual([
        { type: 'output_audio', audio: 'BQY=' },
      ]);
    }
    history.observe({ type: 'conversation.item.deleted', item_id: 'input' });
    history.observe({
      type: 'conversation.item.created',
      item: message('input', 'new'),
    });
    expect((history.snapshot()[1].content as any[])[0].audio).toBeUndefined();
  }
});

it('charges provider audio replacements against the shared audio budget without duplicating deltas', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 4,
  });
  const item = {
    ...message('one', ''),
    content: [{ type: 'output_audio', audio: 'AQIDBA==' }],
  };
  history.observe({ type: 'conversation.item.added', item });
  history.observe({ type: 'conversation.item.done', item });
  history.observe({
    type: 'conversation.item.truncated',
    item_id: 'one',
    content_index: 0,
    audio_end_ms: 0,
  });
  history.observe({ type: 'conversation.item.done', item });
  expect((history.snapshot()[0].content as any[])[0]).toMatchObject({
    audio: 'AQIDBA==',
  });
  history.observeAudio('one', 0, new Uint8Array([5, 6]));
  expect((history.snapshot()[0].content as any[])[0]).toMatchObject({
    audio: 'AQIDBA==',
    audio_truncated: true,
  });
  history.clear();
  history.observe({ type: 'conversation.item.added', item });
  expect((history.snapshot()[0].content as any[])[0]).toEqual({
    type: 'output_audio',
    audio: 'AQIDBA==',
  });
});

it('retains detached audio only with opt-in, keeps a bounded prefix, and truncates played audio', () => {
  const off = new VoiceConversationHistory();
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 4,
  });
  for (const view of [off, history]) {
    view.observe({
      type: 'conversation.item.added',
      item: message('one', 'first'),
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    view.observeAudio('one', 0, bytes, 2);
    bytes[0] = 99;
  }
  expect((off.snapshot()[0].content as any[])[0].audio).toBeUndefined();
  expect((history.snapshot()[0].content as any[])[0].audio).toBe('AQIDBA==');
  history.observeAudio('one', 0, new Uint8Array([5, 6]), 2);
  expect((history.snapshot()[0].content as any[])[0]).toMatchObject({
    audio: 'AQIDBA==',
    audio_truncated: true,
  });
  history.observe({
    type: 'conversation.item.truncated',
    item_id: 'one',
    content_index: 0,
    audio_end_ms: 1,
  });
  expect((history.snapshot()[0].content as any[])[0].audio).toBe('AQI=');
  expect(
    (history.snapshot()[0].content as any[])[0].transcript,
  ).toBeUndefined();
  history.observe({ type: 'conversation.item.deleted', item_id: 'one' });
  expect(history.snapshot()).toEqual([]);
});

it('maintains provider order and transcripts while bounding local item payloads', () => {
  const history = new VoiceConversationHistory({ maxBytes: 2048, maxItems: 2 });
  history.observe({
    type: 'conversation.item.added',
    item: message('last', ''),
  });
  history.observe({
    type: 'conversation.item.added',
    previous_item_id: null,
    item: message('first', ''),
  });
  history.observe({
    type: 'response.output_audio_transcript.done',
    item_id: 'first',
    content_index: 0,
    transcript: 'finished',
  });
  const snapshot = history.snapshot();
  expect(snapshot.map((item) => item.id)).toEqual(['first', 'last']);
  expect((snapshot[0].content as any[])[0].transcript).toBe('finished');
  (snapshot[0].content as any[])[0].transcript = 'changed by caller';
  expect((history.snapshot()[0].content as any[])[0].transcript).toBe(
    'finished',
  );
  expect(() =>
    history.observe({
      type: 'conversation.item.added',
      item: message('third', ''),
    }),
  ).toThrow('capacity');
});

it('replaces provider audio with an empty value and releases its byte budget', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 4,
  });
  const item = {
    ...message('one', ''),
    content: [{ type: 'output_audio', audio: 'AQIDBA==' }],
  };
  history.observe({ type: 'conversation.item.created', item });
  history.observeAudio('one', 0, new Uint8Array());
  expect((history.snapshot()[0].content as any[])[0].audio).toBe('AQIDBA==');
  history.observe({
    type: 'conversation.item.done',
    item: { ...item, content: [{ type: 'output_audio', audio: '' }] },
  });
  expect((history.snapshot()[0].content as any[])[0].audio).toBe('');
  history.observe({
    type: 'conversation.item.created',
    item: { ...item, id: 'two' },
  });
  expect((history.snapshot()[1].content as any[])[0].audio).toBe('AQIDBA==');
});

it('isolates passive observers, detaches byte views, and releases subscriptions', async () => {
  type Event = { type: string; data: Uint8Array; detail: { text: string } };
  const observers = new VoiceEventObservers<Event>();
  const second = vi.fn();
  observers.on('audio', (event) => {
    event.data[0] = 99;
    event.detail.text = 'changed';
    throw new Error('observer');
  });
  observers.on('audio', () => Promise.reject(new Error('async observer')));
  const unsubscribe = observers.on('event', second);
  const original = {
    type: 'audio',
    data: Buffer.from([1]),
    detail: { text: 'original' },
  };
  observers.emit(original);
  expect(second).toHaveBeenCalledWith({
    type: 'audio',
    data: new Uint8Array([1]),
    detail: { text: 'original' },
  });
  expect(original.data[0]).toBe(1);
  unsubscribe();
  observers.emit(original);
  expect(second).toHaveBeenCalledTimes(1);
  observers.close();
  expect(() => observers.on('audio', second)).toThrow('closed');
  await Promise.resolve();
});

async function ownerFixture(options: NativeRealtimeOptions = {}) {
  let generation = '';
  const session = {
    _checkVoiceOperation() {},
    _checkVoiceAdapterOperation() {},
    _prepareRealtimeMcp: async () => {},
    _runVoiceCallback: (callback: () => unknown) => callback(),
    _realtimeGuardrailSource: () => ({ agent: {}, context: {} }),
  } as unknown as Session;
  const native = vi.fn(
    async (operation: string, params: Record<string, any>) => {
      generation = params.generation;
      if (operation.endsWith('_prepare_sdk')) return { generation };
      if (operation.endsWith('_activate_sdk'))
        owner._ingest({
          id: generation,
          msg: { type: 'realtime_conversation_started' },
        } as never);
      if (operation.endsWith('_interrupt_sdk'))
        return {
          retired_response_ids: ['response'],
          cancelled_response_id: 'response',
        };
      if (operation.endsWith('_close_sdk'))
        owner._ingest({
          id: generation,
          msg: { type: 'realtime_conversation_closed' },
        } as never);
      return null;
    },
  );
  const owner = createNativeRealtimeOwner(
    session,
    native as never,
    () => {},
    options,
    async () => {},
  );
  await owner._start();
  return {
    owner,
    native,
    source: (call: string) => ({
      generation,
      provider_call_id: call,
      provider_item_id: 'call-item',
      provider_response_id: 'response',
    }),
    emit: (payload: Record<string, unknown>) =>
      owner._ingest({
        id: generation,
        msg: {
          type: 'realtime_conversation_realtime',
          payload:
            'RawProviderEvent' in payload
              ? {
                  RawProviderEvent: {
                    event: payload.RawProviderEvent,
                    history_observation: true,
                  },
                }
              : payload,
        },
      } as never),
  };
}

it('keeps opt-in provider audio readable after close independently of observers and pull consumption', async () => {
  const { owner, emit } = await ownerFixture({ historyStoreAudio: true });
  const listener = vi.fn();
  owner.on('audio', (event) => {
    event.data.fill(99);
  });
  owner.on('audio', listener);
  emit({
    RawProviderEvent: {
      type: 'conversation.item.added',
      item: message('audio-item', 'spoken'),
    },
  });
  emit({
    AudioOut: {
      data: 'AQIDBA==',
      sample_rate: 24000,
      num_channels: 1,
      item_id: 'audio-item',
      response_id: 'response',
      content_index: 0,
      output_index: 0,
      format: 'pcm16',
    },
  });
  expect(listener.mock.calls[0][0].data).toEqual(new Uint8Array([1, 2, 3, 4]));
  const closing = owner.close();
  emit({
    RawProviderEvent: {
      type: 'response.output_audio_transcript.done',
      item_id: 'audio-item',
      content_index: 0,
      transcript: 'spoken at close',
    },
  });
  await closing;
  expect((owner.providerHistory()[0].content as any[])[0]).toMatchObject({
    audio: 'AQIDBA==',
    transcript: 'spoken at close',
  });
  expect(() => owner.on('event', () => {})).toThrow('closed');
});

it('keeps exact provider input and output audio in the Node owner after close', async () => {
  for (const historyStoreAudio of [false, true]) {
    const { owner, emit } = await ownerFixture({ historyStoreAudio });
    const input = {
      ...message('input', 'heard'),
      role: 'user',
      content: [
        { type: 'input_audio', audio: 'AQIDBA==', transcript: 'heard' },
      ],
    };
    const output = {
      ...message('output', 'spoken'),
      content: [
        { type: 'output_audio', audio: 'BQYHCA==', transcript: 'spoken' },
      ],
    };
    emit({
      RawProviderEvent: { type: 'conversation.item.retrieved', item: input },
    });
    emit({
      RawProviderEvent: { type: 'response.output_item.done', item: output },
    });
    const expected = [input, output].map((item) => ({
      ...item,
      content: item.content.map(({ audio, ...part }) => ({
        ...part,
        ...(historyStoreAudio ? { audio } : {}),
      })),
    }));
    expect(owner.providerHistory()).toEqual(expected);
    await owner.close();
    expect(owner.providerHistory()).toEqual(expected);
    (owner.providerHistory()[0].content as any[])[0].audio = 'changed';
    expect(owner.providerHistory()).toEqual(expected);
  }
});

it('clears prior provider bytes on an empty same-item audio update in the Node owner', async () => {
  const { owner, emit } = await ownerFixture({ historyStoreAudio: true });
  const item = {
    ...message('one', ''),
    content: [{ type: 'output_audio', audio: 'AQIDBA==' }],
  };
  emit({ RawProviderEvent: { type: 'conversation.item.created', item } });
  emit({
    RawProviderEvent: {
      type: 'conversation.item.done',
      item: { ...item, content: [{ type: 'output_audio', audio: '' }] },
    },
  });
  expect((owner.providerHistory()[0].content as any[])[0].audio).toBe('');
  await owner.close();
  expect((owner.providerHistory()[0].content as any[])[0].audio).toBe('');
});

it('captures exact tool-source history before later input and isolates each callback view', async () => {
  const { owner, emit, source } = await ownerFixture();
  emit({
    RawProviderEvent: {
      type: 'conversation.item.added',
      item: message('source', 'at call time'),
    },
  });
  emit({
    FunctionCallRequested: {
      call_id: 'call',
      item_id: 'call-item',
      name: 'lookup',
      arguments: '{}',
      response_id: 'response',
    },
  });
  emit({
    RawProviderEvent: {
      type: 'conversation.item.added',
      item: message('later', 'after call'),
    },
  });
  const application = { account: 'original' };
  const beforeApproval = owner._realtimeToolContext(
    source('call'),
    application,
  );
  expect(beforeApproval.history!.map((item) => item.id)).toEqual(['source']);
  expect(beforeApproval.context.account).toBe('original');
  expect(application).toEqual({ account: 'original' });
  (beforeApproval.history![0] as Record<string, unknown>).id = 'mutated';
  const execution = owner._realtimeToolContext(source('call'), application);
  expect(execution.history!.map((item) => item.id)).toEqual(['source']);
  expect(owner._realtimeToolContext(source('unknown'), application)).toEqual({
    context: application,
  });
  for (const mismatch of [
    { ...source('call'), generation: 'old' },
    { ...source('call'), provider_item_id: 'other' },
    { ...source('call'), provider_response_id: 'other' },
  ])
    expect(owner._realtimeToolContext(mismatch, application)).toEqual({
      context: application,
    });
  expect(owner._realtimeToolContext(source('call'), 42).context).toBe(42);
  emit({ FunctionCallFinished: { call_id: 'call', succeeded: true } });
  expect(owner._realtimeToolContext(source('call'), application)).toEqual({
    context: application,
  });
  await owner.close();
});

it('cleans observer subscriptions and the pending pull buffer during observer-triggered close', async () => {
  const { owner, emit } = await ownerFixture();
  owner.on('audio', () => owner.close());
  emit({
    AudioOut: {
      data: 'AQI=',
      sample_rate: 24000,
      num_channels: 1,
      item_id: 'audio',
      response_id: 'response',
      content_index: 0,
      output_index: 0,
      format: 'pcm16',
    },
  });
  await owner.close();
  const events = owner.events();
  expect((await events.next()).value).toEqual({
    type: 'lifecycle',
    status: 'closed',
  });
  expect(await events.next()).toEqual({ done: true, value: undefined });
  expect(() => owner.on('event', () => {})).toThrow('closed');
});

it('keeps listener-only use alive with a bounded rolling backlog until the first pull', async () => {
  const { owner, emit } = await ownerFixture();
  const seen = vi.fn();
  owner.on('audio', seen);
  const frame = (index: number) => ({
    AudioOut: {
      data: Buffer.from([index % 256, 0]).toString('base64'),
      sample_rate: 24000,
      num_channels: 1,
      item_id: 'audio',
      response_id: 'response',
      content_index: 0,
      output_index: 0,
      format: 'pcm16',
    },
  });
  for (let i = 0; i < 300; i++) emit(frame(i));
  expect(seen).toHaveBeenCalledTimes(300);
  const events = owner.events();
  for (let i = 172; i < 300; i++) {
    expect((await events.next()).value).toMatchObject({
      type: 'audio',
      data: new Uint8Array([i % 256, 0]),
    });
  }
  // Acquiring and then releasing the pull path permanently restores strict ownership.
  await events.return(undefined);
  for (let i = 0; i < 129; i++) emit(frame(i));
  await expect(owner.events().next()).rejects.toThrow('buffer overflow');
  await owner.close();
});

it('preserves queued detached audio during unqualified interruption', async () => {
  const { owner, emit } = await ownerFixture();
  const audio = (response: string) => ({
    AudioOut: {
      data: 'AQI=',
      sample_rate: 24000,
      num_channels: 1,
      item_id: 'audio',
      response_id: response,
      content_index: 0,
      output_index: 0,
      format: 'pcm16',
    },
  });
  emit(audio('response'));
  emit({ DetachedResponse: audio('detached') });
  await owner.interrupt();
  const events = owner.events();
  let event = (await events.next()).value;
  while (event?.type !== 'audio') event = (await events.next()).value;
  expect(event).toMatchObject({ responseId: 'detached', outOfBand: true });
  await events.return(undefined);
  await owner.close();
});
