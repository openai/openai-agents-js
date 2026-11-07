import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import { recordRecoveryIntent } from '../../../../../examples/codex/custom-storage-recovery';
import {
  Agent,
  NativeProvider,
  fileSessionStore,
  localStorage,
  tool,
} from '../../../src';

const config = JSON.parse(process.argv[2]) as {
  directory: string;
  effects: string;
  intentPath?: string;
  url: string;
  resume?: string;
  mode:
    | 'hold-open'
    | 'hold-effect'
    | 'hold-intent'
    | 'hold-abort'
    | 'run'
    | 'local-intent-fail'
    | 'local-result-fail';
  local?: boolean;
  label?: string;
  apiKey?: string;
};
if (config.local) process.on('SIGXFSZ', () => {});
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: config.apiKey ?? 'synthetic-custom-storage',
  supportsWebsockets: false,
});
const agent = new Agent({
  instructions: 'Use record when requested.',
  model: 'gpt-5',
  provider,
  tools: [
    tool({
      name: 'record',
      description: 'Record one application effect.',
      parameters: z.object({}),
      execute: async (_args, { signal, threadId, turnId, callId }) => {
        if (config.intentPath)
          await recordRecoveryIntent(config.intentPath, {
            sessionId: threadId,
            turnId,
            callId,
            businessKey: 'synthetic-order',
          });
        await appendFile(config.effects, (config.label ?? 'effect') + '\n');
        process.send?.({ type: 'effect' });
        if (config.mode === 'hold-effect') await new Promise(() => {});
        if (config.mode === 'hold-abort')
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted)
              reject(new Error('callback canceled after effect'));
            else
              signal.addEventListener(
                'abort',
                () => reject(new Error('callback canceled after effect')),
                { once: true },
              );
          });
        if (config.mode === 'local-result-fail')
          execFileSync('/usr/bin/prlimit', [
            '--pid',
            String(process.pid),
            '--fsize=0:unlimited',
          ]);
        return 'recorded';
      },
    }),
  ],
});
async function main() {
  try {
    const durable = fileSessionStore(config.directory);
    const custom =
      config.mode === 'hold-intent'
        ? {
            ...durable,
            commit: async (...args: Parameters<typeof durable.commit>) => {
              await durable.commit(...args);
              const snapshot = JSON.parse(args[4]);
              if (
                snapshot.mutations.some((mutation: any) =>
                  mutation.items?.some(
                    (item: any) =>
                      item.type === 'response_item' &&
                      item.payload?.type === 'function_call',
                  ),
                )
              ) {
                process.send?.({ type: 'durable-intent' });
                // The intent is durable, but application tool code has not run.
                await new Promise(() => {});
              }
            },
          }
        : durable;
    const session = await agent.session({
      storage: config.local ? localStorage(config.directory) : custom,
      resume: config.resume,
    });
    if (config.mode === 'hold-abort')
      process.once('message', () => {
        void session.close().then(
          () => process.send?.({ type: 'joined-close' }),
          (error) =>
            process.send?.({ type: 'close-error', message: String(error) }),
        );
      });
    const history = async () => {
      const items = [];
      for await (const item of session.items()) items.push(item);
      return items;
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
        const turn = await session.submit('Record if requested.');
        process.send?.({ type: 'submitted', turnId: turn.turnId });
        const result = await turn.wait();
        process.send?.({
          type: 'result',
          output: result.finalOutput,
          history: await history(),
        });
      }
    } catch (error) {
      process.send?.({ type: 'turn-error', message: String(error) });
      try {
        await (await session.submit('Must remain failed.')).wait();
      } catch (later) {
        process.send?.({ type: 'sticky-error', message: String(later) });
      }
      throw error;
    } finally {
      await session.close().catch(async (error) => {
        process.send?.({ type: 'close-error', message: String(error) });
        if (config.local)
          await session.close().then(
            () => process.send?.({ type: 'repeated-close-success' }),
            (later) =>
              process.send?.({
                type: 'repeated-close-error',
                message: String(later),
              }),
          );
        throw error;
      });
    }
    await provider.close();
    process.send?.({ type: 'done' });
  } catch (error) {
    if (config.local)
      execFileSync(
        '/usr/bin/prlimit',
        ['--pid', String(process.pid), '--fsize=unlimited:unlimited'],
        { stdio: 'pipe' },
      );
    process.send?.({ type: 'failure', message: String(error) });
    await provider.close().catch(() => {});
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}
void main();
