import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@openai/agents';
import { SQLiteMemory } from '@openai/agents/memory';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';

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

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agents-packaged-memory-'));
  directories.push(directory);
  return join(directory, 'facts.sqlite');
}

describe('packaged scoped memory', () => {
  it.each([
    ['high surrogate', '\ud800', '\ufffd'],
    ['low surrogate', '\udfff', '\ufffd'],
    ['embedded surrogate', 'before\ud800after', 'before\ufffdafter'],
  ])(
    'rejects %s before SQLite can alias scopes or keys or change values',
    async (_name, malformed, replacement) => {
      const path = await databasePath();
      const unopened = join(path, '..', 'unopened.sqlite');
      expect(() => new SQLiteMemory(unopened, { scope: malformed })).toThrow(
        /well-formed Unicode/,
      );
      expect(existsSync(unopened)).toBe(false);
      using protectedScope = new SQLiteMemory(path, { scope: replacement });
      protectedScope.set('secret', 'Protected scope value');
      expect(() => {
        using invalidScope = new SQLiteMemory(path, { scope: malformed });
        return invalidScope.get('secret');
      }).toThrow(/well-formed Unicode/);
      using memory = new SQLiteMemory(path, { scope: 'alice' });
      memory.set(replacement, 'Protected key value');
      memory.set('value', 'Previous value');
      expect(() => memory.get(malformed)).toThrow(/well-formed Unicode/);
      expect(() => memory.set(malformed, 'Overwrite')).toThrow(
        /well-formed Unicode/,
      );
      expect(() => memory.delete(malformed)).toThrow(/well-formed Unicode/);
      expect(memory.get(replacement)).toBe('Protected key value');
      expect(() => memory.set('value', malformed)).toThrow(
        /well-formed Unicode/,
      );
      expect(memory.get('value')).toBe('Previous value');
      expect(protectedScope.get('secret')).toBe('Protected scope value');
    },
  );

  it.each(['UTF-8', 'UTF-16'])(
    'preserves non-BMP characters, replacement characters and empty values through reopen (%s)',
    async (encoding) => {
      const path = await databasePath();
      const database = new DatabaseSync(path);
      try {
        database.exec(
          `PRAGMA encoding='${encoding}'; CREATE TABLE seed(value TEXT)`,
        );
      } finally {
        database.close();
      }
      const scope = 'user-\0🚀-\ufffd';
      const key = 'key-\0𝄞-\ufffd';
      const value = 'value-\0😀-\ufffd';
      {
        using memory = new SQLiteMemory(path, { scope });
        memory.set(key, value);
        memory.set('empty', '');
      }
      using reopened = new SQLiteMemory(path, { scope });
      expect(reopened.scope).toBe(scope);
      expect(reopened.get(key)).toBe(value);
      expect(reopened.get('empty')).toBe('');
      using differentScope = new SQLiteMemory(path, {
        scope: 'user-\0\ufffd-\ufffd',
      });
      expect(differentScope.get(key)).toBeNull();
    },
  );

  it('binds SQL parameters, preserves empty values, validates bounds, and closes', async () => {
    const path = await databasePath();
    using alice = new SQLiteMemory(path, { scope: 'alice' });
    using bob = new SQLiteMemory(path, { scope: 'bob' });
    const key = "x'; DELETE FROM agents_memory; --";
    alice.set(key, '');
    bob.set(key, 'Other');
    expect(alice.get(key)).toBe('');
    alice.delete(key);
    alice.delete(key);
    expect(bob.get(key)).toBe('Other');
    expect(Reflect.set(alice, 'scope', 'bob')).toBe(false);
    expect(alice.scope).toBe('alice');
    for (const key of ['', ' ', 'x'.repeat(257)]) {
      expect(() => alice.set(key, 'value')).toThrow();
    }
    expect(() => alice.set('key', 'x'.repeat(65_537))).toThrow();
    expect(() => new SQLiteMemory(path, { scope: ' ' })).toThrow();
    alice.close();
    alice.close();
    expect(() => alice.get('key')).toThrow('closed');
  });
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native packaged memory',
  () => {
    it('saves, fully closes, reopens, isolates scopes and durably deletes through public tools', async () => {
      const path = await databasePath();
      await withScriptedResponses(
        [
          [
            toolCall(
              'memory_set',
              { key: 'preference', value: 'Plain language' },
              { callId: 'save' },
            ),
          ],
          [text('Saved')],
          [toolCall('memory_get', { key: 'preference' }, { callId: 'recall' })],
          [text('Recalled')],
          [
            toolCall(
              'memory_get',
              { key: 'preference' },
              { callId: 'other-scope' },
            ),
          ],
          [text('Absent')],
          [
            toolCall(
              'memory_delete',
              { key: 'preference' },
              { callId: 'delete' },
            ),
          ],
          [text('Deleted')],
          [
            toolCall(
              'memory_get',
              { key: 'preference' },
              { callId: 'after-delete' },
            ),
          ],
          [text('Absent')],
        ],
        async (peer) => {
          for (const [scope, prompt] of [
            ['alice', 'Save'],
            ['alice', 'Recall'],
            ['bob', 'Recall'],
            ['alice', 'Delete'],
            ['alice', 'Recall'],
          ]) {
            using memory = new SQLiteMemory(path, { scope });
            const tools = memory.tools();
            for (const declaration of tools) {
              const parameters = declaration.parameters;
              if (
                parameters === null ||
                typeof parameters !== 'object' ||
                Array.isArray(parameters)
              ) {
                throw new Error('Expected an object tool schema');
              }
              const properties = parameters.properties;
              if (
                properties === null ||
                typeof properties !== 'object' ||
                Array.isArray(properties)
              ) {
                throw new Error('Expected tool schema properties');
              }
              expect(Object.keys(properties)).toEqual(
                declaration.name === 'memory_set' ? ['key', 'value'] : ['key'],
              );
              expect(parameters.additionalProperties).toBe(false);
            }
            await new Agent({
              instructions: 'Use memory.',
              provider: peer.provider,
              tools,
            }).run(prompt);
          }
          expect(peer.toolOutput('recall')).toBe('Plain language');
          expect(peer.toolOutput('other-scope')).toBe('null');
          expect(peer.toolOutput('after-delete')).toBe('null');
          peer.assertExhausted();
        },
      );
      using reopened = new SQLiteMemory(path, { scope: 'alice' });
      expect(reopened.get('preference')).toBeNull();
    }, 20_000);

    it('preserves distinct keys written by a parallel native tool batch', async () => {
      using memory = new SQLiteMemory(await databasePath(), { scope: 'alice' });
      await withScriptedResponses(
        [
          Array.from({ length: 8 }, (_, index) =>
            toolCall(
              'memory_set',
              { key: `key-${index}`, value: `value-${index}` },
              { callId: `save-${index}` },
            ),
          ),
          [text('Saved')],
        ],
        async (peer) => {
          await new Agent({
            instructions: 'Save.',
            provider: peer.provider,
            tools: memory.tools(),
          }).run('Save');
          peer.assertExhausted();
        },
      );
      expect(
        Array.from({ length: 8 }, (_, index) => memory.get(`key-${index}`)),
      ).toEqual(Array.from({ length: 8 }, (_, index) => `value-${index}`));
    }, 20_000);
  },
);
