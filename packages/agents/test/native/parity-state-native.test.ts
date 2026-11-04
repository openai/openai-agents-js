import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, parseSessionState } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('restores retained native goal data using the current session store', async () => {
  const server = new ModelServer([
    [message('remembered')],
    [message('continued')],
  ]);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
  const agent = new Agent({
    instructions: 'Remember the conversation.',
    model: 'gpt-5',
    provider,
  });
  try {
    const first = await agent.run('Remember this.', { returnState: true });
    const state = first.state!;
    // Imported native snapshots may retain a paused goal without granting goal tools.
    state.root_goal = {
      thread_id: state.source_session_id,
      objective: 'Retained native objective',
      status: 'paused',
      token_budget: 100,
      tokens_used: 17,
      time_used_seconds: 3,
    };
    const restored = await agent.session({ state });
    try {
      expect(
        (await (await restored.submit('Continue.')).wait()).finalOutput,
      ).toBe('continued');
      const saved = await restored.saveState();
      expect(saved.root_goal).toMatchObject({
        objective: 'Retained native objective',
        status: 'paused',
        token_budget: 100,
        tokens_used: 17,
        time_used_seconds: 3,
      });
    } finally {
      await restored.close();
    }
    server.assertExhausted();
  } finally {
    await provider.close();
  }
});

it.each(['unmodified', 'malformed', 'mismatched'])(
  'preserves the portable resume baseline with %s receipt metadata',
  async (kind) => {
    const server = new ModelServer([
      [message('Remembered')],
      [message('Model summary')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const agent = new Agent({
      instructions: 'Remember the conversation.',
      model: 'gpt-5',
      provider,
    });
    const { state, turnId } = await (async () => {
      await using source = await agent.session();
      const turn = await source.submit('Remember this.');
      await turn.wait();
      return { state: await source.saveState(), turnId: turn.turnId };
    })();

    const contexts = state.history
      .filter((record) => record.type === 'turn_context')
      .map((record) => record.payload)
      .flatMap((payload) =>
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload)
          ? [payload]
          : [],
      )
      .filter((context) => context.turn_id === turnId);
    expect(contexts).toHaveLength(2);
    const canonical = contexts.find((context) => !context.sdk_receipt);
    const observed = contexts.find((context) => context.sdk_receipt);
    if (!canonical || !observed)
      throw new Error('Expected both native contexts');
    // Distinguish the completed user turn from the earlier opening context.
    const previousCompHash = 'previous-model-computation';
    canonical.comp_hash = previousCompHash;
    observed.comp_hash = previousCompHash;
    if (kind === 'malformed') {
      canonical.sdk_receipt = { invalid: true };
    } else if (kind === 'mismatched') {
      canonical.sdk_receipt = {
        ...(observed.sdk_receipt as object),
        thread_id: '11111111-2222-4333-8444-555555555555',
        model: 'foreign-model',
        approval_policy: 'untrusted',
      };
    }

    await using restored = await agent.session({
      state: parseSessionState(JSON.stringify(state)),
    });
    await restored.compact();
    const saved = await restored.saveState();
    const compacted = saved.history
      .filter((record) => record.type === 'compacted')
      .at(-1);
    expect(compacted?.payload).toMatchObject({
      resume_metadata: {
        previous_turn_settings: { comp_hash: previousCompHash },
      },
    });
    server.assertExhausted();
  },
);

it.each(['unsupported receipt', 'ordinary context'] as const)(
  'projects the latest receipt after a later %s for the same turn',
  async (kind) => {
    const server = new ModelServer([[message('Remembered')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const agent = new Agent({ instructions: 'Remember this.', provider });
    const { state, turnId } = await (async () => {
      await using source = await agent.session();
      const turn = await source.submit('Remember this.');
      await turn.wait();
      return { state: await source.saveState(), turnId: turn.turnId };
    })();
    const index = state.history.findIndex(
      ({ type, payload }) =>
        type === 'turn_context' &&
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.turn_id === turnId &&
        typeof payload.sdk_receipt === 'object' &&
        payload.sdk_receipt !== null,
    );
    const observed = state.history[index];
    const payload = observed?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Expected a native receipt record');
    const { sdk_receipt: receipt, ...ordinary } = payload;
    expect(receipt).toMatchObject({ version: 1 });
    state.history.splice(index + 1, 0, {
      ...observed,
      payload:
        kind === 'unsupported receipt'
          ? { ...ordinary, sdk_receipt: { ...(receipt as object), version: 2 } }
          : ordinary,
    });

    await using restored = await agent.session({
      state: parseSessionState(JSON.stringify(state)),
    });
    const turns = await Array.fromAsync(restored.turns());
    const recorded = turns.find(({ id }) => id === turnId);
    expect(recorded).toBeDefined();
    if (kind === 'unsupported receipt') {
      expect(recorded?.receipt).toBeUndefined();
    } else {
      expect(recorded?.receipt).toMatchObject({
        threadId: state.source_session_id,
        turnId,
      });
    }
    server.assertExhausted();
  },
);
