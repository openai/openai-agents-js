import { open } from 'node:fs/promises';
import { inspect } from 'node:util';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  type RecordedTurn,
  type SessionItem,
  localStorage,
  nativeGoals,
  tool,
} from '../../../src';

const config = JSON.parse(process.argv[2]) as {
  profile: string;
  url: string;
  resume?: string;
  effects?: string;
  mode: 'create' | 'inspect' | 'denied' | 'unknown' | 'recover' | 'continue';
};
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: 'synthetic-current-goals-worker',
  supportsWebsockets: false,
});
const effect = tool({
  name: 'effect',
  parameters: z.object({}),
  execute: async () => {
    if (config.mode !== 'unknown' || !config.effects)
      throw new Error('Effect must not replay');
    const file = await open(config.effects, 'a');
    try {
      await file.write('once\n');
      await file.sync();
    } finally {
      await file.close();
    }
    process.exit(67);
  },
});
const agent = new Agent({
  instructions: 'Manage only the requested native goal.',
  model: 'gpt-5.1-codex',
  provider,
  tools: [...(config.mode === 'denied' ? [] : [nativeGoals()]), effect],
});
async function main() {
  try {
    await using session = await agent.session({
      storage: localStorage(config.profile),
      resume: config.resume,
    });
    await new Promise<void>((resolve, reject) =>
      process.send?.({ id: session.id, pid: process.pid }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (config.mode === 'denied') {
      try {
        await session.goal();
        throw new Error('Denied native goal read succeeded');
      } catch (error) {
        if (!String(error).includes('current NativeGoals')) throw error;
        process.send?.({ id: session.id, denied: true, pid: process.pid });
      }
    } else {
      const turnsBefore: string[] = [];
      for await (const turn of session.turns()) turnsBefore.push(turn.id);
      const before = await session.goal();
      if (config.mode === 'create' || config.mode === 'unknown')
        await (await session.submit('Create the requested goal.')).wait();
      if (config.mode === 'continue')
        await (
          await session.submit('Explicitly continue the retained conversation.')
        ).wait();
      if (config.mode === 'inspect')
        await new Promise((resolve) => setTimeout(resolve, 50));
      const turnsAfter: string[] = [];
      const recordedTurns: RecordedTurn[] = [];
      for await (const turn of session.turns()) {
        turnsAfter.push(turn.id);
        recordedTurns.push(turn);
      }
      const items: SessionItem[] = [];
      for await (const item of session.items()) items.push(item);
      const goal = await session.goal();
      await new Promise<void>((resolve, reject) =>
        process.send?.(
          {
            id: session.id,
            before,
            turnsBefore,
            turnsAfter,
            goal,
            recordedTurns,
            items,
            pid: process.pid,
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
  } finally {
    await provider.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(inspect(error, { depth: 8 }) + '\n');
  process.exitCode = 1;
});
