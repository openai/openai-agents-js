import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { toolCall, withScriptedResponses } from '@openai/agents/testing';
import {
  CollectionAccessError,
  collectionAgent,
  SelectiveCollection,
} from '../../../../examples/codex/selective-collection';
import {
  assertCollectionWorkflow,
  collectionScript,
  createCollectionFixture,
  RELEVANT_IDS,
  stageBulkFixture,
  stagedVolume,
} from '../../../../examples/codex/selective-collection-fixture';

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native selective collection workflow',
  () => {
    it('discovers 10,000 metadata entries, selects pages and answers without unrelated transfers', async () => {
      await using fixture = await createCollectionFixture();
      expect(fixture.catalog).toHaveLength(10_000);
      const attempts: string[] = [];
      await using collection = await SelectiveCollection.open({
        ...fixture.options,
        fetch: async (id, signal) => {
          attempts.push(id);
          if (id === 'doc-00002') throw new CollectionAccessError('denied');
          if (id === 'doc-00003')
            throw new Error('/private/backend?credential=secret');
          return fixture.options.fetch(id, signal);
        },
      });
      expect(collection.search('Orchid revenue').documents).toHaveLength(2);
      expect(fixture.fetched).toEqual([]);
      const failureCall = (id: string, callId: string) => [
        toolCall(
          'read_collection_document',
          { id, offset: 0, revision: null },
          { callId },
        ),
      ];
      const started = performance.now();
      await withScriptedResponses(
        [
          failureCall('unknown-id', 'unknown'),
          failureCall('doc-00002', 'denied'),
          failureCall('doc-00003', 'unavailable'),
          ...collectionScript(),
        ],
        async (peer) => {
          const result = await collectionAgent(collection, peer.provider).run(
            'Find and total Orchid revenue. Report inaccessible sources.',
          );
          assertCollectionWorkflow(peer, result.finalOutput);
          expect(JSON.parse(peer.toolOutput('unknown')!)).toEqual({
            status: 'denied',
          });
          expect(JSON.parse(peer.toolOutput('denied')!)).toEqual({
            status: 'denied',
          });
          expect(JSON.parse(peer.toolOutput('unavailable')!)).toEqual({
            status: 'unavailable',
          });
          expect(JSON.stringify(peer.requests)).not.toMatch(
            /private\/backend|credential=secret|source-\d+\.txt|agents-collection-/,
          );
          expect(attempts).toEqual(['doc-00002', 'doc-00003', ...RELEVANT_IDS]);
          expect(fixture.fetched.map(({ id }) => id)).toEqual(RELEVANT_IDS);
          const volume = await stagedVolume(fixture.options.scratchParent);
          expect(volume).toEqual({
            files: 2,
            bytes: fixture.fetched.reduce((sum, file) => sum + file.bytes, 0),
          });
          expect(
            collection.transfers.map(({ id, bytes }) => ({ id, bytes })),
          ).toEqual(fixture.fetched);
          const evidence = {
            catalogEntries: fixture.catalog.length,
            answer: result.finalOutput,
            ...volume,
            transfers: collection.transfers,
            workflowMs: performance.now() - started,
            expectedDenied: 2,
            expectedUnavailable: 1,
          };
          if (process.env.REQ741_EVIDENCE_DIR)
            await writeFile(
              join(process.env.REQ741_EVIDENCE_DIR, 'js-native-workflow.json'),
              JSON.stringify(evidence, null, 2),
            );
        },
      );
    }, 30_000);

    it('copies the same authorized collection in the separate bulk baseline and verifies the same answer', async () => {
      await using fixture = await createCollectionFixture();
      await using bulk = await stageBulkFixture(fixture);
      const volume = await stagedVolume(bulk.root);
      expect(volume).toEqual({
        files: 10_000,
        bytes: fixture.fetched.reduce((sum, file) => sum + file.bytes, 0),
      });
      expect(fixture.fetched.map(({ id }) => id)).toEqual(
        fixture.catalog.map(({ id }) => id),
      );
      await withScriptedResponses(collectionScript(), async (peer) => {
        const result = await collectionAgent(bulk, peer.provider).run(
          'Find and total Orchid revenue.',
        );
        assertCollectionWorkflow(peer, result.finalOutput);
      });
    }, 30_000);
  },
);
