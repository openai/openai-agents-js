import { prepareOutput } from '../../src/runtime/output';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createSyntheticEffect,
  fulfillOrder,
  parseJobJournal,
  readJob,
  reconcileJob,
  syntheticOrder,
  writeJobJson,
} from '../../examples/external-order-recovery';
import { CODEX_REVISION } from '../../src/runtime/state';

// Keep real file writes and disposal while injecting otherwise hard-to-reproduce cleanup failures.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agents-order-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function pendingCheckpoint() {
  return JSON.stringify({
    kind: 'manual',
    network_policy_digest: null,
    output_context: prepareOutput(undefined).identity,
    native: {
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: 'saved-session',
      root_metadata: {},
      history: [],
    },
    manual_continuation: {
      turn_id: 'turn',
      reply_order: ['original-call'],
      accepted_replies: {},
      pending_manual: [
        {
          call_id: 'original-call',
          name: 'fulfill_order',
          arguments: JSON.stringify({ orderId: syntheticOrder.orderId }),
        },
      ],
    },
    manual_context: { instructions: null, result_schemas: [], usage: null },
  });
}
async function pendingJob(path: string) {
  const effect = await createSyntheticEffect(
    join(path, 'provider'),
    syntheticOrder,
  );
  const journal = {
    version: 1,
    phase: 'creating',
    binding: effect.binding,
    checkpoint: pendingCheckpoint(),
  };
  await writeJobJson(join(path, 'job.json'), journal);
  return { effect, journal };
}

it('rejects changed authority, versions, results, and nonpending envelopes before dispatch', async () => {
  const path = await directory();
  const { journal, effect } = await pendingJob(path);
  expect(parseJobJournal(journal, syntheticOrder).phase).toBe('creating');
  for (const changed of [
    { ...syntheticOrder, tenant: 'other' },
    { ...syntheticOrder, orderId: 'other' },
    { ...syntheticOrder, quantity: 2 },
  ])
    expect(() => parseJobJournal(journal, changed)).toThrow('binding changed');
  expect(() =>
    parseJobJournal({ ...journal, version: 2 }, syntheticOrder),
  ).toThrow();
  expect(() =>
    parseJobJournal(
      {
        ...journal,
        phase: 'ready',
        providerReceipt: effect.providerReceipt,
        result: { ...effect.result, orderId: 'other' },
      },
      syntheticOrder,
    ),
  ).toThrow('Conflicting public result');
  expect(() =>
    parseJobJournal({ ...journal, checkpoint: '{}' }, syntheticOrder),
  ).toThrow();
  expect(
    fulfillOrder.match({
      type: 'action_requested',
      name: 'fulfill_order',
      callId: 'original-call',
    }),
  ).toBeUndefined();
});

it('reconciles a committed effect and refuses changed payload under the same key', async () => {
  const path = await directory();
  const { effect } = await pendingJob(path);
  const journal = await reconcileJob(
    path,
    join(path, 'provider'),
    syntheticOrder,
  );
  expect(journal).toMatchObject({
    phase: 'ready',
    result: effect.result,
    providerReceipt: effect.providerReceipt,
  });
  await expect(
    createSyntheticEffect(join(path, 'provider'), {
      ...syntheticOrder,
      quantity: 2,
    }),
  ).rejects.toThrow('binding changed');
  expect(await readdir(join(path, 'provider'))).toHaveLength(1);
});

it('records unknown on inconclusive lookup and never dispatches on retry', async () => {
  const path = await directory();
  await pendingJob(path);
  const provider = join(path, 'empty-provider');
  await expect(
    reconcileJob(path, provider, syntheticOrder, async () => {
      throw new Error('Lookup unavailable');
    }),
  ).rejects.toThrow('Lookup unavailable');
  expect((await readJob(path, syntheticOrder))?.phase).toBe('unknown');
  await expect(reconcileJob(path, provider, syntheticOrder)).rejects.toThrow(
    'automatic dispatch refused',
  );
  await expect(readdir(provider)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains the accepted journal when replacement fails and removes temporary files', async () => {
  const path = await directory();
  const journal = join(path, 'job.json');
  await writeJobJson(journal, { accepted: true });
  // Serialization fails after exclusive temporary creation but before replacement.
  await expect(writeJobJson(journal, { unsupported: 1n })).rejects.toThrow();
  expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual({
    accepted: true,
  });
  expect(await readdir(path)).toEqual(['job.json']);
});

it.each([new Error('Serialization failed'), undefined])(
  'preserves the original serialization failure %s after cleanup',
  async (original) => {
    const path = await directory();
    await expect(
      writeJobJson(join(path, 'job.json'), {
        toJSON() {
          throw original;
        },
      }),
    ).rejects.toBe(original);
    expect(await readdir(path)).toEqual([]);
  },
);

it.each([new Error('Serialization failed'), undefined])(
  'reports both serialization failure %s and cleanup failure',
  async (original) => {
    const path = await directory();
    const cleanup = new Error('Cleanup failed');
    vi.mocked(unlink).mockRejectedValueOnce(cleanup);
    const failure = await writeJobJson(join(path, 'job.json'), {
      toJSON() {
        throw original;
      },
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('Write and cleanup failed.');
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(original);
    expect(failure.errors[1]).toBe(cleanup);
  },
);

it('reports cleanup failure after committing a replacement', async () => {
  const path = await directory();
  const journal = join(path, 'job.json');
  const cleanup = new Error('Cleanup failed');
  vi.mocked(unlink).mockRejectedValueOnce(cleanup);
  await expect(writeJobJson(journal, { accepted: true })).rejects.toBe(cleanup);
  expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual({
    accepted: true,
  });
});

const exec = promisify(execFile);
it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'recovers real cross-process crashes at each durable boundary with one effect',
  async () => {
    const child = fileURLToPath(
      new URL('./fixtures/external-job-child.ts', import.meta.url),
    );
    for (const crash of ['pending', 'committed', 'ready', 'answered']) {
      const path = await directory();
      const run = (mode: string) =>
        exec(process.execPath, ['--import', 'tsx', child, path, mode], {
          timeout: 45_000,
          maxBuffer: 1024 * 1024,
        });
      await run('prepare');
      const checkpoint = (await readJob(path, syntheticOrder))!.checkpoint;
      await expect(run(crash)).rejects.toMatchObject({ code: 23 });
      expect((await readJob(path, syntheticOrder))!.checkpoint).toBe(
        checkpoint,
      );
      if (crash === 'pending')
        await expect(readdir(join(path, 'provider'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      if (crash === 'ready') await run('duplicate');
      await run('recover');
      const terminal = await readJob(path, syntheticOrder);
      expect(terminal).toMatchObject({
        phase: 'done',
        finalOutput: 'Fulfilled.',
        result: { orderId: 'order-42', status: 'fulfilled' },
        checkpoint,
      });
      const effects = await readdir(join(path, 'provider'));
      expect(effects).toHaveLength(1);
      const physical = await readFile(
        join(path, 'provider', effects[0]),
        'utf8',
      );
      await run('recover');
      expect(await readFile(join(path, 'provider', effects[0]), 'utf8')).toBe(
        physical,
      );
    }
  },
  240_000,
);
