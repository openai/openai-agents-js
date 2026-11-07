import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_CHARS } from '../../../../examples/codex/document-workspace';
import {
  CollectionAccessError,
  SelectiveCollection,
} from '../../../../examples/codex/selective-collection';
import { stagedVolume } from '../../../../examples/codex/selective-collection-fixture';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(fs.writeFile).mockRestore();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function scratch() {
  const root = await fs.mkdtemp(join(tmpdir(), 'selective-collection-test-'));
  roots.push(root);
  return root;
}

describe('application-owned selective collection', () => {
  it('scans only metadata and bounds discovery over 10,000 authorized IDs', async () => {
    const catalog = Array.from({ length: 10_000 }, (_, index) => ({
      id: `opaque-${index}`,
      title: `Report ${index}`,
    }));
    const fetch = vi.fn();
    await using collection = await SelectiveCollection.open({
      catalog,
      fetch,
      scratchParent: await scratch(),
    });
    catalog[0].title = 'Changed after opening';
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = collection.search('report', offset);
      expect(page.documents.length).toBeLessThanOrEqual(20);
      seen.push(...page.documents.map(({ id }) => id));
      offset = page.nextOffset;
    }
    expect(seen).toHaveLength(10_000);
    expect(new Set(seen).size).toBe(10_000);
    expect(collection.search('changed').documents).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(collection.tools().map(({ name }) => name)).toEqual([
      'search_collection',
      'read_collection_document',
    ]);
  });

  it('denies unknown IDs before fetch and stages concurrent selected pages once', async () => {
    const parent = await scratch();
    const body = Buffer.from('😀'.repeat(PAGE_CHARS) + 'Selected content');
    const fetch = vi.fn(async () => body);
    await using collection = await SelectiveCollection.open({
      catalog: [{ id: '../../opaque', title: 'Report' }],
      fetch,
      scratchParent: parent,
    });
    expect(await collection.read('unknown')).toEqual({ status: 'denied' });
    expect(fetch).not.toHaveBeenCalled();
    const [first, again] = await Promise.all([
      collection.read('../../opaque'),
      collection.read('../../opaque'),
    ]);
    expect(first).toEqual(again);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('Expected selected content');
    expect(Array.from(first.text)).toHaveLength(PAGE_CHARS);
    expect(
      await collection.read('../../opaque', first.nextOffset!, first.revision),
    ).toMatchObject({
      status: 'ok',
      text: 'Selected content',
      nextOffset: null,
    });
    expect(await collection.read('../../opaque', 0, 'outdated')).toEqual({
      status: 'stale_revision',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await stagedVolume(parent)).toEqual({
      files: 1,
      bytes: body.length,
    });
    expect(collection.transfers).toEqual([
      { id: '../../opaque', bytes: body.length, elapsedMs: expect.any(Number) },
    ]);
  });

  it('sanitizes denial and unavailable errors and retries failed acquisition', async () => {
    const parent = await scratch();
    const fetch = vi.fn(async () => Buffer.from('Recovered'));
    fetch.mockRejectedValueOnce(new CollectionAccessError('denied'));
    fetch.mockRejectedValueOnce(new Error('/private/path token=secret'));
    await using collection = await SelectiveCollection.open({
      catalog: [{ id: 'a', title: 'Report' }],
      fetch,
      scratchParent: parent,
    });
    expect(await collection.read('a')).toEqual({ status: 'denied' });
    expect(await collection.read('a')).toEqual({ status: 'unavailable' });
    expect(await stagedVolume(parent)).toEqual({ files: 0, bytes: 0 });
    expect(collection.transfers).toEqual([]);
    expect(await collection.read('a')).toMatchObject({
      status: 'ok',
      text: 'Recovered',
    });
    // Staged bytes remain this session's snapshot even if backend policy later changes.
    fetch.mockRejectedValue(new CollectionAccessError('denied'));
    expect(await collection.read('a')).toMatchObject({
      status: 'ok',
      text: 'Recovered',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects oversized or invalid UTF-8 bodies without leaving staged files', async () => {
    const parent = await scratch();
    const fetch = vi.fn(async () => Buffer.from('Valid'));
    fetch.mockResolvedValueOnce(Buffer.alloc(16 * 1024 * 1024 + 1));
    fetch.mockResolvedValueOnce(Buffer.from([0xff]));
    await using collection = await SelectiveCollection.open({
      catalog: [{ id: 'a', title: 'Report' }],
      fetch,
      scratchParent: parent,
    });
    expect(await collection.read('a')).toEqual({ status: 'unavailable' });
    expect(await collection.read('a')).toEqual({ status: 'unavailable' });
    expect(await stagedVolume(parent)).toEqual({ files: 0, bytes: 0 });
    expect(await collection.read('a')).toMatchObject({
      status: 'ok',
      text: 'Valid',
    });
  });

  it('removes a partially written destination so a later read can retry', async () => {
    const parent = await scratch();
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.writeFile).mockImplementationOnce(async (path, data) => {
      await actual.writeFile(path, (data as Buffer).subarray(0, 2));
      throw new Error('synthetic disk failure /private/path');
    });
    const fetch = vi.fn(async () => Buffer.from('Complete content'));
    await using collection = await SelectiveCollection.open({
      catalog: [{ id: 'a', title: 'Report' }],
      fetch,
      scratchParent: parent,
    });
    expect(await collection.read('a')).toEqual({ status: 'unavailable' });
    expect(await stagedVolume(parent)).toEqual({ files: 0, bytes: 0 });
    expect(collection.transfers).toEqual([]);
    expect(await collection.read('a')).toMatchObject({
      status: 'ok',
      text: 'Complete content',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves cancellation and joins a fetch before removing scratch', async () => {
    const parent = await scratch();
    let release!: (value: Buffer) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const body = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const collection = await SelectiveCollection.open({
      catalog: [{ id: 'a', title: 'Report' }],
      scratchParent: parent,
      fetch: async () => {
        entered();
        return body;
      },
    });
    const controller = new AbortController();
    const reading = collection.read('a', 0, null, controller.signal);
    const rejected = expect(reading).rejects.toThrow('stop');
    await started;
    controller.abort(new Error('stop'));
    let closed = false;
    const closing = collection.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(Buffer.from('Late content'));
    await rejected;
    await closing;
    expect(await fs.readdir(parent)).toEqual([]);
    expect(collection.transfers).toEqual([]);
    await expect(collection.read('a')).rejects.toThrow('Collection closed');
    await collection.close();
  });
});
