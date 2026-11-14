import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type Completed,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { isManualSessionState } from '../../src/runtime/state';

afterEach(() => ModelServer.closeAll());
async function provider(server: ModelServer) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-cold-prefix',
    supportsWebsockets: false,
  });
}
it.each(['live', 'trusted', 'repeated'] as const)(
  'retains accepted child prefix with authenticated cold restore (%s)',
  async (mode) => {
    const cold = mode !== 'live';
    const rootModel = new ModelServer([
      [call('nested_child', { input: 'child' }, { callId: 'outer' })],
      [message('root complete')],
    ]);
    const childModel = new ModelServer([
      [call('auto_effect', {}, { callId: 'auto' })],
      [call('approved_effect', {}, { callId: 'approved' })],
      [message('child complete')],
    ]);
    await using rootProvider = await provider(rootModel);
    await using childProvider = await provider(childModel);
    const effects: string[] = [];
    const extracted: Completed<string>[] = [];
    const child = new Agent({
      name: 'Child',
      instructions: 'Use both tools.',
      provider: childProvider,
      model: 'gpt-5.5',
      tools: [
        tool({
          name: 'auto_effect',
          parameters: z.object({}),
          execute: () => {
            effects.push('auto');
            return 'aborted by user';
          },
        }),
        tool({
          name: 'approved_effect',
          parameters: z.object({}),
          needsApproval: true,
          execute: () => {
            effects.push('approved');
            return 'accepted approved output';
          },
        }),
      ],
    });
    const root = new Agent({
      name: 'Root',
      instructions: 'Use the child.',
      provider: rootProvider,
      model: 'gpt-5.5',
      tools: [
        child.asTool({
          toolName: 'nested_child',
          returnItems: true,
          customOutputExtractor(result) {
            extracted.push(result);
            return result.finalOutput;
          },
        }),
      ],
    });
    const source = await root.session();
    let restored: Session | undefined;
    try {
      const original = await source.submit('start');
      const originalPending = await original.wait({ until: 'interaction' });
      if (!('requests' in originalPending))
        throw new Error('Expected child approval');
      expect(childModel.requests).toHaveLength(2);
      expect(JSON.stringify(childModel.requests[1].input)).toContain(
        'aborted by user',
      );
      expect(effects).toEqual(['auto']);
      expect(extracted).toHaveLength(0);
      let target = source;
      let active = original;
      let pending = originalPending;
      if (cold) {
        const authenticated = await source.suspend();
        expect(JSON.stringify(authenticated)).toContain('aborted by user');
        const untrusted = JSON.parse(JSON.stringify(authenticated));
        await expect(root.session({ state: untrusted })).rejects.toThrow(
          /authenticated SessionState/,
        );
        if (!isManualSessionState(authenticated))
          throw new Error('Expected manual state');
        const continuation =
          authenticated.manual_continuation.pending_manual.find(
            (entry) => entry.continuation !== undefined,
          )?.continuation;
        // z.custom retains the actual checkpoint-owned prefix for the mutation control.
        const prefix = z
          .object({
            state: z.object({
              manual_context: z.object({
                produced_items_prefix: z.custom<{ records: unknown[] }>(),
              }),
            }),
          })
          .parse(continuation).state.manual_context.produced_items_prefix;
        expect(prefix.records).toHaveLength(3);
        const records = prefix.records;
        prefix.records = [];
        try {
          await expect(root.session({ state: authenticated })).rejects.toThrow(
            /authenticated SessionState/,
          );
        } finally {
          prefix.records = records;
        }
        expect(rootModel.requests).toHaveLength(1);
        expect(childModel.requests).toHaveLength(2);
        expect(effects).toEqual(['auto']);

        await source.close();
        restored = await root.session({ state: authenticated });
        target = restored;
        if (!restored.restoredTurn)
          throw new Error('Expected restored root turn');
        active = restored.restoredTurn;
        const boundary = await active.wait({ until: 'interaction' });
        if (!('requests' in boundary))
          throw new Error('Expected restored child approval');
        pending = boundary;
        if (mode === 'repeated') {
          const second = await restored.suspend();
          await restored.close();
          restored = await root.session({ state: second });
          target = restored;
          if (!restored.restoredTurn)
            throw new Error('Missing repeated restored turn');
          active = restored.restoredTurn;
          const repeated = await active.wait({ until: 'interaction' });
          if (!('requests' in repeated))
            throw new Error('Missing repeated approval');
          pending = repeated;
        }
      }
      const approval = pending.requests.find(isFunctionApprovalRequest);
      if (!approval) throw new Error('Expected function approval');
      await target.respond(approval.approve());
      const result = await active.wait();
      expect(result.finalOutput).toBe('root complete');
      expect(result.runUsage.requests).toBe(5);
      expect(effects).toEqual(['auto', 'approved']);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].items?.map(({ item }) => item.type)).toEqual([
        'function_call',
        'function_call_output',
        'function_call',
        'function_call_output',
        'message',
      ]);
      const originalAutoOutput = extracted[0].items?.find(
        ({ item }) =>
          item.type === 'function_call_output' && item.callId === 'auto',
      );
      expect(originalAutoOutput).toBeDefined();
      expect(JSON.stringify(originalAutoOutput!.item.data)).toContain(
        'aborted by user',
      );
      await restored?.close();
      await source.close();
      const originalData = JSON.stringify(
        extracted[0].items!.map(({ item }) => item.data),
      );
      const replayModel = new ModelServer([
        [message('physical replay accepted')],
        [
          call(
            'approved_effect',
            {},
            { callId: 'historical-authority-attempt' },
          ),
        ],
      ]);
      await using replayProvider = await provider(replayModel);
      const reader = new Agent({
        provider: replayProvider,
        model: 'gpt-5.5',
        tools: [],
        instructions: 'Read historical data without old callable authority.',
      });
      await using fresh = await reader.session();
      const empty = await fresh.historySnapshot();
      const data = (JSON.parse(originalData) as Record<string, unknown>[]).map(
        (item, index) => ({ ...item, id: `native_child_${mode}_${index}` }),
      );
      await fresh.transactHistory({
        expectedRevision: empty.revision,
        keep: 0,
        items: data,
      });
      expect(
        (await (await fresh.submit('Read imported child data.')).wait())
          .finalOutput,
      ).toBe('physical replay accepted');
      const physical = JSON.stringify(replayModel.requests[0].input);
      expect(physical).toContain('aborted by user');
      expect(physical).toContain('accepted approved output');
      expect(physical).toContain('child complete');
      expect(physical).not.toContain('root complete');
      const denied = await fresh.submit('Attempt historical tool.', {
        toolNotFoundBehavior: 'raise_error',
      });
      await expect(denied.wait()).rejects.toThrow(
        /unsupported call|unknown|not available/i,
      );
      expect(effects).toEqual(['auto', 'approved']);
      expect(
        JSON.stringify(extracted[0].items!.map(({ item }) => item.data)),
      ).toBe(originalData);
      replayModel.assertExhausted();
      const receiptDirectory = process.env.NATIVE_CHILD_REPLAY_RECEIPTS_DIR;
      if (receiptDirectory) {
        await mkdir(receiptDirectory, { recursive: true });
        await writeFile(
          join(receiptDirectory, `${mode}.json`),
          JSON.stringify(
            {
              mode,
              sourceItems: JSON.parse(originalData),
              physicalRequests: replayModel.requests,
              effects,
              originalRequestCounts: {
                root: rootModel.requests.length,
                child: childModel.requests.length,
              },
              importedCanonicalIds: data.map((item) => item.id),
            },
            null,
            2,
          ) + '\n',
        );
      }

      rootModel.assertExhausted();
      childModel.assertExhausted();
    } finally {
      await restored?.close();
      await source.close();
    }
  },
  30_000,
);
