import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  tool,
  setTracingDisabled,
} from '@openai/agents/classic';
import type { AgentInputItem, Session } from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
  modelResponder,
} from '@openai/agents/classic/testing';
import { SDKRunner } from '@openai/agents/migration';

/**
 * Application-owned demo storage in a private directory with one sequential writer.
 * Successful awaited writes survive ordinary restarts, not crashes or power loss.
 * The application owns file validation, access, retention, and cleanup.
 */
export async function openFileSession(
  path: string,
  sessionId: string,
): Promise<Session> {
  let initialItems: AgentInputItem[];
  try {
    initialItems = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    initialItems = [];
  }
  const memory = new MemorySession({ sessionId, initialItems });
  const persist = async () =>
    writeFile(path, JSON.stringify(await memory.getItems()));
  // MemorySession owns cloning and ordering. A failed write can follow an
  // in-memory mutation or a committed effect: stop and reconcile, never replay.
  return {
    getSessionId: () => memory.getSessionId(),
    getItems: (limit) => memory.getItems(limit),
    async addItems(items) {
      await memory.addItems(items);
      await persist();
    },
    async popItem() {
      const item = await memory.popItem();
      await persist();
      return item;
    },
    async clearSession() {
      await memory.clearSession();
      await persist();
    },
  };
}

/** Run one completed phase with a selected public Model and a real file effect. */
export async function runMigrationSessionPhase(
  phase: 'classic' | 'native' | 'restarted',
  session: Session,
  effectsPath: string,
) {
  setTracingDisabled(true);
  const effect = tool({
    name: 'effect',
    description: 'Record an application effect',
    parameters: z.object({ value: z.string() }),
    async execute({ value }) {
      await appendFile(effectsPath, `${value}\n`);
      return value;
    },
  });
  const retained = await session.getItems();
  const fresh =
    phase === 'classic'
      ? 'old user'
      : phase === 'native'
        ? 'new user'
        : 'again';
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.deepEqual(call.request.input, [
        ...retained,
        { type: 'message', role: 'user', content: fresh },
      ]);
      return phase === 'classic' || phase === 'native'
        ? [
            functionCall(
              'effect',
              { value: phase === 'classic' ? 'old' : 'new' },
              { callId: phase === 'classic' ? 'old-call' : 'new-call' },
            ),
          ]
        : [assistantMessage('continued')];
    }),
    ...(phase === 'classic' || phase === 'native'
      ? [modelResponse([assistantMessage('complete')])]
      : []),
  ]);
  const agent = new Agent({
    name: 'restart',
    instructions: 'Continue.',
    model,
    tools: [effect],
  });
  const result =
    phase === 'classic'
      ? await new Runner({ tracingDisabled: true }).run(agent, fresh, {
          session,
        })
      : await SDKRunner.run(agent, fresh, { context: {}, session });
  model.assertComplete();
  return result;
}

if (typeof require !== 'undefined' && require.main === module) {
  const [phase, path, effectsPath, sessionId] = process.argv.slice(2);
  if (
    (phase !== 'classic' && phase !== 'native' && phase !== 'restarted') ||
    !path ||
    !effectsPath ||
    !sessionId
  ) {
    console.error(
      'Usage: migration-session.ts <classic|native|restarted> <history-path> <effects-path> <session-id>',
    );
    process.exitCode = 1;
  } else {
    openFileSession(path, sessionId)
      .then(async (session) => {
        const result = await runMigrationSessionPhase(
          phase,
          session,
          effectsPath,
        );
        console.log(
          JSON.stringify({
            pid: process.pid,
            sessionId: await session.getSessionId(),
            stored: (await session.getItems()).length,
            newItems: result.newItems.length,
            history: result.history.length,
          }),
        );
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
