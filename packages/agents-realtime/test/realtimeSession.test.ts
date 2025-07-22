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
});
