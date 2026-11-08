import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { MemorySession, Runner, RunState } from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/classic/testing';
import { parseSessionState } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { classicLookup } from '../../../../examples/codex/migration/classic';
import {
  answerSchema,
  nativeLookup,
} from '../../../../examples/codex/migration/native';

const facts = { orderId: 'ORDER-42', status: 'shipped', tracking: 'TRACK-42' };
const lookup = { orderId: facts.orderId };
const context = {
  customerId: 'CUSTOMER-7',
  orders: [
    { customerId: 'CUSTOMER-8', ...facts, tracking: 'PRIVATE' },
    { customerId: 'CUSTOMER-7', ...facts },
  ],
};

it('classic preserves the typed customer-scoped lookup and its actual tool result', async () => {
  const model = new ScriptedModel([
    [functionCall('lookup_order', lookup, { callId: 'lookup' })],
    [assistantMessage(JSON.stringify(facts))],
  ]);
  const result = await new Runner({ tracingDisabled: true }).run(
    classicLookup(model),
    'Where is ORDER-42?',
    { context },
  );
  expect(result.finalOutput).toEqual(facts);
  expect(
    result.newItems.find((item) => item.type === 'tool_call_output_item')
      ?.output,
  ).toEqual(facts);
  expect(JSON.stringify(model.calls)).not.toContain('PRIVATE');
  model.assertComplete();
});

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native preserves the typed lookup and restores its own checkpoint',
  async () => {
    await withScriptedResponses(
      [
        [toolCall('lookup_order', lookup, { callId: 'lookup' })],
        [text(JSON.stringify(facts))],
        [text(JSON.stringify(facts))],
      ],
      async (peer) => {
        const agent = nativeLookup(peer.provider);
        let checkpoint;
        {
          await using session = await agent.session({ context });
          expect(
            (await (await session.submit('Where is ORDER-42?')).wait())
              .finalOutput,
          ).toEqual(facts);
          expect(JSON.parse(peer.toolOutput('lookup')!)).toEqual(facts);
          checkpoint = JSON.stringify(await session.saveState());
        }
        await using restored = await agent.session({
          context,
          state: parseSessionState(checkpoint),
        });
        expect(
          (
            await (
              await restored.submit('Recall the order without tools.')
            ).wait()
          ).finalOutput,
        ).toEqual(facts);
        expect(JSON.stringify(peer.requests[2].input)).toContain('TRACK-42');
        expect(JSON.stringify(peer.requests)).not.toContain('PRIVATE');
      },
    );
  },
);

// Produced by this same small app under the separately installed v0.21.0 SDK.
// Ordinary CI never downloads a historical SDK to manufacture this record.
it.skipIf(
  !process.env.MIGRATION_V0_RECORD ||
    process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1',
)(
  'continues real v0 state on classic and cuts over direct and current classic facts',
  async () => {
    const saved = JSON.parse(
      await readFile(process.env.MIGRATION_V0_RECORD!, 'utf8'),
    );
    expect(saved.sdkVersion).toBe('0.21.0');
    const current = {
      ...facts,
      status: 'delivered',
      tracking: 'TRACK-CURRENT',
    };
    const model = new ScriptedModel([
      [
        functionCall('lookup_order', lookup, {
          callId: 'current-classic-lookup',
        }),
      ],
      [assistantMessage(JSON.stringify(current))],
    ]);
    const agent = classicLookup(model);
    const runner = new Runner({ tracingDisabled: true });
    const currentContext = {
      customerId: context.customerId,
      orders: [{ customerId: context.customerId, ...current }],
    };
    const reads = vi.spyOn(currentContext.orders, 'find');
    const hydrated = await RunState.fromString(agent, saved.state);
    expect(
      (await runner.run(agent, hydrated, { context: currentContext }))
        .finalOutput,
    ).toEqual(facts);
    expect(reads).not.toHaveBeenCalled(); // Completed v0 callbacks must not replay.
    expect(model.calls).toHaveLength(0);
    const session = new MemorySession({ initialItems: saved.history });
    const continued = await runner.run(
      agent,
      'Look up the current order again.',
      { context: currentContext, session },
    );
    expect(continued.finalOutput).toEqual(current);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.calls[0].request.input)).toContain('TRACK-42');
    model.assertComplete();
    await withScriptedResponses(
      [[text(JSON.stringify(facts))], [text(JSON.stringify(current))]],
      async (peer) => {
        const native = nativeLookup(peer.provider);
        for (const [index, selected] of [
          saved.facts,
          continued.finalOutput,
        ].entries()) {
          // The application reviews these fields; state and history never cross.
          const { orderId, status, tracking } = answerSchema.parse(selected);
          const input = `Reviewed order facts: ${JSON.stringify({ orderId, status, tracking })}. Recall without tools.`;
          expect(
            (await native.run(input, { context: currentContext })).finalOutput,
          ).toEqual(selected);
          const request = JSON.stringify(peer.requests[index].input);
          expect(request).toContain(tracking);
          expect(request).not.toContain('old-v0-lookup');
          expect(request).not.toContain('current-classic-lookup');
          expect(request).not.toContain('PRIVATE');
          expect(request).not.toContain('function_call');
          expect(peer.requests[index].input).toContainEqual(
            expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({ text: input }),
              ]),
            }),
          );
        }
        expect(JSON.stringify(peer.requests[1].input)).not.toContain(
          'TRACK-42',
        );
        expect(reads).toHaveBeenCalledTimes(1);
      },
    );
    reads.mockRestore();
  },
);
