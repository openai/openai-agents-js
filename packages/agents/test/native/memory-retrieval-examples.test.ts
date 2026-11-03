import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '@openai/agents';
import {
  FactStore,
  saveFact,
  recallFact,
  forgetFact,
  memoryAgent,
  runPersistentMemory,
} from '../../examples/persistent-memory';
import {
  answerQuestion,
  checkSources,
  search,
  type RetrievalScope,
} from '../../examples/retrieval';
import { invokeFunctionTool } from '../../src/runtime/tools';
import type { FunctionTool } from '../../src/runtime/tools';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

// Node 22 warns when SQLite is first imported. Expect only that import diagnostic;
// restore normal warning handling before any test executes.
const restoreSqliteWarning = vi.hoisted(() => {
  const emitWarning = process.emitWarning;
  const warning = vi
    .spyOn(process, 'emitWarning')
    .mockImplementation((...args: unknown[]) => {
      if (
        args[0] ===
          'SQLite is an experimental feature and might change at any time' &&
        args[1] === 'ExperimentalWarning' &&
        args.slice(2).every((argument) => argument === undefined)
      )
        return;
      Reflect.apply(emitWarning, process, args);
    });
  return () => warning.mockRestore();
});
restoreSqliteWarning();

function invoke<Context>(
  tool: FunctionTool<Context>,
  context: Context,
  args: JsonObject = {},
) {
  return invokeFunctionTool(
    tool,
    args,
    {
      context,
      submission: {
        sessionId: 'session',
        childId: 'child',
        instanceId: '1',
        turnId: 'turn',
        submissionId: 'submission',
      },
      threadId: 'session',
      turnId: 'turn',
      callId: 'call',
      signal: new AbortController().signal,
    },
    vi.fn(),
  );
}
function value(result: Awaited<ReturnType<typeof invoke>>) {
  const item = result.contentItems[0];
  if (item?.type !== 'inputText') throw new Error('Expected text result');
  return JSON.parse(item.text);
}
function toolOutput(server: ModelServer, callId: string): string | undefined {
  for (const request of server.requests) {
    const input = request.input;
    if (!Array.isArray(input)) continue;
    for (const item of input) {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        item.type !== 'function_call_output' ||
        item.call_id !== callId
      )
        continue;
      if (typeof item.output === 'string') return item.output;
      if (Array.isArray(item.output))
        return item.output
          .flatMap((part) =>
            part &&
            typeof part === 'object' &&
            !Array.isArray(part) &&
            part.type === 'input_text' &&
            typeof part.text === 'string'
              ? [part.text]
              : [],
          )
          .join('');
    }
  }
  return undefined;
}
const directories: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), 'agents-memory-test-'));
  directories.push(directory);
  return join(directory, 'facts.sqlite');
}

describe('memory and retrieval examples without native execution', () => {
  it('closes an opened database when table initialization fails', async () => {
    const path = await databasePath();
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE existing (id TEXT); CREATE INDEX facts ON existing (id)',
    );
    database.close();
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    try {
      expect(() => new FactStore(path)).toThrow('index named facts');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  it('persists, isolates, overwrites and actually deletes a fact through the tools', async () => {
    const path = await databasePath();
    let memory = new FactStore(path);
    try {
      const userId = "alice' OR 1=1 --";
      await invoke(saveFact, { userId, memory }, { fact: 'First fact.' });
      await invoke(saveFact, { userId, memory }, { fact: 'Short answers.' });
      memory.close();
      memory = new FactStore(path);
      expect(value(await invoke(recallFact, { userId, memory }))).toEqual({
        fact: 'Short answers.',
      });
      expect(
        value(await invoke(recallFact, { userId: 'bob', memory })),
      ).toEqual({ fact: null });
      await invoke(saveFact, { userId: 'bob', memory }, { fact: 'Bob fact.' });
      await invoke(forgetFact, { userId, memory });
      memory.close();
      memory = new FactStore(path);
      expect(memory.recall(userId)).toBeNull();
      expect(memory.recall('bob')).toBe('Bob fact.');
    } finally {
      memory.close();
    }
  });
  it('rejects identity/path overrides and invalid facts before storage; propagates store failures', async () => {
    const memory = new FactStore(await databasePath());
    const save = vi.spyOn(memory, 'save');
    const context = { userId: 'alice', memory };
    try {
      await expect(
        invoke(saveFact, context, {
          fact: 'private',
          userId: 'bob',
          path: 'elsewhere',
        }),
      ).rejects.toThrow();
      await expect(invoke(saveFact, context, { fact: '  ' })).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();
    } finally {
      memory.close();
    }
    await expect(invoke(recallFact, context)).rejects.toThrow();
  });
  it('filters tenants, bounds passages and records only this run’s returned sources', async () => {
    const scope: RetrievalScope = {
      tenantId: 'tenant-a',
      retrieved: new Map(),
    };
    const result = value(await invoke(search, scope, { query: 'library' }));
    expect(
      result.passages.map((p: { sourceId: string }) => p.sourceId),
    ).toEqual(['a-hours', 'a-loans']);
    expect(result.passages.length).toBeLessThanOrEqual(2);
    for (const passage of result.passages)
      expect(Array.from(passage.passage).length).toBeLessThanOrEqual(240);
    expect([...scope.retrieved.keys()]).toEqual(['a-hours', 'a-loans']);
    const other: RetrievalScope = {
      tenantId: 'tenant-b',
      retrieved: new Map(),
    };
    expect(
      value(await invoke(search, other, { query: 'library' })).passages,
    ).toEqual([
      {
        sourceId: 'b-private',
        passage: 'Tenant B private library opens at 11:00.',
      },
    ]);
    const fresh: RetrievalScope = {
      tenantId: 'tenant-a',
      retrieved: new Map(),
    };
    expect(value(await invoke(search, fresh, { query: 'unfindable' }))).toEqual(
      { passages: [] },
    );
    await expect(
      invoke(search, fresh, { query: 'library', tenantId: 'tenant-b' }),
    ).rejects.toThrow();
    expect(fresh.retrieved.size).toBe(0);
    expect(() =>
      checkSources(
        { answer: 'Earlier result', sourceIds: ['a-hours'], found: true },
        fresh.retrieved,
      ),
    ).toThrow('unavailable sources');
    expect(
      checkSources(
        { answer: '09:00', sourceIds: ['a-hours'], found: true },
        scope.retrieved,
      ).found,
    ).toBe(true);
    expect(() =>
      checkSources(
        { answer: 'Invented', sourceIds: ['unknown'], found: true },
        scope.retrieved,
      ),
    ).toThrow();
    expect(() =>
      checkSources({ answer: '', sourceIds: [], found: true }, scope.retrieved),
    ).toThrow();
    expect(() =>
      checkSources(
        { answer: '', sourceIds: ['a-hours'], found: false },
        scope.retrieved,
      ),
    ).toThrow();
  });
});

async function options(server: ModelServer) {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  };
}
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native memory and retrieval examples',
  { timeout: 25000 },
  () => {
    it('runs the complete no-key memory command', async () => {
      await runPersistentMemory();
    });
    it('uses fresh Sessions and private application scope across a reopened database', async () => {
      const server = new ModelServer([
        [call('save_fact', { fact: 'Short answers.' }, { callId: 'save' })],
        [message('Saved.')],
        [call('recall_fact', {}, { callId: 'recall' })],
        [message('Recalled.')],
        [call('forget_fact', {}, { callId: 'forget' })],
        [message('Deleted.')],
      ]);
      const path = await databasePath();
      let memory = new FactStore(path);
      try {
        await using provider = new NativeProvider(await options(server));
        const agent = memoryAgent(provider);
        const userId = 'private-user-marker';
        await agent.run('Save.', { context: { userId, memory } });
        memory.close();
        memory = new FactStore(path);
        expect(memory.recall(userId)).toBe('Short answers.');
        await agent.run('Recall.', { context: { userId, memory } });
        expect(toolOutput(server, 'recall')).toBe(
          JSON.stringify({ fact: 'Short answers.' }),
        );
        expect(JSON.stringify(server.requests[2])).not.toContain(
          'Short answers.',
        );
        await agent.run('Forget.', { context: { userId, memory } });
        expect(toolOutput(server, 'save')).toBe('{"saved":true}');
        expect(toolOutput(server, 'forget')).toBe('{"forgotten":true}');
        expect(memory.recall(userId)).toBeNull();
        expect(JSON.stringify(server.requests)).not.toContain(userId);
        expect(JSON.stringify(server.requests)).not.toContain(path);
        server.assertExhausted();
      } finally {
        memory.close();
      }
    });
    it.each(['a-hours', 'invented'])(
      'checks settled source membership: %s',
      async (sourceId) => {
        const server = new ModelServer([
          [call('search', { query: 'opens' }, { callId: 'search' })],
          [
            message(
              JSON.stringify({
                answer: '09:00',
                sourceIds: [sourceId],
                found: true,
              }),
            ),
          ],
        ]);
        const result = answerQuestion(
          'Opening time?',
          'tenant-a',
          await options(server),
        );
        if (sourceId === 'invented')
          await expect(result).rejects.toThrow('unavailable sources');
        else
          await expect(result).resolves.toEqual({
            answer: '09:00',
            sourceIds: ['a-hours'],
            found: true,
          });
        expect(JSON.parse(toolOutput(server, 'search')!)).toEqual({
          passages: [
            {
              sourceId: 'a-hours',
              passage: 'The sample library opens at 09:00 on weekdays.',
            },
          ],
        });
        expect(JSON.stringify(server.requests)).not.toContain('b-private');
        server.assertExhausted();
      },
    );
    it('returns a missing result with no sources', async () => {
      const server = new ModelServer([
        [call('search', { query: 'unfindable' }, { callId: 'missing' })],
        [
          message(
            '{"answer":"No matching passage.","sourceIds":[],"found":false}',
          ),
        ],
      ]);
      await expect(
        answerQuestion('Unknown?', 'tenant-a', await options(server)),
      ).resolves.toEqual({
        answer: 'No matching passage.',
        sourceIds: [],
        found: false,
      });
      expect(toolOutput(server, 'missing')).toBe('{"passages":[]}');
      server.assertExhausted();
    });
  },
);
