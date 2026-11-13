import { expect, it, vi } from 'vitest';
import { Agent } from '../../src';
import { text, withScriptedResponses } from '../../src/testing';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt(
  'rejects an oversized input storage view before admission',
  async () => {
    await withScriptedResponses([], async (peer) => {
      const project = vi.fn(() => 'should never be submitted');
      const initialMessages = Array.from({ length: 4097 }, (_, index) => ({
        role: 'user' as const,
        content: `Earlier item ${index}`,
      }));
      const agent = new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
      });
      await using session = await agent.session({ initialMessages });
      await expect(
        session.submit('new input', { inputStoragePolicy: project }),
      ).rejects.toThrow(
        /Input storage policy history exceeds 4096 records or 8 MiB/,
      );
      expect(project).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
      const history = await session.historySnapshot({ limit: 0 });
      expect(history.total).toBeGreaterThanOrEqual(4097);
      expect(history.items).toEqual([]);
    });
  },
);

nativeIt(
  'keeps request-only projection separate from durable input after restore',
  async () => {
    await withScriptedResponses([[text('separate views')]], async (peer) => {
      const agent = new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
        transformContext: (request) =>
          request.items.map((item) =>
            JSON.stringify(item).includes('approved stored view')
              ? {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'model-only view' }],
                }
              : item,
          ),
      });
      await using session = await agent.session();
      const turn = await session.submit('original private input', {
        inputStoragePolicy: () => 'approved stored view',
      });
      expect((await turn.wait()).finalOutput).toBe('separate views');
      const state = await session.saveState();
      await session.close();
      await using restored = await agent.session({ state });
      const stored = JSON.stringify((await restored.historySnapshot()).items);
      expect(stored).toContain('approved stored view');
      expect(stored).not.toContain('original private input');
      expect(stored).not.toContain('model-only view');
      const wire = JSON.stringify(peer.requests);
      expect(wire).toContain('model-only view');
      expect(wire).not.toContain('approved stored view');
      expect(wire).not.toContain('original private input');
    });
  },
);

nativeIt(
  'prepares one-shot Agent.run input before its native request',
  async () => {
    await withScriptedResponses([[text('approved')]], async (peer) => {
      const agent = new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
      });
      const project = vi.fn(() => 'approved one-shot input');
      const result = await agent.run('original one-shot input', {
        inputStoragePolicy: project,
      });
      expect(result.finalOutput).toBe('approved');
      expect(project).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(peer.requests)).toContain(
        'approved one-shot input',
      );
      expect(JSON.stringify(peer.requests)).not.toContain(
        'original one-shot input',
      );
    });
  },
);

nativeIt(
  'projects the admitted input and omits a later input without changing prior history',
  async () => {
    await withScriptedResponses(
      [
        [text('prior answer')],
        [text('replacement answer')],
        [text('omitted answer')],
      ],
      async (peer) => {
        await using session = await new Agent({
          instructions: 'Answer.',
          provider: peer.provider,
        }).session();
        await (await session.submit('retained prior input')).wait();
        const project = vi.fn((_input, history) => {
          expect(JSON.stringify(history.items)).toContain('prior answer');
          return 'approved replacement';
        });
        await (
          await session.submit('unapproved original', {
            inputStoragePolicy: project,
          })
        ).wait();
        await (
          await session.submit('dropped original', {
            inputStoragePolicy: () => null,
          })
        ).wait();
        expect(project).toHaveBeenCalledExactlyOnceWith(
          'unapproved original',
          expect.any(Object),
          expect.any(AbortSignal),
        );
        const saved = JSON.stringify((await session.saveState()).history);
        const wire = JSON.stringify(peer.requests);
        for (const value of [saved, wire]) {
          expect(value).toContain('retained prior input');
          expect(value).toContain('approved replacement');
          expect(value).not.toContain('unapproved original');
          expect(value).not.toContain('dropped original');
        }
        const lastInput = peer.requests[2]!.input as { role?: string }[];
        expect(lastInput.filter(({ role }) => role === 'user')).toHaveLength(2);
      },
    );
  },
);

nativeIt(
  'applies the captured queued policy after its predecessor settles',
  async () => {
    const release = Promise.withResolvers<void>();
    await withScriptedResponses(
      [
        async () => {
          await release.promise;
          return [text('preceding answer')];
        },
        [text('queued answer')],
      ],
      async (peer) => {
        await using session = await new Agent({
          instructions: 'Answer.',
          provider: peer.provider,
        }).session();
        try {
          const first = await session.submit('preceding input');
          const supplied = {
            role: 'user' as const,
            content: 'original queued input',
          };
          const project = vi.fn(async (input, history) => {
            expect(input).toEqual({
              role: 'user',
              content: 'original queued input',
            });
            expect(JSON.stringify(history.items)).toContain('preceding answer');
            return 'approved queued input';
          });
          const second = await session.enqueue(supplied, {
            inputStoragePolicy: project,
          });
          supplied.content = 'caller mutation after enqueue';
          expect(project).not.toHaveBeenCalled();
          release.resolve();
          expect((await first.wait()).finalOutput).toBe('preceding answer');
          expect((await second.wait()).finalOutput).toBe('queued answer');
          expect(project).toHaveBeenCalledTimes(1);
          const saved = JSON.stringify((await session.saveState()).history);
          expect(saved).toContain('approved queued input');
          expect(saved).not.toContain('original queued input');
          expect(saved).not.toContain('caller mutation after enqueue');
          expect(JSON.stringify(peer.requests[1])).toContain(
            'approved queued input',
          );
        } finally {
          release.resolve();
        }
      },
    );
  },
);

nativeIt(
  'rejects storage policy failures before native submission and keeps the Session usable',
  async () => {
    await withScriptedResponses([[text('healthy')]], async (peer) => {
      await using session = await new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
      }).session();
      const failure = new Error('policy rejected');
      await expect(
        session.submit('rejected input', {
          inputStoragePolicy() {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(peer.requests).toHaveLength(0);
      expect(
        JSON.stringify((await session.historySnapshot()).items),
      ).not.toContain('rejected input');
      expect(
        (await (await session.submit('ordinary input')).wait()).finalOutput,
      ).toBe('healthy');
    });
  },
);

nativeIt(
  'discards a pending storage decision when the Session closes',
  async () => {
    await withScriptedResponses([], async (peer) => {
      await using session = await new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
      }).session();
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<string>();
      const turn = await session.enqueue('cancelled raw input', {
        async inputStoragePolicy(_input, _history, signal) {
          entered.resolve(signal);
          return release.promise;
        },
      });
      const result = turn.wait().catch((error: unknown) => error);
      const signal = await entered.promise;
      const closing = session.close();
      release.resolve('late replacement');
      await closing;
      expect(signal.aborted).toBe(true);
      expect(await result).toBeInstanceOf(Error);
      expect(peer.requests).toHaveLength(0);
    });
  },
);

nativeIt(
  'stops input storage preparation before entering a queued policy',
  async () => {
    await withScriptedResponses([[text('later answer')]], async (peer) => {
      await using session = await new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
      }).session();
      const project = vi.fn(() => 'stopped replacement');
      const turn = await session.enqueue('stopped raw input', {
        inputStoragePolicy: project,
      });
      const result = turn.wait().catch((error: unknown) => error);
      await session.interrupt({ mode: 'graceful' });
      await turn.cancel({ mode: 'graceful' });
      expect(await result).toBeInstanceOf(Error);
      expect(project).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
      const later = await session.enqueue('later queued input');
      expect((await later.wait()).finalOutput).toBe('later answer');
      const history = JSON.stringify((await session.historySnapshot()).items);
      const wire = JSON.stringify(peer.requests);
      for (const value of [history, wire]) {
        expect(value).toContain('later queued input');
        expect(value).not.toContain('stopped raw input');
        expect(value).not.toContain('stopped replacement');
      }
    });
  },
);

nativeIt(
  'aborts an entered storage policy during graceful stop and continues queued work',
  async () => {
    await withScriptedResponses([[text('later answer')]], async (peer) => {
      await using session = await new Agent({
        instructions: 'Answer.',
        provider: peer.provider,
      }).session();
      const entered = Promise.withResolvers<AbortSignal>();
      const turn = await session.enqueue('stopped raw input', {
        async inputStoragePolicy(_input, _history, signal) {
          entered.resolve(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return 'late stopped replacement';
        },
      });
      const result = turn.wait().catch((error: unknown) => error);
      const signal = await entered.promise;
      const later = await session.enqueue('later queued input', {
        inputStoragePolicy: () => 'approved later input',
      });
      const stopping = turn.cancel({ mode: 'graceful' });
      await expect.poll(() => signal.aborted, { timeout: 1000 }).toBe(true);
      await stopping;
      expect(await result).toBeInstanceOf(Error);
      expect((await later.wait()).finalOutput).toBe('later answer');
      expect(peer.requests).toHaveLength(1);
      const history = JSON.stringify((await session.historySnapshot()).items);
      const wire = JSON.stringify(peer.requests);
      for (const value of [history, wire]) {
        expect(value).toContain('approved later input');
        expect(value).not.toContain('later queued input');
        expect(value).not.toContain('stopped raw input');
        expect(value).not.toContain('late stopped replacement');
      }
    });
  },
);
