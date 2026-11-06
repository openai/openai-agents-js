import assert from 'node:assert/strict';
import { join } from 'node:path';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import {
  answerJob,
  createSyntheticEffect,
  prepareJob,
  readJob,
  reconcileJob,
  settleJob,
  syntheticOrder,
  writeJobJson,
} from '../../../../../examples/codex/external-order-recovery';

async function main() {
  const [, , directory, mode] = process.argv;
  const providerDirectory = join(directory, 'provider');
  if (mode === 'prepare') {
    await withScriptedResponses(
      [
        [
          toolCall(
            'fulfill_order',
            { orderId: 'order-42' },
            { callId: 'original-call' },
          ),
        ],
      ],
      async (peer) => {
        await prepareJob(directory, syntheticOrder, peer.provider);
      },
    );
    return;
  }
  const journal = await readJob(directory, syntheticOrder);
  assert(journal);
  if (mode === 'pending') process.exit(23);
  if (mode === 'committed') {
    await writeJobJson(join(directory, 'job.json'), {
      ...journal,
      phase: 'creating',
    });
    await createSyntheticEffect(providerDirectory, syntheticOrder);
    process.exit(23);
  }
  await reconcileJob(directory, providerDirectory, syntheticOrder);
  if (mode === 'ready') process.exit(23);
  if (journal.phase === 'done') {
    assert.equal(journal.finalOutput, 'Fulfilled.');
    return;
  }
  if (mode === 'duplicate') {
    await withScriptedResponses(
      [
        [
          toolCall(
            'fulfill_order',
            { orderId: 'order-42' },
            { callId: 'unauthorized-repeat' },
          ),
        ],
      ],
      async (peer) => {
        await assert.rejects(
          answerJob(directory, syntheticOrder, peer.provider),
          /Unexpected or duplicate order request/,
        );
        peer.assertExhausted();
        assert.equal(
          (await readJob(directory, syntheticOrder))?.phase,
          'ready',
        );
      },
    );
    return;
  }
  await withScriptedResponses([[text('Fulfilled.')]], async (peer) => {
    const final = await answerJob(directory, syntheticOrder, peer.provider);
    assert.equal(final, 'Fulfilled.');
    assert.deepEqual(JSON.parse(peer.toolOutput('original-call')!), {
      orderId: 'order-42',
      status: 'fulfilled',
    });
    assert(!JSON.stringify(peer.requests).includes('providerReceipt'));
    assert('providerReceipt' in (await readJob(directory, syntheticOrder))!);
    const ready = await readJob(directory, syntheticOrder);
    assert(ready && 'providerReceipt' in ready);
    assert(!JSON.stringify(peer.requests).includes(ready.providerReceipt));
    // Abruptly stop after a live restored reply/model continuation, before terminal persistence.
    if (mode === 'answered') process.exit(23);
    await settleJob(directory, syntheticOrder, final);
  });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
