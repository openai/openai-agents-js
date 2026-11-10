import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { inspect } from 'node:util';
import { z } from 'zod';
import {
  Agent,
  Environment,
  LocalRecoveryRequired,
  NativeAgents,
  NativeProvider,
  localStorage,
  tool,
  type ReconciledCall,
  type ToolContext,
} from '../../../src/index';
import { nativeDescendantModel } from './native-descendant-model';

const config = JSON.parse(process.argv[2]) as {
  profile: string;
  effects: string;
  url: string;
  executor: { url: string; cwd: string; headers: Record<string, string> };
  depth: number;
  mode: 'settled' | 'unknown' | 'active' | 'destination';
  resume?: string;
  reconciledCalls?: ReconciledCall[];
  inspectOnly?: boolean;
  noChildren?: boolean;
  writePolicy?: 'legacy';
};
const destination = config.mode === 'destination';
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: destination ? 'synthetic-destination' : 'synthetic-source',
  supportsWebsockets: false,
});
const agent = new Agent<string>({
  instructions: 'Record the requested work using current declarations.',
  model: nativeDescendantModel,
  provider,
  programmaticToolCalling: false,
  tools: [
    ...(!config.noChildren
      ? [new NativeAgents({ maxChildren: 2, maxDepth: 2 })]
      : []),
    tool({
      name: destination ? 'record_current' : 'record',
      parameters: z.object({ key: z.string() }),
      async execute({ key }, context: ToolContext<string>) {
        const file = openSync(config.effects, 'a');
        try {
          writeSync(file, `${context.context}:${key}\n`);
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
        process.send?.({ type: 'effect', key });
        if (config.mode === 'unknown') await new Promise(() => {});
        return context.context;
      },
    }),
  ],
});

async function main() {
  try {
    const storage = localStorage(config.profile);
    const persistence =
      config.resume === undefined
        ? { storage }
        : {
            storage,
            resume: config.resume,
            reconciledCalls: config.reconciledCalls,
          };
    const session = await agent.session({
      ...persistence,
      context: destination ? 'destination' : 'source',
      ...(config.noChildren
        ? {}
        : {
            environment: new Environment({
              ...config.executor,
              writePolicy: config.writePolicy,
              tools: ['exec_command', 'write_stdin', 'apply_patch'],
            }),
          }),
    });
    process.send?.({ type: 'opened', id: session.id, pid: process.pid });
    if (!config.inspectOnly) {
      const result = await (
        await session.submit('Run the requested operation.')
      ).wait();
      process.send?.({ type: 'root-result', output: result.finalOutput });
    }
    if (!destination) {
      // Wait via real public child handles. The source model creates one chain,
      // so newly discovered descendants can be joined without polling a runtime.
      const joined = new Set<string>();
      while (joined.size < config.depth) {
        let found = false;
        for await (const child of session.subagents()) {
          if (joined.has(child.id)) continue;
          if (child.turn) await child.turn.wait();
          else {
            const turns = [];
            for await (const turn of session.turns({ subagentId: child.id }))
              turns.push(turn);
            if (
              !turns.length ||
              turns.some((turn) => turn.status === 'in_progress')
            )
              throw new Error('Source child has no settled recorded turn');
          }
          joined.add(child.id);
          found = true;
        }
        if (!found)
          throw new Error('Source did not create the requested child chain');
      }
    } else {
      const children = [];
      for await (const child of session.subagents()) {
        if (child.isLive)
          throw new Error('Cold history started a child runtime');
        const turns = [];
        for await (const turn of session.turns({ subagentId: child.id }))
          turns.push(turn.id);
        const items = await Array.fromAsync(
          session.items({ subagentId: child.id }),
        );
        const completedText = JSON.stringify(
          items.filter(
            (item) =>
              item.type === 'message' &&
              item.role === 'assistant' &&
              item.status === 'completed',
          ),
        );
        children.push({
          id: child.id,
          turns,
          completedText,
          reconciled: items.filter(
            (item) =>
              item.type === 'function_call_output' && item.reconciliation,
          ),
        });
      }
      process.send?.({ type: 'history', children });
    }
    await session.close();
    await provider.close();
    process.send?.({ type: 'done' });
  } catch (error) {
    process.send?.({
      type: 'failure',
      message: error instanceof Error ? error.message : String(error),
      details: inspect(error, { depth: null }),
      ...(error instanceof LocalRecoveryRequired
        ? {
            calls: error.calls,
            turns: error.turns.map(({ id, status, subagentId }) => ({
              id,
              status,
              subagentId,
            })),
          }
        : {}),
    });
    try {
      await provider.close();
    } catch {
      /* Parent retains this process. */
    }
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}
void main();
