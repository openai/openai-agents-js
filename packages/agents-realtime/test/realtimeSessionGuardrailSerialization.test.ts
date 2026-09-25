import { once } from 'node:events';
import { Usage } from '@openai/agents-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as guardrailModule from '../src/guardrail';
import { RealtimeAgent } from '../src/realtimeAgent';
import { RealtimeSession } from '../src/realtimeSession';
import { FakeTransport, fakeModelMessage } from './stubs';

async function waitForEvent<T extends unknown[]>(
  emitter: object,
  eventName: string,
): Promise<T> {
  return (await once(emitter as any, eventName)) as T;
}

describe('RealtimeSession guardrail outputInfo serialization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      'circular outputInfo',
      () => {
        const value: Record<string, unknown> = { reason: 'blocked' };
        value.self = value;
        return value;
      },
    ],
    ['BigInt outputInfo', () => 42n],
  ])('preserves guardrail recovery for %s', async (_name, makeOutputInfo) => {
    const outputInfo = makeOutputInfo();
    const runMock = vi.fn(async () => ({
      guardrail: { name: 'test', version: '1', policyHint: 'bad' },
      output: { tripwireTriggered: true, outputInfo },
    }));
    vi.spyOn(
      guardrailModule,
      'defineRealtimeOutputGuardrail',
    ).mockReturnValue({ run: runMock } as any);

    const transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    const session = new RealtimeSession(agent, {
      transport,
      outputGuardrails: [
        { name: 'test', execute: async () => ({}) } as any,
      ],
      outputGuardrailSettings: { debounceTextLength: -1 },
    });
    await session.connect({ apiKey: 'test' });

    const guardrailTripped = waitForEvent<any[]>(
      session,
      'guardrail_tripped',
    );
    transport.emit('turn_done', {
      response: {
        output: [fakeModelMessage('bad output')],
        usage: new Usage(),
      },
    } as any);

    const [, , error, details] = await guardrailTripped;
    expect(error.message).toContain('Output guardrail triggered:');
    expect(transport.interruptCalls).toBe(1);
    expect(transport.sendMessageCalls.at(-1)?.[0]).toContain('blocked');
    expect(details).toEqual({ itemId: '123' });
    session.close();
  });
});
