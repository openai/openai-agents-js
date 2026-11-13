import { expect, it } from 'vitest';
import { Agent, NativeProvider, type NativeRealtimeUsage } from '../src';
import { ScriptedRealtimeAdapter } from '../src/testing';

function adapterFor(usage?: NativeRealtimeUsage) {
  const done = {
    type: 'response.done',
    response: {
      id: 'reused-across-connections',
      status: 'completed',
      ...(usage === undefined ? {} : { usage }),
    },
  };
  return new ScriptedRealtimeAdapter([
    {
      expect: 'session.update',
      emit: (frame) => [
        {
          type: 'session.updated',
          session: { ...(frame.session as object), id: 'fixture' },
        },
      ],
    },
    { expect: 'conversation.item.create' },
    {
      expect: 'response.create',
      emit: [
        {
          type: 'response.created',
          response: { id: 'reused-across-connections' },
        },
        done,
        done,
      ],
    },
  ]);
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt(
  'retains checked Session speech usage across fresh voice owners',
  async () => {
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      provider,
    }).session();
    expect(session.realtimeLifetimeUsage).toEqual({
      usage: undefined,
      accounting: { finishedResponses: 0, usageReports: 0 },
    });
    await expect(
      session.realtime({
        model: 'fixture',
        adapter: {
          async connect() {
            throw new Error('synthetic startup failure');
          },
        },
      }),
    ).rejects.toThrow('synthetic startup failure');
    expect(session.realtimeLifetimeUsage.accounting.finishedResponses).toBe(0);
    const values: (NativeRealtimeUsage | undefined)[] = [
      undefined,
      { total_tokens: 0 },
      { total_tokens: 3, input_token_details: { cached_tokens: 1 } },
      { total_tokens: 5 },
      ...Array.from({ length: 12 }, () => ({ total_tokens: 1 })),
    ];
    let total: number | undefined;
    let reports = 0;
    for (const [index, usage] of values.entries()) {
      const adapter = adapterFor(usage);
      const voice = await session.realtime({ model: 'fixture', adapter });
      expect(session.realtimeUsage).toBeUndefined();
      expect(voice.usageAccounting.finishedResponses).toBe(0);
      await voice.sendText('Synthetic usage turn');
      for await (const event of voice.events()) {
        if (event.type === 'response' && event.status === 'done') {
          if (usage !== undefined) {
            total = (total ?? 0) + (usage.total_tokens ?? 0);
            reports++;
          }
          expect(session.realtimeLifetimeUsage).toMatchObject({
            usage: total === undefined ? undefined : { total_tokens: total },
            accounting: { finishedResponses: index + 1, usageReports: reports },
          });
          expect(event.cumulativeUsage).toEqual(usage);
          break;
        }
      }
      await voice.close();
      expect(voice.usage).toEqual(usage);
      expect(voice.usageAccounting).toEqual({
        finishedResponses: 1,
        usageReports: usage === undefined ? 0 : 1,
      });
      expect(session.realtimeUsage).toBeUndefined();
      expect(session.realtimeUsageAccounting).toBeUndefined();
      expect(session.realtimeLifetimeUsage.accounting.finishedResponses).toBe(
        index + 1,
      );
      adapter.assertComplete();
    }
    const snapshot = session.realtimeLifetimeUsage;
    expect(snapshot).toEqual({
      usage: { total_tokens: 20, input_token_details: { cached_tokens: 1 } },
      accounting: { finishedResponses: 16, usageReports: 15 },
    });
    Reflect.set(snapshot.accounting, 'finishedResponses', 999);
    Reflect.set(snapshot.usage!, 'total_tokens', 999);
    Reflect.set(snapshot.usage!.input_token_details!, 'cached_tokens', 999);
    expect(session.realtimeLifetimeUsage.usage?.total_tokens).toBe(20);
    expect(
      session.realtimeLifetimeUsage.usage?.input_token_details?.cached_tokens,
    ).toBe(1);
    expect(session.realtimeLifetimeUsage.accounting.finishedResponses).toBe(16);
    expect(JSON.stringify(session.realtimeLifetimeUsage).length).toBeLessThan(
      512,
    );
  },
);

nativeIt(
  'rejects lifetime overflow before publishing either usage snapshot',
  async () => {
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      provider,
    }).session();
    const first = await session.realtime({
      model: 'fixture',
      adapter: adapterFor({ total_tokens: Number.MAX_SAFE_INTEGER }),
    });
    await first.sendText('Synthetic usage turn');
    for await (const event of first.events()) {
      if (event.type === 'response' && event.status === 'done') break;
    }
    await first.close();
    const before = session.realtimeLifetimeUsage;
    const second = await session.realtime({
      model: 'fixture',
      adapter: adapterFor({ total_tokens: 1 }),
    });
    await expect(
      (async () => {
        await second.sendText('Synthetic usage turn');
        for await (const _event of second.events()) {
          /* drain through failure */
        }
      })(),
    ).rejects.toThrow('Realtime cumulative usage exceeds safe integer range');
    expect(session.realtimeLifetimeUsage).toEqual(before);
    expect(second.usage).toBeUndefined();
    expect(second.usageAccounting).toEqual({
      finishedResponses: 0,
      usageReports: 0,
    });
    await second.close();
  },
);
