import assert from 'node:assert/strict';
import { Agent, ToolOutput, tool, type ToolContext } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

export interface Writer {
  write(tenantId: string, requestId: string): Promise<void>;
}

/** Process-local demo only. Production writers own durable deduplication. */
export class FakeWriter implements Writer {
  readonly ledger = new Map<string, Set<string>>();
  async write(tenantId: string, requestId: string) {
    let keys = this.ledger.get(tenantId);
    if (!keys) this.ledger.set(tenantId, (keys = new Set()));
    keys.add(requestId);
  }
}

export function effectContext(
  writer: Writer,
  tenantId: string,
  requestId: string,
) {
  return {
    writer,
    tenantId,
    requestId,
    entered: Promise.withResolvers<void>(),
    cleanupStarted: Promise.withResolvers<void>(),
    cleanupRelease: Promise.withResolvers<void>(),
    cleanupHasStarted: false,
    cleaned: false,
  };
}
export type EffectContext = ReturnType<typeof effectContext>;

export const writeRecord = tool({
  name: 'write_record',
  description:
    'Write the application-selected record, then demonstrate a failure mode.',
  parameters: z.strictObject({
    mode: z.enum(['ok', 'error', 'raise', 'wait']),
  }),
  execute: async (
    { mode },
    { context: app, signal }: ToolContext<EffectContext>,
  ) => {
    await app.writer.write(app.tenantId, app.requestId);
    if (mode === 'error')
      return new ToolOutput(
        [{ type: 'inputText', text: 'Synthetic failure after write' }],
        false,
      );
    if (mode === 'raise') throw new Error('Synthetic exception after write');
    if (mode === 'wait') {
      app.entered.resolve();
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      } finally {
        app.cleanupHasStarted = true;
        app.cleanupStarted.resolve();
        await app.cleanupRelease.promise;
        app.cleaned = true;
      }
    }
    return 'written';
  },
});

export async function runSafeEffects() {
  const writer = new FakeWriter();
  const context = effectContext(
    writer,
    'synthetic-tenant',
    'synthetic-request',
  );
  await withScriptedResponses(
    [
      [toolCall('write_record', { mode: 'ok' }, { callId: 'first' })],
      [toolCall('write_record', { mode: 'ok' }, { callId: 'retry' })],
      [text('Done.')],
    ],
    async (peer) => {
      await using session = await new Agent<EffectContext>({
        instructions: 'Write.',
        tools: [writeRecord],
        provider: peer.provider,
      }).session({ context });
      const turn = await session.submit('Write.');
      await turn.wait({
        until: 'request',
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(peer.toolOutput('first'), 'written');
      assert.equal(peer.toolOutput('retry'), 'written');
    },
  );
  assert.deepEqual(
    [...writer.ledger.get(context.tenantId)!],
    [context.requestId],
  );
  return writer;
}

if (typeof require !== 'undefined' && require.main === module) {
  runSafeEffects().then(
    () => console.log('The application writer recorded one effect.'),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
