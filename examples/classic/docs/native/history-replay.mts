import assert from 'node:assert/strict';
import { Agent } from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';

await withScriptedResponses(
  [[text('record loaded')], [text('continued record')]],
  async (peer) => {
    const agent = new Agent({
      instructions: 'Use the record.',
      provider: peer.provider,
    });
    const result = await agent.run('Load the record.', { returnHistory: true });
    if (!result.history) throw new Error('Requested history is unavailable');
    await using session = await agent.session();
    const before = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: result.history,
    });
    const continued = await (
      await session.submit('Continue with that record.')
    ).wait();
    console.log(continued.finalOutput);

    assert.equal(result.finalOutput, 'record loaded');
    assert.equal(continued.finalOutput, 'continued record');
    peer.assertExhausted();
    assert.equal(peer.requests.length, 2);
    const replayed = JSON.stringify(peer.requests[1]!.input);
    assert(replayed.includes('Load the record.'));
    assert(replayed.includes('record loaded'));
    assert(replayed.includes('Continue with that record.'));
  },
);
