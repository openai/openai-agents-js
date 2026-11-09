import { expect, it } from 'vitest';
import { Agent, NativeProvider } from '../src';
import { ScriptedRealtimeAdapter } from '../src/testing';

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'accepts the canonical startup ACK without function tools or optional settings',
  async () => {
    const adapter = new ScriptedRealtimeAdapter([
      {
        expect: 'session.update',
        emit: (frame) => [
          {
            type: 'session.updated',
            session: { ...(frame.session as object), id: 'fixture' },
          },
        ],
      },
    ]);
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      provider,
    }).session();
    const voice = await session.realtime({ model: 'fixture', adapter });
    await voice.close();
    adapter.assertComplete();
    expect(adapter.sentEvents[0].session).toMatchObject({ model: 'fixture' });
  },
);
