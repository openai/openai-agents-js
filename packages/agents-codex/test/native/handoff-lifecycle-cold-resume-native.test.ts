import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  parseSessionState,
  tool,
  type AgentLifecycleEvent,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([
  'hot',
  'trusted',
  'untrusted',
  'legacy',
  'wrong-turn',
  'wrong-profile',
] as const)(
  'keeps the handoff owner lifecycle across pending approval (%s)',
  async (mode) => {
    const events: string[] = [];
    let effects = 0;
    const lifecycle = (event: AgentLifecycleEvent<undefined>) => {
      events.push(`${event.kind}:${event.agent.name}`);
      if (event.kind === 'end') expect(event.output).toBe('done');
    };
    const server = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'handoff-b' })],
      [call('approved_effect', {}, { callId: 'approved-b' })],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-cold-lifecycle',
      supportsWebsockets: false,
    });
    const target = new Agent({
      name: 'B',
      model: 'gpt-5.5',
      instructions: 'Use the approved effect, then finish.',
      onLifecycle: lifecycle,
      tools: [
        tool({
          name: 'approved_effect',
          parameters: z.object({}),
          needsApproval: true,
          execute: () => {
            effects++;
            return 'accepted once';
          },
        }),
      ],
    });
    const source = new Agent({
      name: 'A',
      model: 'gpt-5.5',
      instructions: 'Transfer.',
      provider,
      handoffs: [target],
      onLifecycle: lifecycle,
    });
    async function approval(session: {
      interactions(): AsyncIterable<unknown>;
    }) {
      for await (const request of session.interactions())
        if (isFunctionApprovalRequest(request)) return request;
      throw Error('Missing B approval');
    }
    if (mode !== 'hot') {
      let serialized: string;
      {
        await using session = await source.session();
        await session.submit('Go.');
        await approval(session);
        expect(events).toEqual(['start:A', 'handoff:A', 'start:B']);
        expect(effects).toBe(0);
        serialized = JSON.stringify(await session.suspend());
      }
      if (
        mode === 'legacy' ||
        mode === 'wrong-turn' ||
        mode === 'wrong-profile'
      ) {
        const edited = JSON.parse(serialized);
        const marker = edited.manual_continuation._sdk_lifecycle_start;
        expect(marker).toMatchObject({
          profile: {
            profile_id: expect.any(String),
            epoch: expect.any(Number),
          },
        });
        if (mode === 'legacy')
          delete edited.manual_continuation._sdk_lifecycle_start;
        else if (mode === 'wrong-turn') marker.turn_id = 'different-turn';
        else marker.profile.epoch += 1;
        serialized = JSON.stringify(edited);
      }
      const saved = parseSessionState(
        serialized,
        mode === 'untrusted'
          ? {}
          : {
              expectedSha256: createHash('sha256')
                .update(serialized)
                .digest('hex'),
            },
      );
      if (mode === 'wrong-turn' || mode === 'wrong-profile') {
        await expect(source.session({ state: saved })).rejects.toThrow(
          /Lifecycle acknowledgment/,
        );
        expect(effects).toBe(0);
        expect(server.requests).toHaveLength(2);
        return;
      }
      await using resumed = await source.session({ state: saved });
      const request = await approval(resumed);
      expect(effects).toBe(0);
      await resumed.respond(request.approve());
      expect((await resumed.restoredTurn!.wait()).finalOutput).toBe('done');
      expect(await resumed.getActiveAgent()).toBe(target);
    } else {
      await using session = await source.session();
      const turn = await session.submit('Go.');
      const request = await approval(session);
      expect(effects).toBe(0);
      await session.respond(request.approve());
      expect((await turn.wait()).finalOutput).toBe('done');
      expect(await session.getActiveAgent()).toBe(target);
    }
    expect(effects).toBe(1);
    expect(server.requests).toHaveLength(3);
    const outputs = (
      server.requests[2].input as { type: string; call_id?: string }[]
    ).filter(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'approved-b',
    );
    expect(outputs).toHaveLength(1);
    expect(events).toEqual(
      mode === 'untrusted' || mode === 'legacy'
        ? ['start:A', 'handoff:A', 'start:B', 'start:B', 'end:B']
        : ['start:A', 'handoff:A', 'start:B', 'end:B'],
    );
    server.assertExhausted();
  },
  30_000,
);
