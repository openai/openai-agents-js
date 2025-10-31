import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeSession } from '../src/realtimeSession';
import { RealtimeAgent } from '../src/realtimeAgent';
import type { RealtimeItem } from '../src/items';
import { FakeTransport, TEST_TOOL, fakeModelMessage } from './stubs';
import * as guardrailModule from '../src/guardrail';
import {
  Usage,
  ModelBehaviorError,
  RunToolApprovalItem,
} from '@openai/agents-core';
import * as utils from '../src/utils';
import type { TransportToolCallEvent } from '../src/transportLayerEvents';
import {
  DEFAULT_OPENAI_REALTIME_SESSION_CONFIG,
  OpenAIRealtimeBase,
} from '../src/openaiRealtimeBase';
import { toNewSessionConfig } from '../src/clientMessages';

function createMessage(id: string, text: string): RealtimeItem {
  return {
    itemId: id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }],
  } as RealtimeItem;
}

describe('RealtimeSession', () => {
  let transport: FakeTransport;
  let session: RealtimeSession;

  beforeEach(async () => {
    transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    session = new RealtimeSession(agent, { transport });
    await session.connect({ apiKey: 'test' });
  });

  it('calls transport.resetHistory with correct arguments', () => {
    const item = createMessage('1', 'hi');
    session.updateHistory([item]);

    expect(transport.resetHistoryCalls.length).toBe(1);
    const [oldHist, newHist] = transport.resetHistoryCalls[0];
    expect(oldHist).toEqual([]);
    expect(newHist).toEqual([item]);
  });

  it('sets the trace config correctly', async () => {
    transport.connectCalls = [];
    session.options.tracingDisabled = true;
    session.options.workflowName = 'test';
    session.options.groupId = 'test';
    session.options.traceMetadata = { test: 'test' };
    await session.connect({ apiKey: 'test' });
    expect(transport.connectCalls[0]?.initialSessionConfig?.tracing).toEqual(
      null,
    );

    transport.connectCalls = [];
    session.options.tracingDisabled = undefined;
    session.options.workflowName = undefined;
    session.options.groupId = undefined;
    session.options.traceMetadata = undefined;
    await session.connect({ apiKey: 'test' });
    expect(transport.connectCalls[0]?.initialSessionConfig?.tracing).toEqual(
      'auto',
    );
    transport.connectCalls = [];
    session.options.tracingDisabled = undefined;
    session.options.workflowName = 'test';
    session.options.groupId = 'test';
    session.options.traceMetadata = undefined;
    await session.connect({ apiKey: 'test' });
    expect(transport.connectCalls[0]?.initialSessionConfig?.tracing).toEqual({
      workflow_name: 'test',
      group_id: 'test',
    });
  });

  it('updates history and emits history_updated', () => {
    const historyEvents: RealtimeItem[][] = [];
    session.on('history_updated', (h) => {
      historyEvents.push([...h]);
    });
    const historyAdded: RealtimeItem[] = [];
    session.on('history_added', (item) => {
      historyAdded.push(item);
    });

    const item = createMessage('1', 'hi');
    transport.emit('item_update', item);
    expect(session.history).toEqual([item]);
    expect(session['context'].context.history).toEqual(session.history);
    expect(historyEvents[0]).toEqual([item]);
    expect(historyAdded[0]).toEqual(item);

    transport.emit('item_deleted', { itemId: '1' });
    expect(session.history).toEqual([]);
    expect(session['context'].context.history).toEqual(session.history);
    expect(historyEvents[1]).toEqual([]);
  });

  it('delegates simple actions to transport', () => {
    const buf = new TextEncoder().encode('a').buffer;
    session.sendMessage('hi');
    session.mute(true);
    session.sendAudio(buf, { commit: true });
    session.interrupt();
    session.close();

    expect(transport.sendMessageCalls[0]).toEqual(['hi', {}]);
    expect(transport.muteCalls[0]).toBe(true);
    expect(transport.sendAudioCalls.length).toBe(1);
    expect(transport.interruptCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
  });

  it('forwards url in connect options to transport', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test', url: 'ws://example' });
    expect(t.connectCalls[0]?.url).toBe('ws://example');
  });

  it('forwards callId in connect options to transport', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test', callId: 'call_123' });
    expect(t.connectCalls[0]?.callId).toBe('call_123');
  });

  it('includes default transcription config when connecting', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });

    const normalizedConfig = toNewSessionConfig(
      t.connectCalls[0]?.initialSessionConfig ?? {},
    );

    expect(normalizedConfig.audio?.input?.transcription).toEqual(
      DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input?.transcription,
    );
  });

  it('updateHistory accepts callback', () => {
    const item = createMessage('1', 'hi');
    session.updateHistory([item]);
    session.updateHistory((hist) => hist.slice(1));
    const [oldHist, newHist] = transport.resetHistoryCalls[1];
    expect(oldHist).toEqual([]);
    expect(newHist).toEqual([]);
  });

  it('triggers guardrail and emits feedback', async () => {
    const runMock = vi.fn(async () => ({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo: { r: 'bad' } },
    }));
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    session = new RealtimeSession(agent, {
      transport,
      outputGuardrails: [
        {
          name: 'test',
          execute: async () => ({ tripwireTriggered: true }),
        } as any,
      ],
      outputGuardrailSettings: { debounceTextLength: -1 },
    });
    await session.connect({ apiKey: 'test' });

    const guardrailEvents: any[] = [];
    session.on('guardrail_tripped', (...a) => guardrailEvents.push(a));
    transport.emit('turn_done', {
      response: {
        output: [fakeModelMessage('bad output')],
        usage: new Usage(),
      },
    } as any);
    await vi.waitFor(() => expect(guardrailEvents.length).toBe(1));
    expect(transport.interruptCalls).toBe(1);
    expect(transport.sendMessageCalls.at(-1)?.[0]).toContain('blocked');
    expect(guardrailEvents[0][3]).toEqual({ itemId: '123' });
    vi.restoreAllMocks();
  });

  it('resets guardrail debounce per transcript item', async () => {
    const runMock = vi.fn(async () => ({ output: {} }));
    vi.spyOn(guardrailModule, 'defineRealtimeOutputGuardrail').mockReturnValue({
      run: runMock,
    } as any);
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const s = new RealtimeSession(agent, {
      transport: t,
      outputGuardrails: [{ name: 'test', execute: async () => ({}) } as any],
      outputGuardrailSettings: { debounceTextLength: 1 },
    });
    await s.connect({ apiKey: 'test' });
    t.emit('audio_transcript_delta', {
      delta: 'a',
      itemId: '1',
      responseId: 'z',
    } as any);
    t.emit('audio_transcript_delta', {
      delta: 'a',
      itemId: '2',
      responseId: 'z',
    } as any);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  it('emits errors for item update/delete failures', () => {
    const errors: any[] = [];
    session.on('error', (e) => errors.push(e));
    const spy = vi
      .spyOn(utils, 'updateRealtimeHistory')
      .mockImplementation(() => {
        throw new Error('update');
      });
    transport.emit('item_update', createMessage('1', 'hi'));
    expect(errors[0].error).toBeInstanceOf(Error);
    expect(errors[0].error.message).toBe('update');
    spy.mockRestore();

    const origFilter = Array.prototype.filter;
    Array.prototype.filter = () => {
      throw new Error('delete');
    };
    transport.emit('item_deleted', { itemId: '1' } as any);
    expect(errors[1].error.message).toBe('delete');
    Array.prototype.filter = origFilter;
  });

  it('propagates errors from handleFunctionCall', async () => {
    const errors: any[] = [];
    session.on('error', (e) => errors.push(e));
    transport.emit('function_call', {
      type: 'function_call',
      name: 'missing',
      callId: '1',
      arguments: '{}',
    });
    await vi.waitFor(() =>
      expect(errors[0].error).toBeInstanceOf(ModelBehaviorError),
    );
  });

  it('approve and reject work with tool and error without', async () => {
    const agent = new RealtimeAgent({
      name: 'B',
      handoffs: [],
      tools: [TEST_TOOL],
    });
    const t = new FakeTransport();
    const s = new RealtimeSession(agent, { transport: t });
    await s.connect({ apiKey: 'test' });
    const toolCall: TransportToolCallEvent = {
      type: 'function_call',
      name: 'test',
      callId: '1',
      arguments: '{"test":"x"}',
    };
    const approval = new RunToolApprovalItem(toolCall as any, agent);
    await s.approve(approval);
    await s.reject(approval);
    expect(t.sendFunctionCallOutputCalls.length).toBe(2);
    expect(t.sendFunctionCallOutputCalls[0][1]).toBe('Hello World');
    expect(t.sendFunctionCallOutputCalls[1][1]).toBe('Hello World');

    const agent2 = new RealtimeAgent({ name: 'C', handoffs: [] });
    const t2 = new FakeTransport();
    const s2 = new RealtimeSession(agent2, { transport: t2 });
    await s2.connect({ apiKey: 'test' });
    const badApproval = new RunToolApprovalItem(toolCall as any, agent2);
    await expect(s2.approve(badApproval)).rejects.toBeInstanceOf(
      ModelBehaviorError,
    );
    await expect(s2.reject(badApproval)).rejects.toBeInstanceOf(
      ModelBehaviorError,
    );
  });

  it('handles usage and audio interrupted events', () => {
    const usage = new Usage({ totalTokens: 5 });
    transport.emit('usage_update', usage);
    expect(session.usage.totalTokens).toBe(5);

    let audioEvents = 0;
    session.on('audio_interrupted', () => audioEvents++);
    transport.emit('audio_interrupted');
    expect(audioEvents).toBe(1);
  });

  it('emits audio_start when audio begins', () => {
    let startEvents = 0;
    session.on('audio_start', () => startEvents++);
    transport.emit('turn_started', {} as any);
    transport.emit('audio', {
      type: 'audio',
      data: new ArrayBuffer(1),
      responseId: 'r',
    } as any);
    transport.emit('audio', {
      type: 'audio',
      data: new ArrayBuffer(1),
      responseId: 'r',
    } as any);
    expect(startEvents).toBe(1);
    transport.emit('audio_done');
    transport.emit('turn_started', {} as any);
    transport.emit('audio', {
      type: 'audio',
      data: new ArrayBuffer(1),
      responseId: 'r2',
    } as any);
    expect(startEvents).toBe(2);
  });

  it('preserves custom audio formats across updateAgent', async () => {
    const t = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'Orig', handoffs: [] });
    const s = new RealtimeSession(agent, {
      transport: t,
      config: {
        audio: {
          input: { format: 'g711_ulaw' },
          output: { format: 'g711_ulaw' },
        },
      },
    });
    await s.connect({ apiKey: 'test' });
    const newAgent = new RealtimeAgent({ name: 'Next', handoffs: [] });
    await s.updateAgent(newAgent);
    // Find the last updateSessionConfig call
    const last = t.updateSessionConfigCalls.at(-1)!;
    expect((last as any).audio?.input?.format).toBe('g711_ulaw');
    expect((last as any).audio?.output?.format).toBe('g711_ulaw');
  });

  it('defaults item status to completed for done output items without status', async () => {
    class TestTransport extends OpenAIRealtimeBase {
      status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
        'connected';
      connect = vi.fn(async () => {});
      sendEvent = vi.fn();
      mute = vi.fn();
      close = vi.fn();
      interrupt = vi.fn();
      get muted() {
        return false;
      }
    }
    const transport = new TestTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const session = new RealtimeSession(agent, { transport });
    await session.connect({ apiKey: 'test' });
    const historyEvents: RealtimeItem[][] = [];
    session.on('history_updated', (h) => historyEvents.push([...h]));
    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'e',
        item: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi' }],
        },
        output_index: 0,
        response_id: 'r1',
      }),
    });
    const latest = historyEvents.at(-1)!;
    const msg = latest.find(
      (i): i is Extract<RealtimeItem, { type: 'message'; role: 'assistant' }> =>
        i.type === 'message' &&
        i.role === 'assistant' &&
        (i as any).itemId === 'm1',
    );
    expect(msg).toBeDefined();
    expect(msg!.status).toBe('completed');
  });

  it('preserves explicit completed status on done', async () => {
    class TestTransport extends OpenAIRealtimeBase {
      status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
        'connected';
      connect = vi.fn(async () => {});
      sendEvent = vi.fn();
      mute = vi.fn();
      close = vi.fn();
      interrupt = vi.fn();
      get muted() {
        return false;
      }
    }
    const transport = new TestTransport();
    const session = new RealtimeSession(
      new RealtimeAgent({ name: 'A', handoffs: [] }),
      { transport },
    );
    await session.connect({ apiKey: 'test' });

    const historyEvents: RealtimeItem[][] = [];
    session.on('history_updated', (h) => historyEvents.push([...h]));

    (transport as any)._onMessage({
      data: JSON.stringify({
        type: 'response.output_item.done',
        event_id: 'e',
        item: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hi again' }],
        },
        output_index: 0,
        response_id: 'r2',
      }),
    });

    const latest = historyEvents.at(-1)!;
    const msg = latest.find(
      (i): i is Extract<RealtimeItem, { type: 'message'; role: 'assistant' }> =>
        i.type === 'message' &&
        i.role === 'assistant' &&
        (i as any).itemId === 'm2',
    );
    expect(msg).toBeDefined();
    expect(msg!.status).toBe('completed'); // ensure we didn't overwrite server status
  });
});
