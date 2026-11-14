import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  fileSessionStore,
  tool,
  type SessionStore,
  type ModelRequestContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

type Edit = (context: ModelRequestContext) => readonly Record<string, any>[];
async function observeProjection(edit?: Edit, rejected = false) {
  const server = new ModelServer([
    [call('historical_effect', {}, { callId: 'prior-owned-effect' })],
    [message('old answer')],
    ...(rejected ? [] : [[message('new answer')]]),
  ]);
  const config = await server.config();
  const directory = await mkdtemp(join(tmpdir(), 'coupled-native-input-'));
  try {
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-coupled-input',
      supportsWebsockets: false,
    });
    let armed = false;
    let effects = 0;
    const committed: string[] = [];
    const durable = fileSessionStore(directory);
    const storage: SessionStore = {
      ...durable,
      commit: async (...args) => {
        committed.push(args[4]);

        await durable.commit(...args);
      },
    };
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      tools: [
        tool({
          name: 'historical_effect',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'OLD_EFFECT_RECEIPT';
          },
        }),
      ],
      transformContext: (context) => {
        const { items } = context;
        if (!armed) return;
        if (edit) return edit(context);
        return items.map((item) => {
          if (item.role === 'user')
            return {
              ...item,
              content: [{ type: 'input_text', text: '[redacted]' }],
            };
          if (item.type === 'function_call_output')
            return {
              ...item,
              output: '[redacted prior effect]',
            };
          return item;
        });
      },
    });
    await using session = await agent.session({ storage });
    expect((await (await session.submit('OLD_KEEP')).wait()).finalOutput).toBe(
      'old answer',
    );
    armed = true;
    committed.length = 0;
    const turn = await session.submit('NEW_SECRET', {
      storeProjectedUserInput: true,
    });
    if (rejected)
      await expect(turn.wait()).rejects.toThrow(/Projected input storage/);
    else expect((await turn.wait()).finalOutput).toBe('new answer');
    const modelInput = JSON.stringify(server.requests[2]?.input);
    const canonical = JSON.stringify(await Array.fromAsync(session.items()));
    const observed = {
      modelSecret: modelInput.includes('NEW_SECRET'),
      modelPriorEffect: modelInput.includes('OLD_EFFECT_RECEIPT'),
      modelRedacted: modelInput.includes('[redacted]'),
      canonicalSecret: canonical.includes('NEW_SECRET'),
      canonicalPriorInput: canonical.includes('OLD_KEEP'),
      canonicalPriorEffect: canonical.includes('OLD_EFFECT_RECEIPT'),
      committedSecretCount: committed.filter((snapshot) =>
        snapshot.includes('NEW_SECRET'),
      ).length,
      commitCount: committed.length,
      effects,
      requestCount: server.requests.length,
    };

    server.assertExhausted();
    return observed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

nativeIt(
  'persists only projected new text before wire dispatch and preserves prior history and tools',
  async () => {
    const result = await observeProjection();
    expect(result).toMatchObject({
      modelSecret: false,
      modelPriorEffect: false,
      modelRedacted: true,
      canonicalSecret: false,
      canonicalPriorInput: true,
      canonicalPriorEffect: true,
      committedSecretCount: 0,
      effects: 1,
      requestCount: 3,
    });
  },
);

nativeIt(
  'persists the owned occurrence after source-preserving reorder',
  async () => {
    const result = await observeProjection(({ items }) => {
      const owned = items.find((item) =>
        JSON.stringify(item).includes('NEW_SECRET'),
      )!;
      return [
        { ...owned, content: [{ type: 'input_text', text: '[redacted]' }] },
        ...items.filter((item) => item !== owned),
      ];
    });
    expect(result).toMatchObject({
      canonicalSecret: false,
      committedSecretCount: 0,
      canonicalPriorInput: true,
      canonicalPriorEffect: true,
      effects: 1,
      requestCount: 3,
    });
  },
);

nativeIt(
  'removes only the filtered owned input while preserving prior canonical occurrences',
  async () => {
    const result = await observeProjection(({ items }) =>
      items.filter((item) => !JSON.stringify(item).includes('NEW_SECRET')),
    );
    expect(result).toMatchObject({
      canonicalSecret: false,
      committedSecretCount: 0,
      canonicalPriorInput: true,
      canonicalPriorEffect: true,
      effects: 1,
      requestCount: 3,
    });
  },
);

for (const kind of [
  'identity loss',
  'duplicate',
  'role change',
  'new user',
  'metadata change',
] as const) {
  nativeIt(
    `rejects ${kind} before writing the owned input or dispatching a request`,
    async () => {
      const result = await observeProjection(
        ({ items }) =>
          items.flatMap((item) => {
            if (!JSON.stringify(item).includes('NEW_SECRET')) return [item];
            if (kind === 'duplicate') return [item, item];
            if (kind === 'role change') return [{ ...item, role: 'system' }];
            if (kind === 'metadata change')
              return [
                {
                  ...item,
                  internal_chat_message_metadata_passthrough: {
                    turn_id: 'forged',
                  },
                },
              ];
            if (kind === 'new user')
              return [
                item,
                {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'injected' }],
                },
              ];
            const { id: _id, ...withoutId } = item;
            return [withoutId];
          }),
        true,
      );
      expect(result).toMatchObject({
        canonicalSecret: false,
        committedSecretCount: 0,
        canonicalPriorInput: true,
        canonicalPriorEffect: true,
        effects: 1,
        requestCount: 2,
      });
    },
  );
}

nativeIt(
  'joins cancellation during projection without writing or dispatching raw input',
  async () => {
    const server = new ModelServer([]);
    const config = await server.config();
    const directory = await mkdtemp(join(tmpdir(), 'coupled-input-cancel-'));
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const commits: string[] = [];
    try {
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-cancel-projection',
        supportsWebsockets: false,
      });
      const durable = fileSessionStore(directory);
      const storage: SessionStore = {
        ...durable,
        commit: async (...args) => {
          commits.push(args[4]);
          await durable.commit(...args);
        },
      };
      await using session = await new Agent({
        instructions: 'Answer.',
        provider,
        transformContext: async (context) => {
          entered.resolve(context.signal);
          await release.promise;
          return context.items.map((item) =>
            item.role === 'user'
              ? {
                  ...item,
                  content: [{ type: 'input_text', text: '[redacted]' }],
                }
              : item,
          );
        },
      }).session({ storage });
      const turn = await session.submit('NEW_SECRET', {
        storeProjectedUserInput: true,
      });
      const result = turn.wait().catch((error: unknown) => error);
      try {
        const signal = await entered.promise;
        const stopping = turn.cancel();
        await expect.poll(() => signal.aborted).toBe(true);
        expect(
          commits.some((snapshot) => snapshot.includes('NEW_SECRET')),
        ).toBe(false);
        release.resolve();
        await stopping;
        expect(await result).toBeInstanceOf(Error);
        expect(
          commits.some((snapshot) => snapshot.includes('NEW_SECRET')),
        ).toBe(false);
        expect(
          JSON.stringify(await Array.fromAsync(session.items())),
        ).not.toContain('NEW_SECRET');
        expect(server.requests).toHaveLength(0);
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
