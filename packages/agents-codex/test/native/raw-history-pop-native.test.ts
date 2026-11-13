import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, localStorage } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

function expectNativeOpeningContext(items: readonly Record<string, unknown>[]) {
  expect(items.map((item) => item.type)).toEqual(['message']);
  expect(items.map((item) => item.role)).toEqual(['developer']);
  expect(
    items.map(
      (item) =>
        (
          item.internal_chat_message_metadata_passthrough as {
            content_item_kinds?: unknown;
          }
        )?.content_item_kinds,
    ),
  ).toEqual([['collaboration_mode.instructions']]);
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-raw-pop',
    supportsWebsockets: false,
  });
}

nativeIt(
  'pops exact raw originals and leaves stale or empty history unchanged',
  async () => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const opening = await session.historySnapshot();
    expectNativeOpeningContext(opening.items);
    await session.transactHistory({
      expectedRevision: opening.revision,
      keep: 0,
    });
    const empty = await session.historySnapshot();
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
    expect(
      await session.popHistory({ expectedRevision: empty.revision }),
    ).toEqual({
      revision: empty.revision,
      item: null,
      rebuiltModelContext: false,
    });
    expect(await session.historySnapshot()).toEqual(empty);
    const original = {
      type: 'application_note',
      nested: [null, { marker: 'raw-tail' }],
    };
    await session.transactHistory({
      expectedRevision: empty.revision,
      keep: 0,
      items: [original],
    });
    const before = await session.historySnapshot();
    await expect(
      session.popHistory({ expectedRevision: empty.revision }),
    ).rejects.toThrow('revision conflict');
    expect(await session.historySnapshot()).toEqual(before);
    const removed = await session.popHistory({
      expectedRevision: before.revision,
    });
    expect(removed.item).toEqual(original);
    expect(removed.rebuiltModelContext).toBe(false);
    const after = await session.historySnapshot();
    expect(removed.revision).toBe(after.revision);
    expect(after.revision).not.toBe(before.revision);
    expect(after.items).toEqual([]);
    expect(after.total).toBe(0);
    expect(server.requests).toEqual([]);
  },
  30_000,
);

nativeIt(
  'keeps a popped tool call repairable after cold restore without changing its stored sibling',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-raw-pop-'));
    try {
      const server = new ModelServer([
        [message('safe continuation')],
        [message('repaired continuation')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({ instructions: 'Answer.', provider });
      const storage = localStorage(join(home, 'profile'));
      const call = {
        type: 'function_call',
        id: 'fc-pop',
        call_id: 'pop-pair',
        name: 'lookup',
        arguments: '{}',
      };
      const output = {
        type: 'function_call_output',
        id: 'out-pop',
        call_id: 'pop-pair',
        output: 'exact imported output',
      };
      const source = await agent.session({ storage });
      const identity = source.id;
      let siblingId: string;
      let popped: Awaited<ReturnType<typeof source.historySnapshot>>;
      let before: Awaited<ReturnType<typeof source.historySnapshot>>;
      try {
        const initial = await source.historySnapshot();
        await source.transactHistory({
          expectedRevision: initial.revision,
          keep: 0,
          items: [call, output],
        });
        before = await source.historySnapshot();
        siblingId = await source.forkStored();
        const removed = await source.popHistory({
          expectedRevision: before.revision,
        });
        expect(removed.item).toEqual(output);
        expect(removed.rebuiltModelContext).toBe(false);
        popped = await source.historySnapshot();
        expect(popped.items).toEqual([call]);
        expect(popped.revision).toBe(removed.revision);
        expect(
          JSON.stringify((await source.modelContext()).items),
        ).not.toContain('pop-pair');
      } finally {
        await source.close();
      }
      {
        await using restored = await agent.session({
          storage,
          resume: identity,
        });
        const cold = await restored.historySnapshot();
        expect(cold.items).toEqual(popped!.items);
        expect(cold.revision).toBe(popped!.revision);
        expect(
          JSON.stringify((await restored.modelContext()).items),
        ).not.toContain('pop-pair');
        expect(
          (await (await restored.submit('continue safely')).wait()).finalOutput,
        ).toBe('safe continuation');
        expect(JSON.stringify(server.requests.at(-1)!.input)).not.toContain(
          'pop-pair',
        );
        const current = await restored.historySnapshot();
        await restored.transactHistory({
          expectedRevision: current.revision,
          keep: 0,
          items: [call, output, ...current.items.slice(1)],
        });
        expect(
          (await (await restored.submit('continue after repair')).wait())
            .finalOutput,
        ).toBe('repaired continuation');
        const repaired = (
          server.requests.at(-1)!.input as Array<Record<string, unknown>>
        ).filter((item) => item.call_id === 'pop-pair');
        expect(repaired.map((item) => item.type)).toEqual([
          'function_call',
          'function_call_output',
        ]);
        expect(repaired[1]!.output).toBe(output.output);
      }
      {
        await using sibling = await agent.session({
          storage,
          resume: siblingId!,
        });
        const siblingItems = (await sibling.historySnapshot()).items;
        expect(siblingItems.slice(0, before!.items.length)).toEqual(
          before!.items,
        );
        expectNativeOpeningContext(siblingItems.slice(before!.items.length));
      }
      expect(server.requests).toHaveLength(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);

nativeIt(
  'requires explicit rebuilding when popping an original covered by a summary',
  async () => {
    const server = new ModelServer([[message('rebuilt continuation')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({ instructions: 'Answer.', provider });
    const originals = ['retained original', 'removed original'].map((text) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }));
    const source = await agent.session();
    let state: Awaited<ReturnType<typeof source.saveState>>;
    let revision: string;
    try {
      const initial = await source.historySnapshot();
      await source.transactHistory({
        expectedRevision: initial.revision,
        keep: 0,
        items: originals,
      });
      await source.compact({ summary: 'covered summary marker' });
      const before = await source.historySnapshot();
      const context = await source.modelContext();
      await expect(
        source.popHistory({ expectedRevision: before.revision }),
      ).rejects.toThrow();
      expect(await source.historySnapshot()).toEqual(before);
      expect((await source.modelContext()).items).toEqual(context.items);
      const removed = await source.popHistory({
        expectedRevision: before.revision,
        rebuildModelContext: true,
      });
      expect(removed.item).toEqual(originals[1]);
      expect(removed.rebuiltModelContext).toBe(true);
      expect((await source.historySnapshot()).items).toEqual(
        originals.slice(0, 1),
      );
      revision = removed.revision;
      state = await source.saveState();
    } finally {
      await source.close();
    }
    await using restored = await agent.session({ state: state! });
    expect((await restored.historySnapshot()).revision).toBe(revision!);
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'rebuilt continuation',
    );
    const wire = JSON.stringify(server.requests.at(-1)!.input);
    expect(wire).toContain('retained original');
    expect(wire).not.toContain('removed original');
    expect(wire).not.toContain('covered summary marker');
    expect(server.requests).toHaveLength(1);
  },
  30_000,
);

nativeIt(
  'keeps a summary through successive native item pops after cold restores',
  async () => {
    const server = new ModelServer([
      [message('late answer to remove')],
      [message('continued after pop')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({ instructions: 'Answer.', provider });
    const source = await agent.session();
    let state: Awaited<ReturnType<typeof source.saveState>>;
    let before: Awaited<ReturnType<typeof source.historySnapshot>>;
    try {
      const initial = await source.historySnapshot();
      await source.transactHistory({
        expectedRevision: initial.revision,
        keep: 0,
        items: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'original before compaction' },
            ],
          },
        ],
      });
      await source.compact({ summary: 'preserved compaction summary' });
      expect(
        (await (await source.submit('late user input to keep')).wait())
          .finalOutput,
      ).toBe('late answer to remove');
      before = await source.historySnapshot();
      expect(before.items.at(-1)!.role).toBe('assistant');
      state = await source.saveState();
    } finally {
      await source.close();
    }
    let after: Awaited<ReturnType<typeof source.historySnapshot>>;
    let secondState: Awaited<ReturnType<typeof source.saveState>>;
    {
      await using restored = await agent.session({ state: state! });
      expect(await restored.historySnapshot()).toEqual(before!);
      const removed = await restored.popHistory({
        expectedRevision: before!.revision,
      });
      expect(removed.item).toEqual(before!.items.at(-1));
      expect(removed.rebuiltModelContext).toBe(false);
      after = await restored.historySnapshot();
      expect(after.revision).toBe(removed.revision);
      expect(after.items).toEqual(before!.items.slice(0, -1));
      expect(after.items.at(-1)!.role).toBe('user');
      expect(JSON.stringify(after.items.at(-1))).toContain(
        'late user input to keep',
      );
      secondState = await restored.saveState();
    }
    expect(server.requests).toHaveLength(1);
    {
      await using twiceRestored = await agent.session({ state: secondState! });
      expect(await twiceRestored.historySnapshot()).toEqual(after!);
      const removedUser = await twiceRestored.popHistory({
        expectedRevision: after!.revision,
      });
      expect(removedUser.item).toEqual(after!.items.at(-1));
      expect(removedUser.rebuiltModelContext).toBe(false);
      const afterSecond = await twiceRestored.historySnapshot();
      expect(afterSecond.items).toEqual(after!.items.slice(0, -1));
      expect(afterSecond.revision).toBe(removedUser.revision);
      expect(afterSecond.revision).not.toBe(after!.revision);
      expect(
        (await (await twiceRestored.submit('continue')).wait()).finalOutput,
      ).toBe('continued after pop');
    }
    const wire = JSON.stringify(server.requests.at(-1)!.input);
    expect(wire).toContain('preserved compaction summary');
    expect(wire).not.toContain('late user input to keep');
    expect(wire).not.toContain('late answer to remove');
    expect(server.requests).toHaveLength(2);
  },
  30_000,
);
