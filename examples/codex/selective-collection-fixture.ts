import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  text,
  toolCall,
  withScriptedResponses,
  type ScriptedResponses,
} from '@openai/agents/testing';
import { PAGE_CHARS, SelectedDocuments } from './document-workspace';
import { collectionAgent, SelectiveCollection } from './selective-collection';

export const COLLECTION_SIZE = 10_000;
export const RELEVANT_IDS = ['doc-00007', 'doc-09001'];
export const COLLECTION_ANSWER = 'Orchid revenue totals 42 million.';

export function fixtureBody(index: number) {
  const amount = index === 7 ? 17 : index === 9001 ? 25 : null;
  return amount === null
    ? `Unrelated reference ${index}.\n` + 'Reference text.\n'.repeat(64)
    : '🌿'.repeat(PAGE_CHARS) + `Orchid revenue: ${amount} million.\n`;
}

/** App-owned local backend. Setup is excluded from benchmark timers. */
export async function createCollectionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agents-collection-fixture-'));
  const source = join(root, 'source');
  const scratchParent = join(root, 'scratch');
  try {
    await Promise.all([mkdir(source), mkdir(scratchParent)]);
    const catalog = Array.from({ length: COLLECTION_SIZE }, (_, index) => ({
      id: `doc-${String(index).padStart(5, '0')}`,
      title:
        index === 7
          ? 'Orchid revenue east'
          : index === 9001
            ? 'Orchid revenue west'
            : `Reference ${index}`,
    }));
    const paths = new Map(
      catalog.map(({ id }, index) => [id, join(source, `source-${index}.txt`)]),
    );
    for (let start = 0; start < catalog.length; start += 100) {
      await Promise.all(
        catalog
          .slice(start, start + 100)
          .map(({ id }, offset) =>
            writeFile(paths.get(id)!, fixtureBody(start + offset)),
          ),
      );
    }
    const fetched: { id: string; bytes: number }[] = [];
    const fetch = async (id: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      const path = paths.get(id);
      assert(path, 'The application must authorize IDs before fetching');
      const bytes = await readFile(path, { signal });
      fetched.push({ id, bytes: bytes.length });
      return bytes;
    };
    return {
      root,
      source,
      catalog,
      paths,
      fetched,
      options: { catalog, fetch, scratchParent },
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Count actual regular files and sizes in an application-owned staging tree. */
export async function stagedVolume(
  root: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await stagedVolume(path);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      assert(entry.isFile());
      files++;
      bytes += (await stat(path)).size;
    }
  }
  return { files, bytes };
}

/** Separate matched baseline: copy every authorized body before opening the reader. */
export async function stageBulkFixture(
  fixture: Awaited<ReturnType<typeof createCollectionFixture>>,
) {
  const started = performance.now();
  const root = await mkdtemp(join(fixture.root, 'bulk-'));
  try {
    const selected: Record<string, string> = {};
    const signal = new AbortController().signal;
    for (const [index, { id }] of fixture.catalog.entries()) {
      const filename = `document-${index}.txt`;
      await writeFile(
        join(root, filename),
        await fixture.options.fetch(id, signal),
        { flag: 'wx', mode: 0o600 },
      );
      selected[id] = filename;
    }
    const stagingMs = performance.now() - started;
    const documents = await SelectedDocuments.open({ root, selected });
    return {
      root,
      stagingMs,
      tools() {
        return [
          tool({
            name: 'search_collection',
            parameters: z.object({
              query: z.string(),
              offset: z.number().int().nonnegative(),
            }),
            execute: ({ query, offset }) => {
              const matches = fixture.catalog
                .map((entry, index) => ({ entry, index }))
                .filter(
                  ({ entry, index }) =>
                    index >= offset &&
                    entry.title.toLowerCase().includes(query.toLowerCase()),
                );
              return {
                documents: matches.slice(0, 20).map(({ entry }) => entry),
                nextOffset: matches[20]?.index ?? null,
              };
            },
          }),
          tool({
            name: 'read_collection_document',
            parameters: z.object({
              id: z.string(),
              offset: z.number().int().nonnegative(),
              revision: z.string().nullable(),
            }),
            execute: async ({ id, offset, revision }) => ({
              status: 'ok',
              ...(await documents.read(id, offset, revision ?? undefined)),
            }),
          }),
        ];
      },
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function collectionScript() {
  const call = (
    id: string,
    offset: number,
    revision: string | null,
    callId: string,
  ) =>
    toolCall('read_collection_document', { id, offset, revision }, { callId });
  const revision = (index: number) =>
    createHash('sha256').update(fixtureBody(index)).digest('hex');
  return [
    [
      toolCall(
        'search_collection',
        { query: 'Orchid revenue', offset: 0 },
        { callId: 'discovery' },
      ),
    ],
    [call(RELEVANT_IDS[0], 0, null, 'east-first')],
    [call(RELEVANT_IDS[0], PAGE_CHARS, revision(7), 'east-last')],
    [call(RELEVANT_IDS[1], 0, null, 'west-first')],
    [call(RELEVANT_IDS[1], PAGE_CHARS, revision(9001), 'west-last')],
    [text(COLLECTION_ANSWER)],
  ];
}

export function assertCollectionWorkflow(
  peer: ScriptedResponses,
  answer: string,
) {
  const output = (id: string) => JSON.parse(peer.toolOutput(id)!);
  assert.deepEqual(output('discovery'), {
    documents: [
      { id: RELEVANT_IDS[0], title: 'Orchid revenue east' },
      { id: RELEVANT_IDS[1], title: 'Orchid revenue west' },
    ],
    nextOffset: null,
  });
  for (const prefix of ['east', 'west']) {
    const first = output(`${prefix}-first`);
    const last = output(`${prefix}-last`);
    assert.equal(first.status, 'ok');
    assert.equal(Array.from(first.text).length, PAGE_CHARS);
    assert.equal(first.nextOffset, PAGE_CHARS);
    assert.equal(last.status, 'ok');
    assert.equal(last.nextOffset, null);
    assert.equal(last.revision, first.revision);
  }
  const total = ['east-last', 'west-last'].reduce(
    (sum, id) =>
      sum + Number(/revenue: (\d+) million/.exec(output(id).text)![1]),
    0,
  );
  assert.equal(total, 42);
  assert.equal(answer, `Orchid revenue totals ${total} million.`);
  assert(!JSON.stringify(peer.requests).includes('Unrelated reference'));
  peer.assertExhausted();
}

export async function runCollectionDemo() {
  await using fixture = await createCollectionFixture();
  await using collection = await SelectiveCollection.open(fixture.options);
  const started = performance.now();
  await withScriptedResponses(collectionScript(), async (peer) => {
    const result = await collectionAgent(collection, peer.provider).run(
      'Find the Orchid revenue reports and total their revenue.',
    );
    assertCollectionWorkflow(peer, result.finalOutput);
    const volume = await stagedVolume(fixture.options.scratchParent);
    assert.equal(volume.files, RELEVANT_IDS.length);
    assert.deepEqual(
      fixture.fetched.map(({ id }) => id),
      RELEVANT_IDS,
    );
    console.log(
      JSON.stringify({
        answer: result.finalOutput,
        catalogEntries: fixture.catalog.length,
        ...volume,
        transfers: collection.transfers,
        workflowMs: performance.now() - started,
      }),
    );
  });
}
