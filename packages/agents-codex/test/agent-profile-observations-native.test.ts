import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, type AgentProfileChanged } from '../src';
import { ModelServer, call, message } from './native/fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt(
  'streams ordered committed changes with captured names before settlement',
  async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      execute: async () => {
        entered.resolve();
        await release.promise;
        return 'released';
      },
    });
    const model = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'ab' })],
      [call('transfer_to_b', {}, { callId: 'bb' })],
      [call('transfer_to_c', {}, { callId: 'bc' })],
      [call('hold', {}, { callId: 'hold' })],
      [message('done')],
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-observation',
        supportsWebsockets: false,
      });
      const c = new Agent<unknown>({
        name: 'C',
        instructions: 'C',
        tools: [hold],
      });
      const b = new Agent<unknown>({ name: 'B', instructions: 'B' });
      b.handoffs = [b, c];
      const a = new Agent<unknown>({
        name: 'A',
        instructions: 'A',
        handoffs: [b],
        provider,
      });
      await using session = await a.session();
      const reader = session.events();
      const turn = await session.submit('Switch twice and wait');
      try {
        await entered.promise;
        const active = await session.getActiveAgent();
        expect(active).toBe(c);
        active.name = 'C changed publicly';
        b.name = 'B changed publicly';
        const notices: AgentProfileChanged[] = [];
        while (notices.length < 2) {
          const next = await reader.next();
          expect(next.done).toBe(false);
          expect(next.value.type).not.toBe('turn_finished');
          if (next.value.type === 'agent_profile_changed')
            notices.push(next.value);
        }
        expect(
          notices.map((e) => [e.agentName, e.profileId, e.profileEpoch]),
        ).toEqual([
          ['B', 'agent_1', '1'],
          ['C', 'agent_2', '3'],
        ]);
        for (const event of notices) {
          expect(event.sessionId).toBe(session.id);
          expect(event.turnId).toBe(turn.turnId);
          expect(event.submissionId).toBe(turn.submissionId);
        }
      } finally {
        release.resolve();
      }
      expect((await turn.wait()).finalOutput).toBe('done');
      await session.close();
      const remaining = await Array.fromAsync(reader);
      expect(
        remaining.filter((e) => e.type === 'agent_profile_changed'),
      ).toEqual([]);
    } finally {
      release.resolve();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'keeps idle changes unowned and preserves the unnamed root',
  async () => {
    const model = new ModelServer([]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-idle-profile-observation',
        supportsWebsockets: false,
      });
      const target = new Agent<unknown>({ name: 'B', instructions: 'B' });
      const root = new Agent<unknown>({
        instructions: 'root',
        handoffs: [target],
        provider,
      });
      await using session = await root.session();
      const reader = session.events();
      await session.update({ agent: target });
      await session.update({ agent: target });
      await expect(
        session.update({
          agent: new Agent<unknown>({
            name: 'outside',
            instructions: 'outside',
          }),
        }),
      ).rejects.toThrow();
      await session.update({ agent: root });
      expect(await session.getActiveAgent()).toBe(root);
      await session.close();
      const notices = (await Array.fromAsync(reader)).filter(
        (e) => e.type === 'agent_profile_changed',
      );
      expect(
        notices.map((e) => [e.agentName, e.profileId, e.profileEpoch]),
      ).toEqual([
        ['B', 'agent_1', '1'],
        [null, 'agent_0', '3'],
      ]);
      for (const event of notices) {
        expect(event.sessionId).toBe(session.id);
        expect(event.turnId).toBeNull();
        expect(event.submissionId).toBeNull();
      }
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'keeps an aborted tool batch from publishing an uncommitted change',
  async () => {
    const entered = Promise.withResolvers<void>();
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      execute: async (_args, context) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          else
            context.signal.addEventListener(
              'abort',
              () => reject(context.signal.reason),
              { once: true },
            );
        });
        return 'unreachable';
      },
    });
    const model = new ModelServer([
      [
        call('transfer_to_b', {}, { callId: 'handoff' }),
        call('hold', {}, { callId: 'hold' }),
      ],
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-aborted-profile',
        supportsWebsockets: false,
      });
      const target = new Agent<unknown>({ name: 'B', instructions: 'B' });
      const source = new Agent<unknown>({
        name: 'A',
        instructions: 'A',
        tools: [hold],
        handoffs: [target],
        provider,
      });
      await using session = await source.session();
      const reader = session.events();
      const turn = await session.submit('Prepare a handoff and wait');
      await entered.promise;
      await turn.cancel();
      expect(await session.getActiveAgent()).toBe(source);
      await session.close();
      expect(
        (await Array.fromAsync(reader)).filter(
          (e) => e.type === 'agent_profile_changed',
        ),
      ).toEqual([]);
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);
