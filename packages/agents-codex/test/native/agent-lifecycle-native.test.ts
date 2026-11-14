import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, type AgentLifecycleEvent } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('runs synchronous start, accepted source handoff, destination start and end in owner order', async () => {
  const events: string[] = [];
  const context = { owner: 'application' };
  let source: Agent<typeof context>;
  let target: Agent<typeof context>;
  const lifecycle = (event: AgentLifecycleEvent<typeof context>) => {
    expect(event.context).toBe(context);
    events.push(`${event.kind}:${event.agent.name}`);
    if (event.kind === 'handoff') {
      expect(event.agent).toBe(source);
      expect(event.target).toBe(target);
    }
    if (event.kind === 'end') {
      expect(event.agent).toBe(target);
      expect(event.output).toBe('done');
    }
  };
  const server = new ModelServer([
    () => {
      expect(events).toEqual(['start:A']);
      return [call('transfer_to_b', {}, { callId: 'handoff-b' })];
    },
    () => {
      expect(events).toEqual(['start:A', 'handoff:A', 'start:B']);
      return [message('done')];
    },
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-lifecycle',
    supportsWebsockets: false,
  });
  target = new Agent({
    name: 'B',
    instructions: 'Complete.',
    onLifecycle: lifecycle,
  });
  source = new Agent({
    name: 'A',
    instructions: 'Transfer.',
    model: 'gpt-5.5',
    provider,
    handoffs: [target],
    onLifecycle: lifecycle,
  });
  const result = await source.run('Go.', { context });
  expect(result.finalOutput).toBe('done');
  expect(events).toEqual(['start:A', 'handoff:A', 'start:B', 'end:B']);
});

it('propagates a source handoff listener failure without destination activation', async () => {
  const events: string[] = [];
  const failure = new Error('source handoff rejected');
  const lifecycle = (event: AgentLifecycleEvent<undefined>) => {
    events.push(`${event.kind}:${event.agent.name}`);
    if (event.kind === 'handoff') throw failure;
  };
  const server = new ModelServer([
    [call('transfer_to_b', {}, { callId: 'handoff-b' })],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-rejected',
    supportsWebsockets: false,
  });
  const target = new Agent({
    name: 'B',
    instructions: 'Complete.',
    onLifecycle: lifecycle,
  });
  const source = new Agent({
    name: 'A',
    instructions: 'Transfer.',
    model: 'gpt-5.5',
    provider,
    handoffs: [target],
    onLifecycle: lifecycle,
  });
  await using session = await source.session();
  const turn = await session.submit('Go.');
  await expect(turn.wait()).rejects.toBe(failure);
  expect(await session.getActiveAgent()).toBe(source);
  expect(server.requests).toHaveLength(1);
  expect(events).toEqual(['start:A', 'handoff:A']);
});

it('starts the same Agent again after an accepted self handoff', async () => {
  const events: string[] = [];
  const lifecycle = (event: AgentLifecycleEvent<undefined>) =>
    events.push(`${event.kind}:${event.agent.name}`);
  const server = new ModelServer([
    [call('transfer_to_a', {}, { callId: 'handoff-a' })],
    [message('done')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-self',
    supportsWebsockets: false,
  });
  const source: Agent = new Agent({
    name: 'A',
    instructions: 'Transfer to yourself once.',
    model: 'gpt-5.5',
    provider,
    handoffs: [() => source],
    onLifecycle: lifecycle,
  });
  expect((await source.run('Go.')).finalOutput).toBe('done');
  expect(events).toEqual(['start:A', 'handoff:A', 'start:A', 'end:A']);
});

it('honors cancellation from the synchronous start body before provider I/O', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const server = new ModelServer([]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-cancelled',
    supportsWebsockets: false,
  });
  const source = new Agent({
    name: 'A',
    instructions: 'Complete.',
    model: 'gpt-5.5',
    provider,
    onLifecycle: (event) => {
      events.push(event.kind);
      controller.abort(new Error('caller cancelled'));
    },
  });
  await expect(
    source.run('Go.', { signal: controller.signal }),
  ).rejects.toThrow();
  expect(server.requests).toHaveLength(0);
  expect(events).toEqual(['start']);
});

it('runs a plain Agent callback before provider I/O and after accepted output', async () => {
  const events: string[] = [];
  const server = new ModelServer([[message('done')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-plain-lifecycle',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    name: 'Plain',
    instructions: 'Complete.',
    model: 'gpt-5.5',
    provider,
    onLifecycle(event) {
      events.push(event.kind);
      if (event.kind === 'start') expect(server.requests).toHaveLength(0);
      if (event.kind === 'end') expect(event.output).toBe('done');
    },
  });
  expect((await agent.run('Go.')).finalOutput).toBe('done');
  expect(events).toEqual(['start', 'end']);
});
