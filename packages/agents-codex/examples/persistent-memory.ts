import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Agent,
  tool,
  type NativeProvider,
  type ToolContext,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

const factSchema = z.string().trim().min(1).max(240);
const rowSchema = z.object({ fact: factSchema });

/** A tiny synchronous application store; requires Node.js 24. */
export class FactStore {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS facts (user_id TEXT PRIMARY KEY, fact TEXT NOT NULL)',
      );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  save(userId: string, fact: string): void {
    this.database
      .prepare(
        'INSERT INTO facts (user_id, fact) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET fact = excluded.fact',
      )
      .run(userId, factSchema.parse(fact));
  }
  recall(userId: string): string | null {
    const row = this.database
      .prepare('SELECT fact FROM facts WHERE user_id = ?')
      .get(userId);
    return row === undefined ? null : rowSchema.parse(row).fact;
  }
  forget(userId: string): void {
    this.database.prepare('DELETE FROM facts WHERE user_id = ?').run(userId);
  }
  close(): void {
    this.database.close();
  }
}
export interface MemoryScope {
  readonly userId: string;
  readonly memory: FactStore;
}
export const saveFact = tool({
  name: 'save_fact',
  description: 'Save one short fact for the current user.',
  parameters: z.strictObject({ fact: factSchema }),
  execute: ({ fact }, { context }: ToolContext<MemoryScope>) => {
    context.memory.save(context.userId, fact);
    return { saved: true };
  },
});
export const recallFact = tool({
  name: 'recall_fact',
  description: "Recall the current user's saved fact.",
  parameters: z.strictObject({}),
  execute: (_args, { context }: ToolContext<MemoryScope>) => ({
    fact: context.memory.recall(context.userId),
  }),
});
export const forgetFact = tool({
  name: 'forget_fact',
  description: "Delete the current user's saved fact.",
  parameters: z.strictObject({}),
  execute: (_args, { context }: ToolContext<MemoryScope>) => {
    context.memory.forget(context.userId);
    return { forgotten: true };
  },
});
/** The caller owns the borrowed provider and context store. */
export function memoryAgent(provider: NativeProvider): Agent<MemoryScope> {
  return new Agent<MemoryScope>({
    provider,
    instructions: 'Use the requested memory tool, then acknowledge its result.',
    tools: [saveFact, recallFact, forgetFact],
  });
}

/** No API key is needed; the scripted peer prescribes every response. */
export async function runPersistentMemory(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agents-facts-'));
  const path = join(directory, 'facts.sqlite');
  let memory: FactStore | undefined;
  try {
    const initial = (memory = new FactStore(path));
    await withScriptedResponses(
      [
        [
          toolCall(
            'save_fact',
            { fact: 'Prefers short explanations.' },
            { callId: 'save' },
          ),
        ],
        [text('Saved.')],
        [toolCall('recall_fact', {}, { callId: 'recall' })],
        [text('Recalled.')],
        [toolCall('forget_fact', {}, { callId: 'forget' })],
        [text('Deleted.')],
      ],
      async (peer) => {
        const agent = memoryAgent(peer.provider);
        // Authentication chooses this identity before each fresh one-shot Session.
        const userId = 'sample-user';
        await agent.run('Save the sample preference.', {
          context: { userId, memory: initial },
        });
        assert.equal(initial.recall(userId), 'Prefers short explanations.');
        initial.close();
        memory = undefined;
        const reopened = (memory = new FactStore(path));
        await agent.run('Recall my preference.', {
          context: { userId, memory: reopened },
        });
        assert.equal(
          peer.toolOutput('recall'),
          JSON.stringify({ fact: 'Prefers short explanations.' }),
        );
        await agent.run('Forget my preference.', {
          context: { userId, memory: reopened },
        });
        assert.equal(reopened.recall(userId), null);
        peer.assertExhausted();
      },
    );
  } finally {
    try {
      memory?.close();
    } finally {
      // A real caller retains its own private database path instead.
      await rm(directory, { recursive: true, force: true });
    }
  }
}
if (typeof require !== 'undefined' && require.main === module) {
  runPersistentMemory().then(
    () => console.log('Saved, reopened, recalled and deleted the sample fact.'),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
