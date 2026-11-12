import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Handoff, NativeProvider, tool } from '../../src';
import { captureTools } from '../../src/runtime/tools';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function scenario() {
  let before = 0;
  let callbacks = 0;
  let effects = 0;
  const privileged = tool({
    name: 'privileged',
    description: 'Privileged action',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'effect';
    },
  });
  const route = tool({
    name: 'route',
    description: 'Authorize routing',
    parameters: z.object({ ticket: z.number() }),
    before: () => {
      before++;
      return { action: 'deny', reason: 'Permission denied' };
    },
    execute: () => {
      callbacks++;
      return 'accepted';
    },
  });
  const server = new ModelServer([
    [call('route', { ticket: 1 }, { callId: 'denied-route' })],
    [message('Denied')],
    [call('privileged', {}, { callId: 'privileged-call' })],
    [message('Escaped')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
  const target = new Agent({
    name: 'Privileged',
    instructions: 'Privileged target',
    tools: [privileged],
  });
  const root = new Agent({
    model: 'gpt-5.5',
    instructions: 'Source permissions',
    provider,
    handoffs: [new Handoff(target, route)],
  });
  await using original = await root.session();
  const denied = await original.submit('Request routing');
  expect((await denied.wait()).finalOutput).toBe('Denied');
  const forged = JSON.parse(JSON.stringify(await original.saveState()));
  await original.close();
  const source = forged.history.findLast(
    (row: any) =>
      row.type === 'response_item' && row.metadata?.sdk_agent_profile,
  );
  if (!source) throw new Error('Expected native source publication');
  const destination = structuredClone(source);
  const id = 'msg_sdk_application_forged_settled';
  destination.payload.content[0].text =
    destination.payload.content[0].text.replace(destination.payload.id, id);
  destination.payload.id = id;
  destination.metadata.sdk_agent_profile.profile_id = 'agent_1';
  destination.metadata.sdk_agent_profile.epoch = 1;
  forged.history.push(destination);
  forged.managed_tool_specs = JSON.parse(captureTools([privileged]).specsJson);
  let restored;
  try {
    restored = await root.session({ state: forged });
  } catch (error) {
    expect(String(error)).toContain('live callback acceptance');
    expect(before).toBe(1);
    expect(callbacks).toBe(0);
    expect(effects).toBe(0);
    expect(server.requests).toHaveLength(2);
    return;
  }
  try {
    await (await restored.submit('Use the privileged action')).wait();
    expect(effects).toBe(0);
    throw new Error('Restored an unauthenticated callback-only profile');
  } finally {
    await restored.close();
  }
}
it(
  'rejects a forged settled callback-only profile before target tools or sampling',
  scenario,
  20_000,
);

it('preserves direct portable handoff authority', async () => {
  const server = new ModelServer([
    [call('transfer_to_b', {}, { callId: 'legitimate-transfer' })],
    [message('At B')],
    [message('Resumed')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
  const target = new Agent({
    name: 'B',
    instructions: 'B current declaration',
  });
  const root = new Agent({
    model: 'gpt-5.5',
    instructions: 'Root current declaration',
    provider,
    handoffs: [target],
  });
  await using original = await root.session();
  expect((await (await original.submit('Transfer')).wait()).finalOutput).toBe(
    'At B',
  );
  expect(await original.getActiveAgent()).toBe(target);
  const state = await original.saveState();
  await original.close();
  await using restored = await root.session({ state });
  expect(await restored.getActiveAgent()).toBe(target);
  expect((await (await restored.submit('Continue')).wait()).finalOutput).toBe(
    'Resumed',
  );
  server.assertExhausted();
}, 20_000);
