import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  runWorkerTurn,
  runWorkerText,
  standaloneTool,
  transactWorkerHistory,
} from '../src/runtime/workerd';
import { historyFixture, historyStore } from './fixtures/worker-history';

const asset = new URL('../native/codex-turn-control.wasm', import.meta.url);
it.skipIf(!existsSync(asset))(
  'reads, appends, pops and clears through native cold history',
  async () => {
    const control = new WebAssembly.Module(await readFile(asset));
    const result = await historyFixture(() => control);
    expect(result.requests).toHaveLength(3);
    expect(result.commits).toBe(6);
  },
);

it.skipIf(!existsSync(asset))(
  'rejects stale revisions and invalid pairs before any write',
  async () => {
    const control = new WebAssembly.Module(await readFile(asset));
    const owner = historyStore(),
      options = { control, session: owner.session };
    await transactWorkerHistory(
      {
        type: 'append',
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'owned' }],
          },
        ],
      },
      options,
    );
    const stored = owner.stored();
    await expect(
      transactWorkerHistory(
        { type: 'clear' },
        { ...options, expectedRevision: 0 },
      ),
    ).rejects.toThrow('revision changed');
    await expect(
      transactWorkerHistory(
        {
          type: 'append',
          items: [
            {
              type: 'function_call',
              call_id: 'forged',
              name: 'forged',
              arguments: '{}',
            },
          ],
        },
        options,
      ),
    ).rejects.toThrow('unresolved calls');
    expect(owner.stored()).toBe(stored);
    expect(owner.commits()).toBe(1);
    expect(owner.held()).toBe(null);
  },
);

it.skipIf(!existsSync(asset))(
  'reads pending approval passively and rejects every mutation without tool effects',
  async () => {
    const control = new WebAssembly.Module(await readFile(asset));
    const owner = historyStore();
    let effects = 0;
    const tool = standaloneTool({
      name: 'approval',
      parameters: z.object({}),
      execute() {
        effects++;
        return 'effect';
      },
    });
    const paused = await runWorkerTurn('pause', {
      control,
      session: owner.session,
      model: 'fixture',
      instructions: '',
      tools: [tool],
      approve: { approval: () => null },
      provider: {
        complete() {
          return {
            output: [
              {
                type: 'function_call',
                name: 'approval',
                call_id: 'approval-1',
                arguments: '{}',
              },
            ],
          };
        },
      },
    });
    expect(paused.type).toBe('approval');
    const stored = owner.stored(),
      commits = owner.commits(),
      options = { control, session: owner.session };
    const read = await transactWorkerHistory({ type: 'read' }, options);
    expect(read.pendingApproval).toBe(true);
    expect(owner.commits()).toBe(commits);
    for (const operation of [
      { type: 'append', items: [] },
      { type: 'pop' },
      { type: 'clear' },
    ] as const)
      await expect(transactWorkerHistory(operation, options)).rejects.toThrow(
        'cannot change',
      );
    expect(owner.stored()).toBe(stored);
    expect(effects).toBe(0);
    expect(owner.held()).toBe(null);
  },
);

it.skipIf(!existsSync(asset))(
  'keeps the committed checkpoint after a failed conditional write and releases the owner',
  async () => {
    const control = new WebAssembly.Module(await readFile(asset));
    const owner = historyStore();
    const failure = Error('backend conflict');
    await runWorkerText('seed', {
      control,
      session: owner.session,
      model: 'fixture',
      instructions: '',
      provider: {
        complete() {
          return {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'answer' }],
              },
            ],
          };
        },
      },
    });
    const stored = owner.stored();
    const store = {
      ...owner.session.store,
      async commit() {
        throw failure;
      },
    };
    await expect(
      transactWorkerHistory(
        { type: 'clear' },
        { control, session: { ...owner.session, store } },
      ),
    ).rejects.toBe(failure);
    expect(owner.stored()).toBe(stored);
    expect(owner.held()).toBe(null);
  },
);
