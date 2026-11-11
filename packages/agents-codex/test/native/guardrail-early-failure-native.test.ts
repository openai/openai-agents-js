import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, GuardrailTripwire, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([false, true])(
  'stops the parallel model on a guard exception and joins peers (cleanup error=%s)',
  async (cleanupError) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const fail = Promise.withResolvers<void>();
    const releasePeer = Promise.withResolvers<void>();
    const releaseModel = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const original = new Error('first guard failure');
    const effects: string[] = [];
    let peerFinished = false;
    const server = new ModelServer([
      async () => {
        await releaseModel.promise;
        return [call('effect', {}, { callId: 'effect' })];
      },
    ]);
    server.onRecord = (phase) => {
      if (phase === 'MODEL_RESPONSE_CLOSED') disconnected.resolve();
    };
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-guard-early-failure',
    });
    await using session = await new Agent({
      instructions: 'Use effect.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'effect',
          parameters: z.object({}),
          execute: () => {
            effects.push('effect');
            return 'done';
          },
        }),
      ],
      inputGuardrails: [
        {
          name: 'throwing',
          async callback() {
            await fail.promise;
            throw original;
          },
        },
        {
          name: 'peer',
          async callback({ signal }) {
            entered.resolve(signal);
            await releasePeer.promise;
            peerFinished = true;
            if (cleanupError) throw new Error('later peer cleanup failure');
            return { tripwireTriggered: false };
          },
        },
      ],
    }).session();
    const turn = await session.submit('begin');
    let finished = false;
    const result = turn.wait();
    void result.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      const signal = await entered.promise;
      await vi.waitFor(() => expect(server.requests).toHaveLength(1));
      fail.resolve();
      await vi.waitFor(() => expect(signal.aborted).toBe(true), {
        timeout: 1000,
      });
      await Promise.race([
        disconnected.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('provider not cancelled')), 1000),
        ),
      ]);
      expect(peerFinished).toBe(false);
      expect(finished).toBe(false);
      releaseModel.resolve();
      expect(effects).toEqual([]);
      releasePeer.resolve();
      await expect(result).rejects.toBe(original);
      expect(peerFinished).toBe(true);
      expect(effects).toEqual([]);
      expect(server.requests).toHaveLength(1);
    } finally {
      fail.resolve();
      releasePeer.resolve();
      releaseModel.resolve();
      await result.catch(() => {});
    }
  },
);

it.each([
  { kind: 'input', failure: 'tripwire' },
  { kind: 'output', failure: 'tripwire' },
  { kind: 'output', failure: 'exception' },
] as const)(
  'joins the whole JS $kind batch before reporting $failure',
  async ({ kind, failure }) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const failed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = new Error('output guard failure');
    const marker = {};
    const checks = [
      {
        name: 'first',
        async callback() {
          await entered.promise;
          failed.resolve();
          if (failure === 'exception') throw original;
          return { tripwireTriggered: true };
        },
      },
      {
        name: 'peer',
        async callback({ signal }: { signal: AbortSignal }) {
          entered.resolve(signal);
          await release.promise;
          return { tripwireTriggered: false, outputInfo: marker };
        },
      },
    ];
    const server = new ModelServer([[message('candidate')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-guard-whole-batch',
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      ...(kind === 'input'
        ? { inputGuardrails: checks }
        : { outputGuardrails: checks }),
    }).session();
    const turn = await session.submit('begin');
    let settled = false;
    const result = turn.wait();
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      const signal = await entered.promise;
      await failed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signal.aborted).toBe(false);
      expect(settled).toBe(false);
      release.resolve();
      if (failure === 'exception') await expect(result).rejects.toBe(original);
      else {
        await expect(result).rejects.toBeInstanceOf(GuardrailTripwire);
        expect(turn.guardrailResults.map((record) => record.name)).toEqual([
          'first',
          'peer',
        ]);
        expect(turn.guardrailResults[1]!.result.outputInfo).toBe(marker);
      }
    } finally {
      release.resolve();
      await result.catch(() => {});
    }
  },
);
