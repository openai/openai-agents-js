import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  localStorage,
  parseSessionState,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

it.each([false, true])(
  'retires a local owner while retaining descendants and portable copies (reverted=%s)',
  async (revertSource) => {
    const home = await mkdtemp(join(tmpdir(), 'native-owner-retirement-'));
    const effects: string[] = [];
    const output = `untruncated-original-${'x'.repeat(131072)}`;
    const read = tool({
      name: 'read',
      parameters: z.object({}),
      execute: () => {
        effects.push('read');
        return output;
      },
    });
    const server = new ModelServer([
      [call('read', {}, { callId: 'retirement-read' })],
      [message('origin-complete')],
      [message('source-only-complete')],
      [message('continued')],
    ]);
    try {
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-retirement',
        supportsWebsockets: false,
      });
      const storage = localStorage(join(home, 'profile'));
      const agent = new Agent({
        instructions: 'Answer.',
        tools: [read],
        provider,
      });
      const source = await agent.session({ storage });
      const sourceId = source.id;
      const portableDataCopy = async (
        items: Awaited<ReturnType<typeof source.historySnapshot>>['items'],
      ) => {
        // Persistent export remains unsupported; this is an explicit data copy.
        await using memory = await agent.session();
        const current = await memory.historySnapshot();
        await memory.transactHistory({
          expectedRevision: current.revision,
          keep: 0,
          items: items.filter(
            (item) =>
              item.type !== 'message' ||
              (item.role !== 'developer' && item.role !== 'system'),
          ),
        });
        return parseSessionState(JSON.stringify(await memory.saveState()));
      };
      let childId: string;
      let turnIds: string[];
      let savedSource: Awaited<ReturnType<typeof source.saveState>>;
      try {
        await (await source.submit('origin-marker')).wait();
        await (await source.submit('source-only-marker')).wait();
        turnIds = [];
        for await (const turn of source.turns()) turnIds.push(turn.id);
        const current = await source.historySnapshot();
        await source.transactHistory({
          expectedRevision: current.revision,
          keep: current.total,
          items: [{ type: 'application-audit', payload: { kept: '😀' } }],
        });
        savedSource = await portableDataCopy(
          (await source.historySnapshot()).items,
        );
        childId = await source.forkStored();
      } finally {
        await source.close();
      }
      const child = await agent.session({ storage, resume: childId! });
      let savedChild: Awaited<ReturnType<typeof child.saveState>>;
      let expectedChild: Awaited<ReturnType<typeof child.historySnapshot>>;
      let grandchildId: string;
      try {
        expectedChild = await child.historySnapshot();
        savedChild = await portableDataCopy(expectedChild.items);
        grandchildId = await child.forkStored();
      } finally {
        await child.close();
      }
      if (revertSource) {
        await using original = await agent.session({
          storage,
          resume: sourceId,
        });
        await original.revertStored({ beforeTurnId: turnIds![1]! });
      }
      {
        await using original = await agent.session({
          storage,
          resume: sourceId,
        });
        await expect(original.deleteStored()).rejects.toThrow();
      }
      {
        await using original = await agent.session({
          storage,
          resume: sourceId,
        });
        await original.deleteStored({ preserveDescendants: true });
      }
      await expect(
        agent.session({ storage, resume: sourceId }),
      ).rejects.toThrow();
      {
        await using reader = await agent.session({ storage });
        const ids = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await reader.storedSessions({ limit: 1, cursor });
          for (const item of page.sessions) ids.add(item.id);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        expect(ids.has(sourceId)).toBe(false);
        expect(ids.has(childId!)).toBe(true);
        expect(ids.has(grandchildId!)).toBe(true);
      }
      for (const identity of [childId!, grandchildId!]) {
        await using restored = await agent.session({
          storage,
          resume: identity,
        });
        expect(restored.id).toBe(identity);
        const raw = (await restored.historySnapshot()).items;
        expect(raw.slice(0, expectedChild!.total)).toEqual(
          expectedChild!.items,
        );
        expect(JSON.stringify(raw)).toContain(output);
        const turns: string[] = [];
        for await (const turn of restored.turns()) turns.push(turn.id);
        expect(turns).toEqual(turnIds!);
      }
      // Exported copies have isolated memory ownership, without local resume authority.
      for (const state of [savedSource!, savedChild!]) {
        await using portable = await agent.session({ state });
        const raw = JSON.stringify((await portable.historySnapshot()).items);
        expect(raw).toContain(output);
        expect(raw).toContain('application-audit');
      }
      {
        await using restored = await agent.session({
          storage,
          resume: childId!,
        });
        expect(
          (await (await restored.submit('continue-marker')).wait()).finalOutput,
        ).toBe('continued');
      }
      expect(effects).toEqual(['read']);
      expect(server.requests).toHaveLength(4);
    } finally {
      await ModelServer.closeAll();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
