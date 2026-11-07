import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { withScriptedResponses } from '@openai/agents/testing';
import { collectionAgent, SelectiveCollection } from './selective-collection';
import {
  assertCollectionWorkflow,
  collectionScript,
  createCollectionFixture,
  RELEVANT_IDS,
  stageBulkFixture,
  stagedVolume,
} from './selective-collection-fixture';

interface Trial {
  mode: 'selected' | 'bulk';
  trial: number;
  files: number;
  bytes: number;
  stagingMs: number;
  workflowMs: number;
  totalMs: number;
  correct: boolean;
  failures: number;
  transferredIds: string[];
}

/** Local warm-cache experiment; includes real file transfers and native scripted work. */
export async function benchmarkCollection() {
  await using fixture = await createCollectionFixture();
  const trials: Trial[] = [];
  for (let trial = 0; trial < 5; trial++) {
    for (const mode of ['selected', 'bulk'] as const) {
      fixture.fetched.length = 0;
      const started = performance.now();
      const record: Trial = {
        mode,
        trial,
        files: 0,
        bytes: 0,
        stagingMs: 0,
        workflowMs: 0,
        totalMs: 0,
        correct: false,
        failures: 0,
        transferredIds: [],
      };
      try {
        await using owner =
          mode === 'selected'
            ? await SelectiveCollection.open(fixture.options)
            : await stageBulkFixture(fixture);
        const workflowStarted = performance.now();
        await withScriptedResponses(collectionScript(), async (peer) => {
          const result = await collectionAgent(owner, peer.provider).run(
            'Find and total Orchid revenue.',
          );
          assertCollectionWorkflow(peer, result.finalOutput);
        });
        record.workflowMs = performance.now() - workflowStarted;
        record.totalMs = performance.now() - started;
        record.stagingMs =
          owner instanceof SelectiveCollection
            ? owner.transfers.reduce(
                (sum, transfer) => sum + transfer.elapsedMs,
                0,
              )
            : owner.stagingMs;
        const volume = await stagedVolume(
          owner instanceof SelectiveCollection
            ? fixture.options.scratchParent
            : owner.root,
        );
        record.files = volume.files;
        record.bytes = volume.bytes;
        assert.equal(
          record.files,
          mode === 'selected' ? 2 : fixture.catalog.length,
        );
        assert.equal(
          record.bytes,
          fixture.fetched.reduce((sum, file) => sum + file.bytes, 0),
        );
        if (mode === 'selected')
          assert.deepEqual(
            fixture.fetched.map(({ id }) => id),
            RELEVANT_IDS,
          );
        record.correct = true;
      } catch {
        record.correct = false;
        record.failures = 1;
        record.totalMs = performance.now() - started;
      }
      record.transferredIds = fixture.fetched.map(({ id }) => id);
      trials.push(record);
    }
  }
  const spread = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted.at(-1),
    };
  };
  return {
    scope:
      'Synthetic local files, warm OS cache, sequential copying, native scripted Responses; no production speedup claim. Setup, volume verification, and teardown excluded from timings. selected stagingMs counts fetch/write only; bulk stagingMs counts the full copy loop. workflowMs includes native setup and disposal; totalMs includes owner setup and workflow.',
    node: process.version,
    catalogEntries: fixture.catalog.length,
    trials,
    summary: Object.fromEntries(
      (['selected', 'bulk'] as const).map((mode) => {
        const completed = trials.filter(
          (trial) => trial.mode === mode && trial.correct,
        );
        return [
          mode,
          {
            successes: completed.length,
            failures: trials
              .filter((trial) => trial.mode === mode)
              .reduce((sum, trial) => sum + trial.failures, 0),
            stagingMs: spread(completed.map((trial) => trial.stagingMs)),
            workflowMs: spread(completed.map((trial) => trial.workflowMs)),
            totalMs: spread(completed.map((trial) => trial.totalMs)),
          },
        ];
      }),
    ),
  };
}

if (typeof require !== 'undefined' && require.main === module) {
  benchmarkCollection()
    .then(async (result) => {
      if (process.argv[2])
        await writeFile(process.argv[2], JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result.summary, null, 2));
      if (result.trials.some((trial) => !trial.correct)) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
