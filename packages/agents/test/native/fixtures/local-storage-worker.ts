import { appendFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  localStorage,
  tool,
  type ToolContext,
} from '../../../src/index';

const config = JSON.parse(process.argv[2]) as {
  profile: string;
  effects: string;
  url: string;
  label: string;
  mode: 'run' | 'hold-effect' | 'hold-open';
  resume?: string;
  apiKey?: string;
};
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: config.apiKey ?? `synthetic-${config.label}`,
  supportsWebsockets: false,
});
const agent = new Agent<{ label: string }>({
  instructions:
    'Use the current managed record tool. Preserve conversation history.',
  model: 'gpt-5',
  provider,
  tools: [
    tool({
      name: 'record',
      description: 'Record one application effect.',
      parameters: z.object({}),
      execute: async (_args, { context }: ToolContext<{ label: string }>) => {
        await appendFile(config.effects, context.label + '\n');
        process.send?.({ type: 'effect' });
        if (config.mode === 'hold-effect') await new Promise(() => {});
        return context.label;
      },
    }),
  ],
});
async function main() {
  try {
    const session = await agent.session({
      storage: localStorage(config.profile),
      resume: config.resume,
      context: { label: config.label },
    });
    const history = async () => {
      const items = [];
      const turns = [];
      for await (const item of session.items()) items.push(item);
      for await (const turn of session.turns()) turns.push(turn);
      return { items, turns };
    };
    process.send?.({
      type: 'opened',
      id: session.id,
      history: await history(),
    });
    try {
      if (config.mode === 'hold-open') {
        await new Promise<void>((resolve) =>
          process.once('message', () => resolve()),
        );
      } else {
        const result = await (
          await session.submit('Use the record tool if requested.')
        ).wait();
        process.send?.({
          type: 'result',
          output: result.finalOutput,
          history: await history(),
        });
      }
    } finally {
      await session.close();
    }
    await provider.close();
    process.send?.({ type: 'done' });
  } catch (error) {
    process.send?.({
      type: 'failure',
      message: error instanceof Error ? error.message : String(error),
      details: inspect(error, { depth: null }),
    });
    try {
      await provider.close();
    } catch {
      /* The parent observes failure and owns the worker. */
    }
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}
void main();
