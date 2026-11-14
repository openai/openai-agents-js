import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  fileSearch,
  manualTool,
  parseSessionState,
  tool,
  toolRef,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
let recordId = 0;
const hostedRecord = () => ({
  type: 'file_search_call',
  id: `fs_${++recordId}`,
  status: 'completed',
  queries: ['synthetic'],
  results: [],
});
const hostedSpecs = (request: Record<string, any>) =>
  (request.tools ?? []).filter((item: any) => item.type === 'file_search');
const functions = (request: Record<string, any>) =>
  (request.tools ?? []).flatMap((item: any) =>
    item.type === 'function'
      ? [{ ...item, namespace: 'functions' }]
      : item.type === 'namespace'
        ? item.tools.map((entry: any) => ({ ...entry, namespace: item.name }))
        : [],
  );
async function providerFor(server: ModelServer) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-role-alias',
    supportsWebsockets: false,
  });
}

it('has been keeping provider records separate from one same-name local effect', async () => {
  let effects = 0;
  const hosted = fileSearch('vs_same_agent');
  const local = tool({
    name: 'file_search',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'actual-local-result';
    },
  });
  const server = new ModelServer([
    (request) => {
      expect(hostedSpecs(request)).toHaveLength(1);
      expect(
        functions(request).filter((t: any) => t.name === 'file_search'),
      ).toHaveLength(1);
      return [
        hostedRecord(),
        call('file_search', {}, { callId: 'actual-local-call' }),
      ];
    },
    (request) => {
      expect(JSON.stringify(request.input)).toContain('actual-local-result');
      return [message('complete')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use both types.',
    model: 'gpt-5.5',
    provider,
    tools: [hosted, local],
  }).session();
  expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
    'complete',
  );
  expect(effects).toBe(1);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
}, 30_000);

it.each([
  'plain-force',
  'functions-force',
  'local-subset',
  'hosted-subset',
  'hosted-force',
  'empty',
] as const)(
  'has been selecting the exact same-name role: %s',
  async (mode) => {
    let effects = 0;
    const hosted = fileSearch('vs_same_agent');
    const local = tool({
      name: 'file_search',
      parameters: z.object({}),
      finishTurn: true,
      execute: () => {
        effects++;
        return 'local completed';
      },
    });
    const wantsLocal =
      mode === 'plain-force' ||
      mode === 'functions-force' ||
      mode === 'local-subset';
    const server = new ModelServer([
      (request) => {
        if (wantsLocal) {
          expect(hostedSpecs(request)).toHaveLength(0);
          expect(functions(request)).toEqual([
            expect.objectContaining({
              name: 'file_search',
              namespace: 'functions',
            }),
          ]);
          if (mode.includes('force'))
            expect(request.tool_choice).toBe('required');
          return [call('file_search', {}, { callId: 'selected-local-call' })];
        }
        if (mode === 'empty') {
          expect(request.tools ?? []).toEqual([]);
          return [message('empty completed')];
        }
        expect(hostedSpecs(request)).toHaveLength(1);
        expect(functions(request)).toHaveLength(
          mode === 'hosted-force' ? 1 : 0,
        );
        if (mode === 'hosted-force')
          expect(request.tool_choice).toEqual({ type: 'file_search' });
        return [hostedRecord(), message('hosted completed')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use the chosen role.',
      model: 'gpt-5.5',
      provider,
      tools: [hosted, local],
      modelSettings:
        mode === 'plain-force'
          ? { toolChoice: toolRef('file_search') }
          : mode === 'functions-force'
            ? { toolChoice: toolRef('file_search', 'functions') }
            : mode === 'hosted-force'
              ? { toolChoice: { type: 'file_search' } }
              : undefined,
    }).session();
    const options =
      mode === 'local-subset'
        ? { tools: [local] }
        : mode === 'hosted-subset'
          ? { tools: [hosted] }
          : mode === 'empty'
            ? { tools: [] }
            : undefined;
    expect(
      (await (await session.submit('Run.', options)).wait()).finalOutput,
    ).toBe(
      wantsLocal
        ? 'local completed'
        : mode === 'empty'
          ? 'empty completed'
          : 'hosted completed',
    );
    expect(effects).toBe(wantsLocal ? 1 : 0);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
  30_000,
);

it('has been refusing a different hosted definition and a caller-owned internal namespace', async () => {
  let effects = 0;
  const hosted = fileSearch('vs_same_agent');
  const local = tool({
    name: 'file_search',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'forbidden';
    },
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'No work.',
    model: 'gpt-5.5',
    provider,
    tools: [hosted, local],
  }).session();
  await expect(
    session.submit('No work.', { tools: [fileSearch('vs_foreign')] }),
  ).rejects.toThrow();
  const impostor = tool({
    name: 'file_search',
    namespace: '_agents_sdk_hosted',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'forbidden';
    },
  });
  await expect(
    new Agent({
      instructions: 'No work.',
      model: 'gpt-5.5',
      provider,
      tools: [hosted, local, impostor],
    }).session(),
  ).rejects.toThrow(/reserved|namespace|internal/i);
  expect(effects).toBe(0);
  expect(server.requests).toHaveLength(0);
}, 30_000);

it('has been preserving a separate explicit local namespace without adding an alias', async () => {
  let effects = 0;
  const local = tool({
    name: 'file_search',
    namespace: 'crm',
    parameters: z.object({}),
    finishTurn: true,
    execute: () => {
      effects++;
      return 'namespaced completed';
    },
  });
  const server = new ModelServer([
    (request) => {
      expect(hostedSpecs(request)).toHaveLength(1);
      expect(functions(request)).toEqual([
        expect.objectContaining({ name: 'file_search', namespace: 'crm' }),
      ]);
      return [
        hostedRecord(),
        call('file_search', {}, { callId: 'crm-call', namespace: 'crm' }),
      ];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use crm.',
    model: 'gpt-5.5',
    provider,
    tools: [fileSearch('vs_same_agent'), local],
  }).session();
  expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
    'namespaced completed',
  );
  expect(effects).toBe(1);
  server.assertExhausted();
}, 30_000);

it('has been preserving a hosted-only legacy forced reference across a mixed graph and trusted cold restore', async () => {
  let effects = 0;
  const server = new ModelServer([
    [call('transfer_to_target', {}, { callId: 'legacy-transfer' })],
    (request) => {
      expect(hostedSpecs(request)).toHaveLength(1);
      expect(functions(request)).toHaveLength(0);
      expect(request.tool_choice).toBe('required');
      return [hostedRecord(), message('target completed')];
    },
    (request) => {
      expect(hostedSpecs(request)).toHaveLength(1);
      expect(functions(request)).toHaveLength(0);
      expect(request.tool_choice).toBe('required');
      return [hostedRecord(), message('cold completed')];
    },
  ]);
  await using provider = await providerFor(server);
  function graph() {
    const hosted = fileSearch('vs_same_agent');
    const target = new Agent({
      name: 'target',
      instructions: 'Use hosted.',
      tools: [hosted],
      modelSettings: { toolChoice: toolRef('file_search', 'functions') },
    });
    const local = tool({
      name: 'file_search',
      parameters: z.object({}),
      execute: () => {
        effects++;
        return 'forbidden';
      },
    });
    return {
      target,
      root: new Agent({
        instructions: 'Transfer.',
        model: 'gpt-5.5',
        provider,
        tools: [hosted, local],
        handoffs: [target],
      }),
    };
  }
  const original = graph();
  let state;
  {
    await using session = await original.root.session();
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'target completed',
    );
    const serialized = JSON.stringify(await session.saveState());
    state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }
  const current = graph();
  {
    await using restored = await current.root.session({ state });
    expect(await restored.getActiveAgent()).toBe(current.target);
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('cold completed');
  }
  expect(effects).toBe(0);
  server.assertExhausted();
}, 30_000);

it('has been refusing forced local omission instead of falling back to the hosted sibling', async () => {
  let effects = 0;
  const hosted = fileSearch('vs_same_agent');
  const local = tool({
    name: 'file_search',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'forbidden';
    },
  });
  const target = new Agent({
    name: 'target',
    instructions: 'Wait.',
    tools: [hosted, local],
  });
  const server = new ModelServer([
    [call('transfer_to_target', {}, { callId: 'mixed-transfer' })],
    [message('ready')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Transfer.',
    model: 'gpt-5.5',
    provider,
    tools: [hosted, local],
    handoffs: [target],
  }).session();
  expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
    'ready',
  );
  await expect(
    (async () =>
      (
        await session.submit('Do not fall back.', {
          tools: [hosted],
          modelSettingsOverride: { toolChoice: toolRef('file_search') },
        })
      ).wait())(),
  ).rejects.toThrow();
  expect(effects).toBe(0);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
}, 30_000);

it('has been preserving both selected roles through a genuine manual cold checkpoint', async () => {
  const hosted = fileSearch('vs_same_agent');
  const originalRecord = hostedRecord();
  const manual = manualTool({
    name: 'file_search',
    description: 'Read one manually supplied record.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [originalRecord, call('file_search', {}, { callId: 'manual-same-name' })],
    (request) => {
      expect(hostedSpecs(request)).toHaveLength(1);
      expect(
        functions(request).filter((t: any) => t.name === 'file_search'),
      ).toHaveLength(1);
      expect(
        (request.input as any[]).filter(
          (item) => item.type === 'file_search_call',
        ),
      ).toContainEqual(
        expect.objectContaining({ id: originalRecord.id, status: 'completed' }),
      );
      expect(JSON.stringify(request.input)).toContain('accepted-manual-result');
      return [message('manual completed')];
    },
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Wait for manual.',
    model: 'gpt-5.5',
    provider,
    tools: [hosted, manual],
  });
  let state;
  let stale;
  {
    await using session = await agent.session();
    const turn = await session.submit('Run.', { tools: [hosted, manual] });
    const batch = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in batch)) throw new Error('Expected manual request');
    const request = manual.match(batch.requests[0]);
    if (!request) throw new Error('Expected file_search grant');
    stale = request.reply('stale');
    const stopped = turn.wait().catch((e: unknown) => e);
    const raw = JSON.stringify(await session.suspend());
    expect(await stopped).toBeInstanceOf(InteractionRequired);
    state = parseSessionState(raw, {
      expectedSha256: createHash('sha256').update(raw).digest('hex'),
    });
  }
  await using restored = await agent.session({ state });
  expect(await restored.getActiveAgent()).toBe(agent);
  const batch = await restored.wait({ until: 'manual_tool' });
  if (!('requests' in batch))
    throw new Error('Expected restored manual request');
  const request = manual.match(batch.requests[0]);
  if (!request) throw new Error('Expected current manual grant');
  await expect(restored.respond(stale)).rejects.toThrow();
  await restored.respond(request.reply('accepted-manual-result'));
  expect((await restored.wait()).finalOutput).toBe('manual completed');
  server.assertExhausted();
}, 30_000);

it('has been refusing an incomplete provider FileSearch row at a local manual checkpoint', async () => {
  const hosted = fileSearch('vs_same_agent');
  const manual = manualTool({
    name: 'file_search',
    description: 'Read one manual record.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      { ...hostedRecord(), status: 'incomplete' },
      call('file_search', {}, { callId: 'incomplete-manual' }),
    ],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Wait.',
    model: 'gpt-5.5',
    provider,
    tools: [hosted, manual],
  }).session();
  const turn = await session.submit('Wait.', { tools: [hosted, manual] });
  const pending = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in pending))
    throw new Error('Expected genuine manual request');
  expect(manual.match(pending.requests[0])).toBeDefined();
  const stopped = turn.wait().catch((error: unknown) => error);
  await expect(session.suspend()).rejects.toThrow(/non-function|unsupported/);
  await turn.cancel();
  await stopped;
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
}, 30_000);
