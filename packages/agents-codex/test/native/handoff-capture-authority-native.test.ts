import { isManualSessionState } from '../../src/runtime/state';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-capture-authority',
    supportsWebsockets: false,
  });
}
const gate = manualTool({
  name: 'confirm',
  description: 'Confirm.',
  parameters: z.object({}),
  result: z.string(),
});
function source(provider: NativeProvider) {
  const target = new Agent({
    name: 'destination',
    instructions: 'Confirm then finish.',
    tools: [gate],
  });
  return new Agent({
    name: 'source',
    model: 'gpt-5.5',
    provider,
    instructions: 'Transfer.',
    handoffs: [target],
    prepareHandoffInput: (value) => ({
      ...value,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'trusted handoff context' }],
        },
      ],
      previous: [],
      generated: [],
    }),
  });
}

it('resumes an SDK-published InteractionRequired checkpoint after a prepared handoff', async () => {
  const server = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'handoff' })],
    [call('confirm', {}, { callId: 'confirmation' })],
    [message('direct complete')],
  ]);
  await using owned = await provider(server);
  const agent = source(owned);
  let state: SessionState | undefined;
  try {
    await agent.run('begin');
  } catch (error) {
    if (!(error instanceof InteractionRequired)) throw error;
    state = error.state;
  }
  if (!state) throw new Error('Expected the automatic portable checkpoint');
  expect(server.requests).toHaveLength(2);
  const result = await agent.run(null, {
    state,
    onInteraction(request) {
      const action = gate.match(request);
      if (!action) throw new Error('Expected confirmation');
      return action.reply('confirmed');
    },
  });
  expect(result.finalOutput).toBe('direct complete');
  expect(server.requests).toHaveLength(3);
  expect(JSON.stringify(server.requests[2]?.input)).toContain(
    'trusted handoff context',
  );
  server.assertExhausted();
}, 30_000);

it.each(['capture', 'authenticated', 'unverified', 'mutated'] as const)(
  'retains exact parent authority for a configured child: %s',
  async (mode) => {
    const root = new ModelServer([
      [
        call(
          'nested_child',
          { input: 'begin child' },
          { callId: 'parent-call' },
        ),
      ],
      [message('parent complete')],
    ]);
    const child = new ModelServer([
      [call('transfer_to_destination', {}, { callId: 'handoff' })],
      [call('confirm', {}, { callId: 'confirmation' })],
      [message('child complete')],
    ]);
    await using rootProvider = await provider(root);
    await using childProvider = await provider(child);
    const childAgent = source(childProvider);
    const parent = new Agent({
      model: 'gpt-5.5',
      provider: rootProvider,
      instructions: 'Use the child.',
      tools: [
        childAgent.asTool({
          toolName: 'nested_child',
          toolDescription: 'Run child.',
        }),
      ],
    });
    let captured: SessionState;
    {
      await using session = await parent.session();
      const turn = await session.submit('begin parent');
      const boundary = await turn.wait({ until: 'interaction' });
      if (!('requests' in boundary))
        throw new Error('Expected child interaction');
      captured = await session.suspend();
    }
    const raw = JSON.stringify(captured);
    const state =
      mode === 'capture' || mode === 'mutated'
        ? captured
        : mode === 'authenticated'
          ? parseSessionState(raw, {
              expectedSha256: createHash('sha256').update(raw).digest('hex'),
            })
          : (JSON.parse(raw) as SessionState);
    if (mode === 'mutated') {
      if (!isManualSessionState(state))
        throw new Error('Expected manual checkpoint');
      const nested =
        state.manual_continuation.pending_manual[0].continuation!.state;
      let changes = 0;
      for (const row of nested.history as Record<string, any>[]) {
        const presentation = row.metadata?.sdk_agent_profile?.presentation;
        if (presentation) {
          presentation.input = [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'FORGED nested context' }],
            },
          ];
          changes++;
        }
      }
      expect(changes).toBeGreaterThan(0);
    }
    const allowed = mode === 'capture' || mode === 'authenticated';
    let rejection = '';
    let restored: Awaited<ReturnType<typeof parent.session>> | undefined;
    try {
      restored = await parent.session({ state });
      const turn = restored.restoredTurn;
      if (!turn) throw new Error('Expected restored parent');
      const boundary = await turn.wait({ until: 'interaction' });
      if (!('requests' in boundary))
        throw new Error('Expected restored child request');
      const action = gate.match(boundary.requests[0]);
      if (!action) throw new Error('Expected restored child confirmation');
      await restored.respond(action.reply('confirmed'));
      expect((await turn.wait()).finalOutput).toBe('parent complete');
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    } finally {
      await restored?.close();
    }
    if (allowed) {
      expect(rejection).toBe('');
      expect(root.requests).toHaveLength(2);
      expect(child.requests).toHaveLength(3);
    } else {
      expect(rejection).toContain('authenticated');
      expect(root.requests).toHaveLength(1);
      expect(child.requests).toHaveLength(2);
    }
  },
  30_000,
);

it('publishes detached authenticated snapshots to suspend and InteractionRequired', async () => {
  const server = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'handoff' })],
    [call('confirm', {}, { callId: 'confirmation' })],
    [message('restored complete')],
  ]);
  await using owned = await provider(server);
  const agent = source(owned);
  let published: SessionState | undefined;
  let captured: SessionState;
  {
    await using session = await agent.session();
    const turn = await session.submit('begin');
    const boundary = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in boundary)) throw new Error('Expected manual boundary');
    captured = await session.suspend();
    try {
      await turn.wait();
    } catch (error) {
      if (!(error instanceof InteractionRequired)) throw error;
      published = error.state;
    }
  }
  if (!published) throw new Error('Expected the published failure checkpoint');
  expect(published).not.toBe(captured);
  const original = JSON.stringify(published);
  captured.history.length = 0;
  expect(JSON.stringify(published)).toBe(original);
  const result = await agent.run(null, {
    state: published,
    onInteraction(request) {
      const action = gate.match(request);
      if (!action) throw new Error('Expected confirmation');
      return action.reply('confirmed');
    },
  });
  expect(result.finalOutput).toBe('restored complete');
  expect(server.requests).toHaveLength(3);
}, 30_000);
