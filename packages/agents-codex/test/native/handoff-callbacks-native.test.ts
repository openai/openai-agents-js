import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  NativeProvider,
  tool,
  type ToolContext,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-handoff',
    supportsWebsockets: false,
  });
}

function output(server: ModelServer, index: number, callId: string): string {
  const rows = server.requests[index].input as JsonObject[];
  const value = rows.find(
    (row) => row.type === 'function_call_output' && row.call_id === callId,
  )?.output;
  if (typeof value === 'string') return value;
  expect(Array.isArray(value)).toBe(true);
  return (value as JsonObject[]).map((part) => part.text ?? '').join('');
}

function requestInstructions(request: JsonObject): string {
  return (request.input as JsonObject[])
    .filter((item) => item.role === 'developer' && item.type === 'message')
    .flatMap((item) => item.content as JsonObject[])
    .filter((part) => part.type === 'input_text')
    .map((part) => part.text)
    .join('\n');
}

it.each([false, true])(
  'retains typed payload, callback context, declaration and acknowledgement (declared tool=%s)',
  async (declaredTool) => {
    const application = { account: 'captured' };
    const effects: number[] = [];
    const route = tool({
      name: 'route_issue',
      description: 'Issue routing',
      parameters: z.object({ ticket: z.number().int() }),
      execute({ ticket }, context: ToolContext<typeof application>) {
        expect(context.context).toBe(application);
        expect(context.callId).toBe('route-7');
        effects.push(ticket);
        return `accepted-ticket-${ticket}`;
      },
    });
    const server = new ModelServer([
      [call('route_issue', { ticket: 7 }, { callId: 'route-7' })],
      [message('resolved')],
    ]);
    await using provider = await providerFor(server);
    const target = new Agent<typeof application>({
      instructions: 'TARGET_ONLY resolve',
    });
    await using session = await new Agent<typeof application>({
      instructions: 'SOURCE_ONLY route',
      tools: declaredTool ? [route] : [],
      model: 'gpt-5.5',
      provider,
      handoffs: [new Handoff(target, route)],
    }).session({ context: application });
    expect((await (await session.submit('Route')).wait()).finalOutput).toBe(
      'resolved',
    );
    expect(effects).toEqual([7]);
    const spec = (server.requests[0].tools as JsonObject[]).find(
      (entry) => entry.name === 'route_issue',
    );
    expect(spec).toMatchObject({
      description: 'Issue routing',
      parameters: { properties: { ticket: { type: 'integer' } } },
    });
    expect(requestInstructions(server.requests[0])).toContain('SOURCE_ONLY');
    expect(requestInstructions(server.requests[1])).toContain('TARGET_ONLY');
    expect(output(server, 1, 'route-7')).toBe('accepted-ticket-7');
    expect(await session.getActiveAgent()).toBe(target);
    server.assertExhausted();
  },
);

it('keeps a denied callback at the source before a later accepted transfer', async () => {
  const effects: number[] = [];
  const route = tool({
    name: 'route',
    parameters: z.object({ ticket: z.number() }),
    before: (context) =>
      context.effectiveArguments.ticket === 1
        ? { action: 'deny', reason: 'Use the next ticket' }
        : { action: 'allow' },
    execute({ ticket }) {
      effects.push(ticket);
      return `accepted-${ticket}`;
    },
  });
  const server = new ModelServer([
    [call('route', { ticket: 1 }, { callId: 'denied' })],
    [call('route', { ticket: 2 }, { callId: 'accepted' })],
    [message('resolved')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY route',
    model: 'gpt-5.5',
    provider,
    handoffs: [
      new Handoff(new Agent({ instructions: 'TARGET_ONLY resolve' }), route),
    ],
  }).session();
  expect((await (await session.submit('Route')).wait()).finalOutput).toBe(
    'resolved',
  );
  expect(effects).toEqual([2]);
  expect(requestInstructions(server.requests[1])).toContain('SOURCE_ONLY');
  expect(requestInstructions(server.requests[2])).toContain('TARGET_ONLY');
  expect(output(server, 1, 'denied')).toBe('Use the next ticket');
  expect(output(server, 2, 'accepted')).toBe('accepted-2');
});

it('admits only one callback effect for conflicting targets in one batch', async () => {
  const effects: string[] = [];
  const route = (name: string, marker: string) =>
    tool({
      name,
      parameters: z.object({}),
      execute() {
        effects.push(marker);
        return marker;
      },
    });
  const server = new ModelServer([
    [
      call('route_a', {}, { callId: 'a' }),
      call('route_b', {}, { callId: 'b' }),
    ],
    [message('resolved')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY route',
    model: 'gpt-5.5',
    provider,
    handoffs: [
      new Handoff(
        new Agent({ instructions: 'TARGET_A_ONLY resolve' }),
        route('route_a', 'A'),
      ),
      new Handoff(
        new Agent({ instructions: 'TARGET_B_ONLY resolve' }),
        route('route_b', 'B'),
      ),
    ],
  }).session();
  expect((await (await session.submit('Route')).wait()).finalOutput).toBe(
    'resolved',
  );
  expect(effects).toHaveLength(1);
  expect(requestInstructions(server.requests[1])).toContain(
    `TARGET_${effects[0]}_ONLY`,
  );
});

it('rejects invalid payload before callback effects or target sampling', async () => {
  let effects = 0;
  const route = tool({
    name: 'route',
    parameters: z.object({ ticket: z.number() }),
    execute() {
      effects++;
      return 'accepted';
    },
  });
  const server = new ModelServer([
    [call('route', { ticket: 'invalid' }, { callId: 'invalid' })],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY route',
    model: 'gpt-5.5',
    provider,
    handoffs: [
      new Handoff(new Agent({ instructions: 'TARGET_ONLY resolve' }), route),
    ],
  }).session();
  await expect((await session.submit('Route')).wait()).rejects.toBeInstanceOf(
    z.ZodError,
  );
  expect(effects).toBe(0);
  expect(server.requests).toHaveLength(1);
});

it('awaits the callback and its finally before acknowledgement and activation', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>(),
    cleaned = Promise.withResolvers<void>();
  const route = tool({
    name: 'route',
    parameters: z.object({}),
    async execute() {
      entered.resolve();
      try {
        await release.promise;
        return 'awaited acknowledgement';
      } finally {
        cleaning.resolve();
        await cleaned.promise;
      }
    },
  });
  const server = new ModelServer([
    [call('route', {}, { callId: 'awaited' })],
    [message('resolved')],
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({ instructions: 'TARGET_ONLY resolve' });
  const agent = new Agent({
    instructions: 'SOURCE_ONLY route',
    model: 'gpt-5.5',
    provider,
    handoffs: [new Handoff(target, route)],
  });
  await using session = await agent.session();
  const turn = await session.submit('Route');
  let settled = false;
  const result = turn.wait().finally(() => {
    settled = true;
  });
  try {
    await entered.promise;
    expect(await session.getActiveAgent()).toBe(agent);
    release.resolve();
    await cleaning.promise;
    expect(settled).toBe(false);
    expect(server.requests).toHaveLength(1);
    expect(await session.getActiveAgent()).toBe(agent);
    cleaned.resolve();
    expect((await result).finalOutput).toBe('resolved');
    expect(await session.getActiveAgent()).toBe(target);
    expect(output(server, 1, 'awaited')).toBe('awaited acknowledgement');
  } finally {
    release.resolve();
    cleaned.resolve();
    await result.catch(() => {});
  }
});

it('joins cancelled callback cleanup without activating its target', async () => {
  const entered = Promise.withResolvers<void>(),
    cleaning = Promise.withResolvers<void>(),
    cleaned = Promise.withResolvers<void>();
  const route = tool({
    name: 'route',
    parameters: z.object({}),
    async execute(_args, context) {
      entered.resolve();
      try {
        await once(context.signal, 'abort');
        context.signal.throwIfAborted();
        return 'unreachable';
      } finally {
        cleaning.resolve();
        await cleaned.promise;
      }
    },
  });
  const server = new ModelServer([
    [call('route', {}, { callId: 'cancelled' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'SOURCE_ONLY route',
    model: 'gpt-5.5',
    provider,
    handoffs: [
      new Handoff(new Agent({ instructions: 'TARGET_ONLY resolve' }), route),
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('Route');
  let settled = false;
  const result = turn.wait().then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  let stopping: Promise<void> | undefined;
  try {
    await entered.promise;
    stopping = turn.cancel();
    await cleaning.promise;
    expect(settled).toBe(false);
    cleaned.resolve();
    await stopping;
    expect(await result).toBeInstanceOf(Error);
    expect(await session.getActiveAgent()).toBe(agent);
    expect(server.requests).toHaveLength(1);
  } finally {
    cleaned.resolve();
    stopping ??= turn.cancel();
    await stopping;
    await result;
  }
});

it.each([false, true])(
  'allows reordered/subset bindings while rejecting a same-key callback replacement (subset=%s)',
  async (subset) => {
    const effects: string[] = [];
    const helper = tool({
      name: 'helper',
      parameters: z.object({}),
      execute: () => 'ordinary',
    });
    const route = tool({
      name: 'route',
      parameters: z.object({}),
      execute() {
        effects.push('original');
        return 'original acknowledgement';
      },
    });
    const replacement = tool({
      name: 'route',
      parameters: z.object({}),
      execute() {
        effects.push('replacement');
        return 'wrong';
      },
    });
    const server = new ModelServer([
      [call('route', {}, { callId: 'reordered' })],
      [message('resolved')],
    ]);
    await using provider = await providerFor(server);
    const target = new Agent({ instructions: 'TARGET_ONLY resolve' });
    await using session = await new Agent({
      instructions: 'SOURCE_ONLY route',
      model: 'gpt-5.5',
      provider,
      tools: [helper],
      handoffs: [new Handoff(target, route)],
    }).session();
    await expect(
      session.update({ tools: [replacement, helper] }),
    ).rejects.toThrow('captured handoff callback');
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(0);
    await session.update({ tools: [route, helper] });
    if (subset) await session.update({ tools: [route] });
    expect((await (await session.submit('Route')).wait()).finalOutput).toBe(
      'resolved',
    );
    expect(effects).toEqual(['original']);
    expect(await session.getActiveAgent()).toBe(target);
    expect(output(server, 1, 'reordered')).toBe('original acknowledgement');
  },
);

it('does not transfer a same-name function in another canonical namespace', async () => {
  const effects: string[] = [];
  const ordinary = tool({
    name: 'route',
    namespace: 'other',
    parameters: z.object({}),
    execute() {
      effects.push('other');
      return 'ordinary';
    },
  });
  const transfer = tool({
    name: 'route',
    parameters: z.object({}),
    execute() {
      effects.push('handoff');
      return 'transferred';
    },
  });
  const server = new ModelServer([
    [call('route', {}, { callId: 'ordinary', namespace: 'other' })],
    [call('route', {}, { callId: 'transfer' })],
    [message('resolved')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY route',
    model: 'gpt-5.5',
    provider,
    tools: [ordinary],
    handoffs: [
      new Handoff(new Agent({ instructions: 'TARGET_ONLY resolve' }), transfer),
    ],
  }).session();
  expect((await (await session.submit('Route')).wait()).finalOutput).toBe(
    'resolved',
  );
  expect(effects).toEqual(['other', 'handoff']);
  expect(requestInstructions(server.requests[1])).toContain('SOURCE_ONLY');
  expect(requestInstructions(server.requests[2])).toContain('TARGET_ONLY');
});
