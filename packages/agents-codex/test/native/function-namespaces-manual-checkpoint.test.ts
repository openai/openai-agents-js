import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  tool,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('suspends a mixed qualified automatic and bare manual catalog without replaying the automatic effect', async () => {
  const record = vi.fn(() => 'recorded');
  const server = new ModelServer([
    [
      call('record', {}, { namespace: 'audit', callId: 'qualified-record' }),
      call('lookup', {}, { callId: 'bare-manual' }),
    ],
    [message('ordinary completion')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture-qualified-manual-checkpoint',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Record and ask, then finish.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'record',
        namespace: 'audit',
        parameters: z.object({}),
        execute: record,
      }),
      manualTool({
        name: 'lookup',
        description: 'Ask.',
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
  });
  await using original = await agent.session();
  const turn = await original.submit('Run.');
  const completion = turn.wait().catch((error: unknown) => error);
  let automaticSettled = false;
  let manualReady = false;
  for await (const event of original.events()) {
    if (event.type === 'tool_finished' && event.callId === 'qualified-record') {
      expect(event.status).toBe('completed');
      expect(event.namespace).toBe('audit');
      automaticSettled = true;
    }
    if (event.type === 'action_requested') manualReady = true;
    if (automaticSettled && manualReady) break;
  }
  expect(automaticSettled).toBe(true);
  expect(manualReady).toBe(true);
  expect(record).toHaveBeenCalledTimes(1);
  const state = await original.suspend();
  expect(await completion).toBeInstanceOf(InteractionRequired);
  await original.close();

  await using restored = await agent.session({ state });
  expect(record).toHaveBeenCalledTimes(1);
  for await (const event of restored.events()) {
    if (event.type !== 'action_requested') continue;
    await restored.respond(event.reply('accepted'));
    break;
  }
  const result = await restored.restoredTurn!.wait();
  expect(result.turn.turnId).toBe(turn.turnId);
  expect(result.finalOutput).toBe('ordinary completion');
  expect(record).toHaveBeenCalledTimes(1);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});
