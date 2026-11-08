import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/classic/testing';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import {
  answer,
  applicationContext,
  reviewedFacts,
  routeSupport,
} from '../../../../examples/codex/migration/advanced/business';
import {
  classicSupport,
  continueClassic,
  runClassicExample,
} from '../../../../examples/codex/migration/advanced/classic';
import {
  startNativeFromReviewedFacts,
  runNativeExample,
} from '../../../../examples/codex/migration/advanced/native';

import { runClassicLookup } from '../../../../examples/codex/migration/classic';
import { runNativeLookup } from '../../../../examples/codex/migration/native';

const lookup = { orderId: 'ORDER-42' };
const final = JSON.stringify(answer);

// Use a conflicting order first so the lookup must consult typed customer context.
const lookupContext = {
  customerId: 'CUSTOMER-7',
  orders: [
    {
      customerId: 'CUSTOMER-8',
      orderId: 'ORDER-42',
      status: 'private',
      tracking: 'PRIVATE',
    },
    {
      customerId: 'CUSTOMER-7',
      orderId: 'ORDER-42',
      status: 'shipped',
      tracking: 'TRACK-42',
    },
  ],
};
const lookupAnswer = {
  orderId: 'ORDER-42',
  status: 'shipped',
  tracking: 'TRACK-42',
};

it('the optional classic import step preserves the read-only typed lookup', async () => {
  const model = new ScriptedModel([
    [functionCall('lookup_order', lookup, { callId: 'lookup' })],
    [assistantMessage(JSON.stringify(lookupAnswer))],
  ]);
  expect(await runClassicLookup(model, lookupContext)).toEqual(lookupAnswer);
  expect(JSON.stringify(model.calls[1].request.input)).toContain('TRACK-42');
  expect(JSON.stringify(model.calls[1].request.input)).not.toContain('PRIVATE');
  model.assertComplete();
});

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'the native walkthrough reads only the current customer order and returns typed output',
  async () => {
    await withScriptedResponses(
      [
        [toolCall('lookup_order', lookup, { callId: 'lookup' })],
        [text(JSON.stringify(lookupAnswer))],
      ],
      async (peer) => {
        expect(await runNativeLookup(peer.provider, lookupContext)).toEqual(
          lookupAnswer,
        );
        expect(JSON.parse(peer.toolOutput('lookup')!)).toEqual(lookupAnswer);
        expect(JSON.stringify(peer.requests)).not.toContain('PRIVATE');
      },
    );
  },
);

it('keeps next-turn routing in the application', () => {
  expect(routeSupport('shipping')).toBe('order-support');
  expect(routeSupport('refund')).toBe('refund-review');
  const refund = classicSupport(new ScriptedModel([]), 'refund');
  expect(refund.name).toBe('refund-review');
  expect(refund.tools).toEqual([]);
});

it('classic preserves typed tools, permission checks, and two-turn history', async () => {
  const model = new ScriptedModel([
    [functionCall('lookup_order', lookup, { callId: 'lookup-1' })],
    [functionCall('notify_customer', lookup, { callId: 'notify-1' })],
    [assistantMessage(final)],
    [functionCall('notify_customer', lookup, { callId: 'denied-1' })],
    [assistantMessage(final)],
  ]);
  const context = applicationContext();
  const result = await runClassicExample(model, context);
  expect(result.first).toEqual(answer);
  expect(result.second).toEqual(answer);
  expect(context.lookups).toEqual(['ORDER-42']);
  expect(JSON.stringify(model.calls[3].request.input)).toContain('TRACK-42');
  expect(JSON.stringify(model.calls[4].request.input)).toContain(
    'Notification was not sent',
  );
  expect(context.notifications).toEqual(['ORDER-42']);
  model.assertComplete();
});

// The separate qualification command creates this file with installed v0.21.0.
// Ordinary CI never downloads a historical SDK to manufacture the fixture.
it.skipIf(!process.env.MIGRATION_V0_RECORD)(
  'continues actual v0-produced RunState and history on classic',
  async () => {
    const saved = JSON.parse(
      await readFile(resolve(process.env.MIGRATION_V0_RECORD!), 'utf8'),
    );
    const model = new ScriptedModel([[assistantMessage(final)]]);
    const context = applicationContext();
    expect((await continueClassic(model, context, saved)).finalOutput).toEqual(
      answer,
    );
    expect(JSON.stringify(model.calls[0].request.input)).toContain('TRACK-42');
    expect(JSON.stringify(model.calls[0].request.input)).toContain(
      'notification:ORDER-42',
    );
    expect(context.lookups).toEqual([]);
    expect(context.notifications).toEqual([]);
    model.assertComplete();
  },
);

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native migration',
  () => {
    it('ports tools and permissions, then saves and restores its own conversation', async () => {
      await withScriptedResponses(
        [
          [toolCall('lookup_order', lookup, { callId: 'lookup-1' })],
          [toolCall('notify_customer', lookup, { callId: 'notify-1' })],
          [text(final)],
          [toolCall('notify_customer', lookup, { callId: 'denied-1' })],
          [text(final)],
          [text(final)],
        ],
        async (peer) => {
          const context = applicationContext();
          const result = await runNativeExample(peer.provider, context);
          expect(result).toEqual({
            first: answer,
            second: answer,
            recalled: answer,
          });
          expect(peer.toolOutput('notify-1')).toContain(
            'notification:ORDER-42',
          );
          expect(JSON.stringify(peer.requests[3].input)).toContain('TRACK-42');
          expect(peer.toolOutput('denied-1')).toBe(
            'Notification permission denied',
          );
          expect(JSON.stringify(peer.requests[5].input)).toContain('TRACK-42');
          expect(JSON.stringify(peer.requests[5].input)).toContain(
            'notification:ORDER-42',
          );
          expect(context.lookups).toEqual(['ORDER-42']);
          expect(context.notifications).toEqual(['ORDER-42']);
        },
      );
    });

    it('starts native from the current classic result, without its state', async () => {
      const model = new ScriptedModel([
        [functionCall('lookup_order', lookup, { callId: 'lookup-1' })],
        [functionCall('notify_customer', lookup, { callId: 'notify-1' })],
        [assistantMessage(final)],
        [functionCall('notify_customer', lookup, { callId: 'denied-1' })],
        [assistantMessage(final)],
      ]);
      const classic = await runClassicExample(model, applicationContext());
      model.assertComplete();
      await withScriptedResponses([[text(final)]], async (peer) => {
        const context = applicationContext();
        expect(
          (
            await startNativeFromReviewedFacts(
              peer.provider,
              classic.second,
              context,
            )
          ).finalOutput,
        ).toEqual(answer);
        expect(peer.requests[0].input).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              expect.objectContaining({ text: reviewedFacts(classic.second!) }),
            ]),
          }),
        );
        expect(JSON.stringify(peer.requests[0].input)).not.toContain(
          'notify-1',
        );
        expect(context.lookups).toEqual([]);
        expect(context.notifications).toEqual([]);
      });
    });

    it.skipIf(!process.env.MIGRATION_V0_RECORD)(
      'ports actual v0 facts directly and through continued classic to native',
      async () => {
        const saved = JSON.parse(
          await readFile(resolve(process.env.MIGRATION_V0_RECORD!), 'utf8'),
        );
        const model = new ScriptedModel([[assistantMessage(final)]]);
        const continued = await continueClassic(
          model,
          applicationContext(),
          saved,
        );
        model.assertComplete();
        await withScriptedResponses(
          [[text(final)], [text(final)]],
          async (peer) => {
            const context = applicationContext();
            // The application selects these validated business outputs for cutover.
            expect(
              (
                await startNativeFromReviewedFacts(
                  peer.provider,
                  saved.facts,
                  context,
                )
              ).finalOutput,
            ).toEqual(answer);
            expect(
              (
                await startNativeFromReviewedFacts(
                  peer.provider,
                  continued.finalOutput,
                  context,
                )
              ).finalOutput,
            ).toEqual(answer);
            for (const request of peer.requests) {
              expect(request.input).toContainEqual(
                expect.objectContaining({
                  role: 'user',
                  content: expect.arrayContaining([
                    expect.objectContaining({ text: reviewedFacts(answer) }),
                  ]),
                }),
              );
              expect(JSON.stringify(request.input)).not.toContain('notify-1');
              expect(JSON.stringify(request.input)).not.toContain('denied-1');
            }
            expect(context.lookups).toEqual([]);
            expect(context.notifications).toEqual([]);
          },
        );
      },
    );
  },
);
