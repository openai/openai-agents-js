import assert from 'node:assert/strict';
import { z } from 'zod';
import { Agent, tool, telemetry } from '../../../src';
import { text, toolCall, withScriptedResponses } from '../../../src/testing';

async function main() {
  await telemetry.configure({ traceProcessors: [{ onEvent() {} }] });
  try {
    const metadata = {
      flag: false,
      text: 'false',
      object: {},
      objectText: '{}',
      nested: { values: [1, '1', null] },
      'dotted.key': 'original',
    };
    const expected = structuredClone(metadata);
    const root = await telemetry.withTrace(
      { name: 'metadata.original', metadata },
      async (root) => {
        metadata.nested.values[0] = 'caller mutation';
        assert.deepEqual(root.traceMetadata, expected);
        const copy = root.traceMetadata!;
        (copy.nested as { values: unknown[] }).values[0] = 'readback mutation';
        assert.deepEqual(root.traceMetadata, expected);
        await telemetry.withSpan(
          { name: 'metadata.child', metadata: { child: true } },
          async (child) => assert.deepEqual(child.traceMetadata, expected),
        );
        await telemetry.withSpan(
          {
            name: 'metadata.detached',
            detached: true,
            metadata: { own: true },
          },
          async (child) => assert.deepEqual(child.traceMetadata, { own: true }),
        );
        return root;
      },
    );
    assert.deepEqual(root.traceMetadata, expected);
    await telemetry.withTrace(
      {
        name: 'metadata.same-id',
        parent: null,
        traceId: root.context.traceId,
        metadata: { other: true },
      },
      async (other) => {
        assert.deepEqual(other.traceMetadata, { other: true });
        await telemetry.withSpan(
          { name: 'metadata.explicit-parent', parent: root },
          async (child) => assert.deepEqual(child.traceMetadata, expected),
        );
      },
    );
    assert.deepEqual(root.traceMetadata, expected);

    const gate = Promise.withResolvers<void>();
    const delayed = await telemetry.withTrace(
      { name: 'metadata.task-a', metadata: { task: 'a' } },
      async () => ({
        task: gate.promise.then(() => {
          assert.deepEqual(telemetry.getCurrentSpan()?.traceMetadata, {
            task: 'a',
          });
        }),
      }),
    );
    await telemetry.withTrace(
      { name: 'metadata.task-b', metadata: { task: 'b' } },
      async (current) => {
        gate.resolve();
        await delayed.task;
        assert.deepEqual(current.traceMetadata, { task: 'b' });
      },
    );

    let callbackMetadata: unknown;
    let effects = 0;
    const read = tool({
      name: 'read_metadata',
      description: 'Inherited native root metadata.',
      parameters: z.object({}),
      execute: async () => {
        effects++;
        callbackMetadata = telemetry.getCurrentSpan()?.traceMetadata;
        return 'done';
      },
    });
    await withScriptedResponses(
      [
        [text('ready')],
        [toolCall('read_metadata', {}, { callId: 'metadata-read' })],
        [text('restored')],
      ],
      async (peer) => {
        const agent = new Agent({
          instructions: 'Answer.',
          model: 'gpt-5.5',
          provider: peer.provider,
          tools: [read],
        });
        const state = await telemetry.withTrace(
          {
            name: 'metadata.source',
            metadata: { canary: 'ROOT_METADATA_SOURCE_CANARY' },
          },
          async () => {
            const session = await agent.session();
            try {
              assert.equal(
                (await (await session.submit('first')).wait()).finalOutput,
                'ready',
              );
              return await session.saveState();
            } finally {
              await session.close();
            }
          },
        );
        assert(!JSON.stringify(state).includes('ROOT_METADATA_SOURCE_CANARY'));
        await telemetry.withTrace(
          { name: 'metadata.restored', metadata: { owner: 'restored' } },
          async () => {
            assert.equal(
              (await agent.run('continue', { state })).finalOutput,
              'restored',
            );
          },
        );
        assert.equal(effects, 1);
        assert.deepEqual(callbackMetadata, { owner: 'restored' });
      },
    );
    assert.equal((await telemetry.forceFlush()).status, 'success');
  } finally {
    await telemetry.shutdown({ timeoutMs: 1000 });
  }
  console.log('PASS native root metadata ownership');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
