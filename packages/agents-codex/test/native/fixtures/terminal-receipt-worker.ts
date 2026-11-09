// Uses the public APIs and real durable adapter from custom-storage-worker.ts.
import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import { Agent, NativeProvider, fileSessionStore, tool } from '../../../src';
const config = JSON.parse(process.argv[2]) as {
  directory: string;
  effects: string;
  url: string;
  resume?: string;
  holdReceipt: boolean;
};
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: 'synthetic-terminal-receipt',
  supportsWebsockets: false,
});
async function main() {
  try {
    const durable = fileSessionStore(config.directory);
    const storage = {
      ...durable,
      commit: async (...args: Parameters<typeof durable.commit>) => {
        await durable.commit(...args);
        const snapshot = JSON.parse(args[4]);
        const accepted = snapshot.mutations.some(
          (mutation: {
            items?: {
              type?: string;
              payload?: { type?: string; call_id?: string };
            }[];
          }) =>
            mutation.items?.some(
              (item) =>
                item.type === 'response_item' &&
                item.payload?.type === 'function_call_output' &&
                item.payload.call_id === 'accepted-before-crash',
            ),
        );
        if (
          config.holdReceipt &&
          accepted &&
          !args[4].includes('"tool_completion":{')
        ) {
          process.send?.({ type: 'durable-receipt' });
          // The parent kills this writer after observing the durable result. Core cannot reserve a terminal result before this returns.
          await new Promise<void>(() => {});
        }
      },
    };
    const agent = new Agent({
      instructions: 'Run.',
      model: 'gpt-5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.string().transform(validateText),
      },
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: async () => {
            await appendFile(config.effects, 'effect\n');
            return JSON.stringify('accepted once');
          },
        }),
      ],
    });
    function validateText(value: string): string {
      // The transform stays synchronous, matching the owning output API.
      process.send?.({ type: 'validated', value });
      return value;
    }
    await using session = await agent.session({
      storage,
      resume: config.resume,
    });
    process.send?.({
      type: 'opened',
      id: session.id,
      restoredTurn: session.restoredTurn !== null,
    });
    const result = await (await session.submit('Continue.')).wait();
    process.send?.({
      type: 'result',
      value: result.finalOutput,
      terminal: result.toolCall !== undefined,
    });
  } catch (error) {
    process.send?.({ type: 'failure', message: String(error) });
    process.exitCode = 1;
  } finally {
    await provider.close();
    process.disconnect?.();
  }
}
void main();
