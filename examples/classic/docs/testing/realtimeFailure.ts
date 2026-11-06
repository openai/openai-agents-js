import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { ScriptedRealtimeTransport } from '@openai/agents/realtime/testing';
import assert from 'node:assert/strict';
import test from 'node:test';

test('injects a transport failure into the next matching call', async () => {
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(
    new RealtimeAgent({ name: 'Assistant' }),
    { transport },
  );
  const failure = new Error('connection failed');

  // Failure injection and call matching are independent: the failed attempt
  // is still recorded and must satisfy the expectation.
  transport.failNextCall('connect', failure);
  const connectCall = transport.expectCall('connect');

  await assert.rejects(session.connect({ apiKey: 'test' }), failure);
  assert.equal((await connectCall).method, 'connect');
  assert.equal(transport.status, 'disconnected');
  transport.assertComplete();
  transport.assertClosed();
});
