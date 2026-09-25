import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIRealtimeWebSocket,
  RealtimeSession,
  type OpenAIRealtimeWebSocketOptions,
} from '@openai/agents-realtime';
import { createVoiceAgent, voiceAgentConfiguration } from '../src/server/agent';
import {
  connectSidebandAndWaitForReady,
  type SidebandSession,
} from '../src/server/sidebandReady';

function createSession() {
  const listeners = new Set<(event: unknown) => void>();
  const session: SidebandSession = {
    connect: vi.fn(async () => {}),
    on: vi.fn((_event, listener) => listeners.add(listener)),
    off: vi.fn((_event, listener) => listeners.delete(listener)),
  };
  return {
    emit(event: unknown) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    listeners,
    session,
  };
}

describe('connectSidebandAndWaitForReady', () => {
  it('waits beyond the real SDK tracing acknowledgement for the agent configuration', async () => {
    type Socket = Awaited<
      ReturnType<NonNullable<OpenAIRealtimeWebSocketOptions['createWebSocket']>>
    >;
    const sent: Array<{ type: string; session: Record<string, unknown> }> = [];
    const socket = Object.assign(new EventTarget(), {
      send(data: string) {
        sent.push(JSON.parse(data));
      },
      close() {
        socket.dispatchEvent(new Event('close'));
      },
    });
    const emit = (event: unknown) =>
      socket.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(event) }),
      );
    const transport = new OpenAIRealtimeWebSocket({
      createWebSocket: async () => socket as unknown as Socket,
    });
    const session = new RealtimeSession(createVoiceAgent(), {
      transport,
      context: { ownerId: 'owner-1' },
    });
    session.on('error', () => {});
    let ready = false;
    const connecting = connectSidebandAndWaitForReady(session, {
      apiKey: 'test-key',
      callId: 'rtc_test',
    }).then(() => {
      ready = true;
    });
    try {
      await vi.waitFor(() => expect(transport.status).toBe('connecting'));
      socket.dispatchEvent(new Event('open'));
      emit({
        type: 'session.created',
        event_id: 'created',
        session: { tracing: null },
      });
      await vi.waitFor(() =>
        expect(sent.some((event) => event.session.instructions)).toBe(true),
      );
      expect(sent[0]?.session).not.toHaveProperty('instructions');
      emit({
        type: 'session.updated',
        event_id: 'tracing-ack',
        session: {
          tracing: 'auto',
          instructions: 'Provider default',
          tools: [],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ready).toBe(false);

      const configuration = sent.find(
        (event) => event.session.instructions,
      )!.session;
      emit({
        type: 'session.updated',
        event_id: 'agent-ack',
        session: configuration,
      });
      await connecting;
      expect(ready).toBe(true);
    } finally {
      session.close();
    }
  });

  it('does not resolve until the initial session.updated acknowledgement', async () => {
    const harness = createSession();
    let resolved = false;
    const connecting = connectSidebandAndWaitForReady(harness.session, {
      apiKey: 'server-key',
      callId: 'rtc_test',
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(harness.session.connect).toHaveBeenCalledWith({
      apiKey: 'server-key',
      callId: 'rtc_test',
    });

    harness.emit({
      type: 'session.updated',
      session: {
        instructions: voiceAgentConfiguration.instructions,
        tools: [],
      },
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    harness.emit({
      type: 'session.updated',
      session: {
        instructions: voiceAgentConfiguration.instructions,
        tools: [{ type: 'function', name: 'get_server_time' }],
      },
    });
    await connecting;
    expect(resolved).toBe(true);
    expect(harness.listeners.size).toBe(0);
  });

  it('times out and removes the temporary listener', async () => {
    vi.useFakeTimers();
    try {
      const harness = createSession();
      const connecting = connectSidebandAndWaitForReady(harness.session, {
        apiKey: 'server-key',
        callId: 'rtc_test',
        timeoutMs: 10,
      });
      const rejection = expect(connecting).rejects.toThrow('Timed out');

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(harness.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
