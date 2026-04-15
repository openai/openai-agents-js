import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeSIP } from '../src/openaiRealtimeSip';
import { RealtimeAgent } from '../src/realtimeAgent';
import { RealtimeSession } from '../src/realtimeSession';
import { UserError } from '@openai/agents-core';

let lastFakeSocketUrl: string | undefined;
vi.mock('ws', () => {
  return {
    WebSocket: class {
      url: string;
      listeners: Record<string, ((ev: any) => void)[]> = {};
      constructor(url: string) {
        this.url = url;
        lastFakeSocketUrl = url;
        setTimeout(() => this.emit('open', {}));
      }
      addEventListener(type: string, listener: (ev: any) => void) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(listener);
      }
      send(_data: any) {}
      close() {
        this.emit('close', {});
      }
      emit(type: string, ev: any) {
        (this.listeners[type] || []).forEach((fn) => fn(ev));
      }
    },
  };
});

describe('OpenAIRealtimeSIP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires callId on connect', async () => {
    const sip = new OpenAIRealtimeSIP();
    await expect(
      sip.connect({ apiKey: 'ek_test' } as any),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('connects with callId using websocket transport', async () => {
    const sip = new OpenAIRealtimeSIP();
    await sip.connect({ apiKey: 'ek_test', callId: 'call_123' } as any);
    expect(sip.status).toBe('connected');
    expect(lastFakeSocketUrl).toContain('call_123');
  });

  it('buildInitialConfig returns merged session payload', async () => {
    const agent = new RealtimeAgent({ name: 'SIP Agent' });
    const computeSpy = vi
      .spyOn(RealtimeSession, 'computeInitialSessionConfig')
      .mockResolvedValue({
        instructions: 'hi',
        tools: [],
        audio: { output: { voice: 'alloy' } },
      } as any);

    const payload = await OpenAIRealtimeSIP.buildInitialConfig(
      agent,
      {},
      { audio: { output: { voice: 'alloy' } } },
    );

    expect(computeSpy).toHaveBeenCalled();
    expect(payload.instructions).toBe('hi');
    expect(payload.audio?.output?.voice).toBe('alloy');
  });

  it('buildInitialConfig fails fast on unsupported SIP VAD tuning fields', async () => {
    const agent = new RealtimeAgent({ name: 'SIP Agent' });

    await expect(
      OpenAIRealtimeSIP.buildInitialConfig(agent, {
        config: {
          audio: {
            input: {
              turnDetection: {
                type: 'server_vad',
                threshold: 0.4,
                prefixPaddingMs: 150,
                silenceDurationMs: 600,
              },
            },
          },
        },
      }),
    ).rejects.toThrow(
      /threshold, prefixPaddingMs\/prefix_padding_ms, and silenceDurationMs\/silence_duration_ms/,
    );
  });

  it('buildInitialConfig rejects snake_case SIP VAD tuning fields', async () => {
    const agent = new RealtimeAgent({ name: 'SIP Agent' });

    await expect(
      OpenAIRealtimeSIP.buildInitialConfig(agent, {
        config: {
          audio: {
            input: {
              turnDetection: {
                type: 'server_vad',
                prefix_padding_ms: 150,
                silence_duration_ms: 600,
              },
            },
          },
        },
      }),
    ).rejects.toThrow(
      /prefixPaddingMs\/prefix_padding_ms and silenceDurationMs\/silence_duration_ms/,
    );
  });

  it('buildInitialConfig still allows supported SIP turn detection fields', async () => {
    const agent = new RealtimeAgent({ name: 'SIP Agent' });

    const payload = await OpenAIRealtimeSIP.buildInitialConfig(agent, {
      config: {
        audio: {
          input: {
            turnDetection: {
              type: 'server_vad',
              idleTimeoutMs: 900,
              interruptResponse: true,
            },
          },
        },
      },
    });

    expect(payload.audio?.input?.turn_detection).toMatchObject({
      type: 'server_vad',
      idle_timeout_ms: 900,
      interrupt_response: true,
    });
  });

  it('sendAudio is explicitly unsupported', async () => {
    const sip = new OpenAIRealtimeSIP();
    await sip.connect({ apiKey: 'ek_test', callId: 'call_456' } as any);
    expect(() => sip.sendAudio(new ArrayBuffer(0), { commit: true })).toThrow(
      /does not support sending audio buffers/,
    );
  });
});
