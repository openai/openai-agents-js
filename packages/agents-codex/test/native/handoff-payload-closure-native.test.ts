import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  DecisionHandoff,
  Handoff,
  NativeProvider,
  tool,
  type ToolContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-payload',
    supportsWebsockets: false,
  });
}
it('formats invocation failure without transfer and accepts a later retry', async () => {
  const effects: number[] = [];
  const failures: string[] = [];
  const application = { account: 'captured' };
  const route = tool({
    name: 'route',
    description: 'Route.',
    parameters: z.object({ ticket: z.number().int() }),
    execute({ ticket }, context: ToolContext<typeof application>) {
      expect(context.context).toBe(application);
      effects.push(ticket);
      if (ticket === 1) throw new Error('private callback diagnostic');
      return `accepted-${ticket}`;
    },
    errorFunction(context: ToolContext<typeof application>, error: unknown) {
      expect(context.context).toBe(application);
      failures.push(error instanceof Error ? error.name : typeof error);
      return 'Routing unavailable; choose another ticket.';
    },
  });
  const target = new Agent<typeof application>({
    name: 'target',
    instructions: 'TARGET_ONLY',
  });
  const server = new ModelServer([
    [call('route', { ticket: 1 }, { callId: 'failed' })],
    [call('route', { ticket: 2 }, { callId: 'accepted' })],
    [message('target answered')],
  ]);
  await using selected = await provider(server);
  await using session = await new Agent<typeof application>({
    name: 'source',
    instructions: 'SOURCE_ONLY',
    provider: selected,
    model: 'gpt-5.5',
    handoffs: [new Handoff(target, route)],
  }).session({ context: application });
  expect((await (await session.submit('Route.')).wait()).finalOutput).toBe(
    'target answered',
  );
  expect(await session.getActiveAgent()).toBe(target);
  expect(effects).toEqual([1, 2]);
  expect(failures).toEqual(['Error']);
  expect(server.requests).toHaveLength(3);
  const failure = JSON.stringify(server.requests[1]);
  expect(failure).toContain('Routing unavailable; choose another ticket.');
  expect(failure).not.toContain('private callback diagnostic');
  expect(failure).toContain('SOURCE_ONLY');
  expect(failure).not.toContain('TARGET_ONLY');
  expect(JSON.stringify(server.requests[2])).toContain('TARGET_ONLY');
  server.assertExhausted();
}, 30000);
it.each(['captured', 'outside'])(
  'admits only captured invocation-time target (%s)',
  async (choice) => {
    const target = new Agent({
      name: 'target',
      instructions: 'CAPTURED_TARGET',
      model: 'gpt-5.5',
    });
    const reserve = new Agent({ name: 'reserve', instructions: 'RESERVE' });
    const server = new ModelServer([
      [call('delegate', { input: 'Route this ticket.' }, { callId: 'choice' })],
      ...(choice === 'captured' ? [[message('target answered')]] : []),
    ]);
    await using selected = await provider(server);
    const source = new Agent({
      name: 'source',
      model: 'gpt-5.5',
      provider: selected,
      instructions: 'SOURCE_ONLY',
      decisions: {
        async getDecision(request) {
          expect(request.input).toBe('Route this ticket.');
          expect(JSON.stringify(request.outputSchema)).toContain('captured');
          expect(JSON.stringify(request.outputSchema)).toContain('reserve');
          return { value: choice };
        },
      },
      handoffs: [
        new DecisionHandoff({
          name: 'delegate',
          description: 'Delegate this ticket.',
          question: 'Choose a target.',
          targets: { captured: target, reserve },
        }),
      ],
    });
    await using session = await source.session();
    const turn = await session.submit('Route.');
    if (choice === 'outside') {
      await expect(turn.wait()).rejects.toMatchObject({
        name: 'OutputValidationError',
      });
      expect(await session.getActiveAgent()).toBe(source);
      expect(server.requests).toHaveLength(1);
    } else {
      expect((await turn.wait()).finalOutput).toBe('target answered');
      expect(await session.getActiveAgent()).toBe(target);
      expect(server.requests).toHaveLength(2);
    }
    server.assertExhausted();
  },
  30000,
);
