import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeAgents,
  NativeError,
  NativeProvider,
  StdioMCP,
  manualTool,
  type Observation,
  type MCPCallContext,
  type MCPResultContext,
  type Session,
} from '../../src';
import { TurnAborted } from '../../src/runtime/session';
import * as telemetry from '../../src/runtime/telemetry';
import {
  ChildCallbacks,
  type ChildObservationProducer,
} from '../../src/runtime/child-callbacks';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

beforeAll(async () => {
  await telemetry.configure({ traceProcessors: [{ onEvent() {} }] });
});

afterAll(async () => {
  await telemetry.shutdown();
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await ModelServer.closeAll();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, 'MCP fixture cleanup failed');
});

const recordTool = {
  name: 'lookup',
  description: 'Read a record',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
};

async function peer(
  raw = 'lookup',
  heldCall?: Promise<void>,
  toolResult?: JsonObject,
  closeResponseForKey?: string,
) {
  const effects: JsonObject[] = [];
  const failures: unknown[] = [];
  let initializations = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: JsonObject = {};
      if (rpc.method === 'initialize') {
        initializations++;
        result = {
          protocolVersion: (rpc.params as JsonObject).protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'policy-peer', version: '1' },
        };
      }
      if (rpc.method === 'tools/list')
        result = { tools: [{ ...recordTool, name: raw }] };
      if (rpc.method === 'tools/call') {
        const params = rpc.params as JsonObject;
        effects.push(
          closeResponseForKey === undefined
            ? params
            : { ...params, initialization: initializations },
        );
        if (
          closeResponseForKey !== undefined &&
          (params.arguments as JsonObject | undefined)?.key ===
            closeResponseForKey
        ) {
          // End the POST's SSE stream without a reply or a resume event ID.
          response
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(': closing before reply\n\n');
          return;
        }
        if (heldCall) await heldCall;
        result = toolResult ?? {
          content: [{ type: 'text', text: 'record-result' }],
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer address');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(failures).toEqual([]);
  });
  return {
    effects,
    get initializations() {
      return initializations;
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
    raw,
  };
}
async function open(
  descriptor: HttpMCP | StdioMCP,
  responses: ConstructorParameters<typeof ModelServer>[0],
  children = false,
  programmaticToolCalling = false,
  tracing?: import('../../src/runtime/telemetry').TraceOptions,
) {
  const executor = children ? await startPublicExecutor() : undefined;
  if (executor) cleanup.push(() => executor.close());
  const model = new ModelServer(responses);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  const agent = new Agent({
    instructions: 'Use only the selected record tool.',
    provider,
    model: 'gpt-5.5',
    tools: [descriptor, ...(children ? [new NativeAgents()] : [])],
    programmaticToolCalling,
  });
  const session = await agent.session(
    executor
      ? {
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          }),
        }
      : { tracing },
  );
  cleanup.push(() => session.close());
  return { model, session, provider };
}
const lookup = () => ({
  ...call(
    'lookup',
    { key: 'original' },
    { namespace: 'mcp__fixture', callId: 'provider-call' },
  ),
  id: 'provider-item',
});

const firstEffect = 'record-before-close';
const laterEffect = 'record-after-close';
const laterResult = 'follow-up recorded';
const reconnectOptions = {
  name: 'fixture',
  tools: ['lookup'],
  approvalMode: 'preapproved',
  executionTimeout: 10,
} as const;
const reconnectResult = { content: [{ type: 'text', text: laterResult }] };

function reconnectResponses() {
  const record = (key: string) =>
    call('lookup', { key }, { callId: key, namespace: 'mcp__fixture' });
  // One submitted turn drives both calls. The second model step receives the
  // first result before issuing a distinct call on the same live client.
  return [[record(firstEffect)], [record(laterEffect)], [message('done')]];
}

function expectToolOutput(
  request: JsonObject,
  callId: string,
  text: string | RegExp,
) {
  const output = (request.input as JsonObject[]).find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  )?.output;
  expect(output, `model output for ${callId}`).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'input_text',
        text: typeof text === 'string' ? text : expect.stringMatching(text),
      }),
    ]),
  );
}

async function readRecords(path: string): Promise<JsonObject[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

it('REQ133 reconnects native stdio after a lost reply without replaying the effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-mcp-reconnect-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const roster = join(directory, 'roster.json');
  const effects = join(directory, 'effects.jsonl');
  const starts = join(directory, 'starts.jsonl');
  await writeFile(
    roster,
    JSON.stringify({
      tools: [recordTool],
      result: reconnectResult,
      exitAfterKey: firstEffect,
    }),
  );
  const { model, session } = await open(
    new StdioMCP({
      ...reconnectOptions,
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, 'mcp-peer.mjs'),
        roster,
        effects,
        starts,
      ],
      cwd: directory,
      lifetime: 'session',
    }),
    reconnectResponses(),
  );
  const startup = await readRecords(starts);
  expect(startup).toEqual([{ pid: expect.any(Number) }]);
  const originalPid = startup[0]!.pid;

  const turn = await session.submit('Record both entries.');
  expect((await turn.wait()).finalOutput).toBe('done');
  model.assertExhausted();
  expectToolOutput(model.requests[1]!, firstEffect, /\btransport ?closed\b/i);

  const recorded = await readRecords(effects);
  expect(recorded, 'stdio effects by process').toMatchObject([
    { name: 'lookup', arguments: { key: firstEffect }, pid: originalPid },
    {
      name: 'lookup',
      arguments: { key: laterEffect },
      pid: expect.any(Number),
    },
  ]);
  const replacementPid = recorded[1]!.pid;
  expect(replacementPid).not.toBe(originalPid);
  expect(await readRecords(starts)).toEqual([
    { pid: originalPid },
    { pid: replacementPid },
  ]);
  expectToolOutput(model.requests[2]!, laterEffect, laterResult);
}, 30_000);

it('REQ133 reconnects native streamable HTTP after an SSE response closes before its reply', async () => {
  const remote = await peer('lookup', undefined, reconnectResult, firstEffect);
  const { model, session } = await open(
    new HttpMCP({
      ...reconnectOptions,
      url: remote.url,
      activation: 'session',
    }),
    reconnectResponses(),
  );
  expect(remote.initializations).toBe(1);

  const turn = await session.submit('Record both entries.');
  expect((await turn.wait()).finalOutput).toBe('done');
  model.assertExhausted();
  expectToolOutput(model.requests[1]!, firstEffect, /\btransport ?closed\b/i);
  expectToolOutput(model.requests[2]!, laterEffect, laterResult);
  expect(remote.initializations, 'HTTP initialize requests').toBe(2);
  expect(remote.effects).toMatchObject([
    { name: 'lookup', arguments: { key: firstEffect }, initialization: 1 },
    { name: 'lookup', arguments: { key: laterEffect }, initialization: 2 },
  ]);
}, 30_000);

it('joins registered MCP and interception readers across replacement and manual suspension', async () => {
  const addon = await binding();
  const prototype = addon.NativeThread.prototype;
  const nextEvent = prototype._next_session_events;
  const nextMcp = prototype._next_native_mcp_result;
  const nextInterception = prototype._next_native_interception;
  const revokeMcp = prototype._revoke_native_mcp_results;
  const revokeInterception = prototype._revoke_native_interception;
  const finishReader = prototype._finish_child_event_reader;
  const retire = ChildCallbacks.prototype.retireObservations;
  const groups: ChildObservationProducer[] = [];
  const readers = new Map<NativeThread, ReturnType<typeof readerState>>();
  let releasing = false;
  function readerState() {
    return {
      shutdown: false,
      mainEnded: false,
      mcpEntered: false,
      interceptionEntered: false,
      mcpRevoked: false,
      interceptionRevoked: false,
      mcpNull: Promise.withResolvers<void>(),
      interceptionNull: Promise.withResolvers<void>(),
      releaseMcp: Promise.withResolvers<void>(),
      releaseInterception: Promise.withResolvers<void>(),
    };
  }
  const stateFor = (native: NativeThread) => {
    let state = readers.get(native);
    if (!state) readers.set(native, (state = readerState()));
    if (releasing) {
      state.releaseMcp.resolve();
      state.releaseInterception.resolve();
    }
    return state;
  };
  const releaseAll = () => {
    releasing = true;
    for (const state of readers.values()) {
      state.releaseMcp.resolve();
      state.releaseInterception.resolve();
    }
  };
  onTestFinished(releaseAll);
  const spies = [
    vi
      .spyOn(prototype, '_next_session_events')
      .mockImplementation(async function (this: NativeThread) {
        const raw = await nextEvent.call(this);
        const event = JSON.parse(firstNativeBatchWire(raw));
        if (!event.subagent_id && event.msg?.type === 'shutdown_complete')
          stateFor(this).shutdown = true;
        return raw;
      }),
    vi
      .spyOn(prototype, '_next_native_mcp_result')
      .mockImplementation(async function (this: NativeThread) {
        const state = stateFor(this);
        state.mcpEntered = true;
        const raw = await nextMcp.call(this);
        if (raw === 'null') {
          state.mcpNull.resolve();
          await state.releaseMcp.promise;
        }
        return raw;
      }),
    vi
      .spyOn(prototype, '_next_native_interception')
      .mockImplementation(async function (this: NativeThread) {
        const state = stateFor(this);
        state.interceptionEntered = true;
        const raw = await nextInterception.call(this);
        if (raw === 'null') {
          state.interceptionNull.resolve();
          await state.releaseInterception.promise;
        }
        return raw;
      }),
    vi
      .spyOn(prototype, '_revoke_native_mcp_results')
      .mockImplementation(function (this: NativeThread) {
        const state = stateFor(this);
        expect(state.shutdown).toBe(true);
        state.mcpRevoked = true;
        return revokeMcp.call(this);
      }),
    vi
      .spyOn(prototype, '_revoke_native_interception')
      .mockImplementation(function (this: NativeThread) {
        const state = stateFor(this);
        expect(state.shutdown).toBe(true);
        state.interceptionRevoked = true;
        return revokeInterception.call(this);
      }),
    vi
      .spyOn(prototype, '_finish_child_event_reader')
      .mockImplementation(function (this: NativeThread) {
        const result = finishReader.call(this);
        stateFor(this).mainEnded = true;
        return result;
      }),
    vi
      .spyOn(ChildCallbacks.prototype, 'retireObservations')
      .mockImplementation(function (
        this: ChildCallbacks,
        producer,
        notify,
        matches,
      ) {
        if (!matches) groups.push(producer);
        return retire.call(this, producer, notify, matches);
      }),
  ];
  const restoreSpies = () => {
    releaseAll();
    for (const spy of spies) spy.mockRestore();
  };
  onTestFinished(restoreSpies);
  const collect = async (stream: AsyncIterable<Observation>) => {
    const events: Observation[] = [];
    for await (const event of stream) events.push(event);
    return events;
  };
  let replacing: Promise<void> | undefined;
  let suspending: Promise<unknown> | undefined;
  try {
    const remote = await peer();
    const model = new ModelServer([
      [message('original')],
      [call('decision', {}, { callId: 'decision1' })],
    ]);
    const config = await model.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-reader-group',
      supportsWebsockets: false,
    });
    cleanup.push(() => provider.close());
    const session = await new Agent({
      instructions: 'Answer or ask for a decision.',
      provider,
      model: 'gpt-5.5',
      programmaticToolCalling: false,
      tools: [
        new HttpMCP({ name: 'fixture', url: remote.url, tools: ['lookup'] }),
        manualTool({
          name: 'decision',
          description: 'Ask.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
    }).session();
    cleanup.push(() => session.close());
    const original = await session.submit('Record original context.');
    const originalEvents = await collect(original.events());
    expect(readers.size).toBe(1);
    const source = [...readers.values()][0]!;
    expect(source.mcpEntered && source.interceptionEntered).toBe(true);
    let replaced = false;
    replacing = session
      .compact({ summary: 'Retain the original context.' })
      .then(() => {
        replaced = true;
      });
    void replacing.catch(() => {});
    await Promise.race([
      Promise.all([source.mcpNull.promise, source.interceptionNull.promise]),
      replacing,
    ]);
    expect(groups).toHaveLength(0);
    source.releaseInterception.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(source.mainEnded).toBe(true);
    expect(groups).toHaveLength(0);
    expect(replaced).toBe(false);
    source.releaseMcp.resolve();
    await replacing;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ended).toBe(true);
    expect(readers.size).toBe(2);
    const candidate = [...readers.values()][1]!;
    expect(candidate.mcpEntered && candidate.interceptionEntered).toBe(true);
    const turn = await session.submit('Ask for a decision.');
    const observed = collect(turn.events());
    void observed.catch(() => {});
    for await (const event of session.events())
      if (event.type === 'action_requested' && event.callId === 'decision1')
        break;
    // Explicit suspend accepts this portable non-Code-Mode MCP configuration;
    // automatic no-handler checkpoint capability is a separate conservative gate.
    suspending = session.suspend();
    void suspending.catch(() => {});
    await expect(suspending).resolves.toMatchObject({ format_version: 5 });
    await Promise.all([
      candidate.mcpNull.promise,
      candidate.interceptionNull.promise,
    ]);
    expect(candidate.mcpRevoked && candidate.interceptionRevoked).toBe(true);
    expect(groups).toHaveLength(1);
    candidate.releaseMcp.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(groups).toHaveLength(1);
    candidate.releaseInterception.resolve();
    await vi.waitFor(() => expect(groups).toHaveLength(2));
    expect(groups[1]!.ended).toBe(true);
    expect(groups[1]).not.toBe(groups[0]);
    const events = await observed;
    expect(await collect(turn.events())).toEqual(events);
    expect(await collect(original.events())).toEqual(originalEvents);
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(2);
    model.assertExhausted();
    // This verifies Session reader registration and shutdown wiring, not a
    // public reproduction of a child notice queued beyond child-stream EOF.
  } finally {
    restoreSpies();
    await Promise.allSettled(
      [replacing, suspending].filter((work) => work !== undefined),
    );
  }
}, 30_000);

it.each(['direct', 'code'] as const)(
  'applies replacement and approval once before an actual %s MCP effect',
  async (route) => {
    const structuredResult = JSON.parse(
      '{"content":[{"type":"text","text":"record-result"}],"structuredContent":{"__proto__":{"ownKeyRetained":"mcp-json-key"},"constructor":{"prototype":"data"}}}',
    ) as JsonObject;
    const remote = await peer('lookup', undefined, structuredResult);
    const before = vi.fn((ctx: MCPCallContext) => {
      expect(ctx.originalArguments).toEqual({ key: 'original' });
      return {
        action: 'replaceArguments' as const,
        arguments: { key: 'effective' },
      };
    });
    const approval = vi.fn(async (ctx: MCPCallContext) => {
      expect(ctx.effectiveArguments).toEqual({ key: 'effective' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return true;
    });
    const transformResult = vi.fn(
      (ctx: MCPResultContext, result: JsonObject) => {
        expect(ctx.toolName).toBe('lookup');
        const structured = result.structuredContent as JsonObject;
        expect(Object.hasOwn(structured, '__proto__')).toBe(true);
        expect(structured).toEqual(structuredResult.structuredContent);
        expect(Object.getPrototypeOf(structured)).toBe(Object.prototype);
        expect(Object.prototype).not.toHaveProperty('ownKeyRetained');
        return result;
      },
    );
    const selected =
      route === 'direct'
        ? lookup()
        : {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'outer-provider',
            input:
              'text(JSON.stringify(await tools.mcp__fixture__lookup({key:"original"})));',
          };
    const { model, session } = await open(
      new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        before,
        approval,
        transformResult,
      }),
      [
        [selected],
        (request) => {
          expect(JSON.stringify(request.input)).toContain('mcp-json-key');
          // Direct MCP projects structuredContent; CodeMode returns the full result.
          if (route === 'code')
            expect(JSON.stringify(request.input)).toContain('record-result');
          if (route === 'direct') {
            const item = (request.input as JsonObject[]).find(
              (item) =>
                item.type === 'function_call' &&
                item.call_id === 'provider-call',
            );
            expect(item).toBeDefined();
            expect(item?.id).not.toBe('provider-item');
            expect(JSON.parse(item!.arguments as string)).toEqual({
              key: 'effective',
            });
          }
          return [message('done')];
        },
      ],
      false,
      route === 'code',
    );
    const turn = await session.submit('read');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(before).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(transformResult).toHaveBeenCalledTimes(1);
    expect(
      remote.effects.map(({ name, arguments: args }) => ({
        name,
        arguments: args,
      })),
    ).toEqual([{ name: 'lookup', arguments: { key: 'effective' } }]);
    expect(remote.effects[0]?._meta).toMatchObject({
      callId: transformResult.mock.calls[0]![0].callId,
    });
    expect(transformResult.mock.calls[0]![0]).toMatchObject({
      submission: turn,
      serverName: 'fixture',
      toolName: 'lookup',
    });
    expect(before.mock.calls[0]?.[0]).toMatchObject({
      serverName: 'fixture',
      toolName: 'lookup',
      submission: turn,
      call: { route, callId: route === 'direct' ? 'provider-call' : null },
    });
    if (route === 'code')
      expect(before.mock.calls[0]?.[0].call).toMatchObject({
        outerCallId: 'outer-provider',
        cellId: expect.any(String),
        nestedCallId: expect.any(String),
      });
    const history = [];
    for await (const item of session.items()) history.push(item);
    if (route === 'direct')
      expect(JSON.stringify(history)).not.toContain('provider-item');
    model.assertExhausted();
  },
  15_000,
);

it('rejects unexpected MCP calls during native compaction without consuming the next turn', async () => {
  const remote = await peer();
  const approval = vi.fn((_ctx: MCPCallContext) => true);
  const { model, session } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      approval,
    }),
    [
      [message('Remembered.')],
      [
        call(
          'lookup',
          { key: 'unexpected-summary' },
          { namespace: 'mcp__fixture', callId: 'unexpected-summary-call' },
        ),
        message('Summary of the remembered input.'),
      ],
      [
        call(
          'lookup',
          { key: 'real-search' },
          { namespace: 'mcp__fixture', callId: 'real-search-call' },
        ),
      ],
      [message('Continued after the real tool call.')],
    ],
  );
  expect(
    (await (await session.submit('Remember this input.')).wait()).finalOutput,
  ).toBe('Remembered.');
  await expect(session.compact()).rejects.toBeInstanceOf(NativeError);
  expect(approval).not.toHaveBeenCalled();
  expect(remote.effects).toEqual([]);
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]?.tools ?? []).toEqual([]);
  expect(model.requests[1]?.input).not.toContainEqual(
    expect.objectContaining({ type: 'additional_tools' }),
  );
  expect(JSON.stringify(await session.saveState())).not.toContain(
    'unexpected-summary-call',
  );
  expect((await (await session.submit('Search now.')).wait()).finalOutput).toBe(
    'Continued after the real tool call.',
  );
  expect(approval).toHaveBeenCalledTimes(1);
  expect(approval.mock.calls[0]?.[0].call.callId).toBe('real-search-call');
  expect(remote.effects).toHaveLength(1);
  expect(remote.effects[0]).toMatchObject({
    name: 'lookup',
    arguments: { key: 'real-search' },
  });
  model.assertExhausted();
}, 30_000);

it.each([false, true])(
  'preserves before and approval enforcement after supplied compaction with approval=%s',
  async (allowed) => {
    const remote = await peer();
    const before = vi.fn((ctx: MCPCallContext) => {
      expect(ctx.originalArguments).toEqual({ key: 'original' });
      return {
        action: 'replaceArguments' as const,
        arguments: { key: 'after-compaction' },
      };
    });
    const approval = vi.fn((ctx: MCPCallContext) => {
      expect(ctx.effectiveArguments).toEqual({ key: 'after-compaction' });
      return allowed;
    });
    const { model, session } = await open(
      new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        before,
        approval,
      }),
      [
        [message('original')],
        [lookup()],
        ...(allowed ? [[message('allowed')]] : []),
      ],
    );
    const original = await session.submit('Record original context.');
    expect((await original.wait()).finalOutput).toBe('original');
    const id = session.id;
    await session.compact({ summary: 'Retain the original context.' });
    expect(session.id).toBe(id);
    expect(model.requests).toHaveLength(1);
    expect(remote.effects).toEqual([]);
    const turn = await session.submit('Read after supplied compaction.');
    if (allowed) {
      expect((await turn.wait()).finalOutput).toBe('allowed');
      expect(
        remote.effects.map(({ name, arguments: args }) => ({
          name,
          arguments: args,
        })),
      ).toEqual([{ name: 'lookup', arguments: { key: 'after-compaction' } }]);
    } else {
      await expect(turn.wait()).rejects.toThrow();
      expect(remote.effects).toEqual([]);
    }
    expect(before).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledTimes(1);
    for (const ctx of [before.mock.calls[0]![0], approval.mock.calls[0]![0]]) {
      expect(ctx.submission).toBe(turn);
      expect(ctx.call).toMatchObject({
        sessionId: id,
        turnId: turn.turnId,
        route: 'direct',
        callId: 'provider-call',
      });
    }
    model.assertExhausted();
  },
  30_000,
);

it.each(['false', 'nonboolean', 'throw'] as const)(
  'denies %s application approval without peer effect or a provider continuation',
  async (choice) => {
    const remote = await peer();
    const approval = vi.fn(() => {
      if (choice === 'throw') throw new Error('private-policy-secret');
      return (choice === 'false' ? false : 'truthy') as boolean;
    });
    const { model, session } = await open(
      new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        approval,
      }),
      [[lookup()]],
    );
    const turn = await session.submit('read');
    let failure: unknown;
    try {
      await turn.wait();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain('private-policy-secret');
    expect(remote.effects).toEqual([]);
    expect(approval).toHaveBeenCalledTimes(1);
    model.assertExhausted();
  },
  10_000,
);

it('does not turn application approval into native approval authority', async () => {
  const remote = await peer();
  const approval = vi.fn(() => true);
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'native',
      approval,
    }),
    [[lookup()]],
  );
  const turn = await session.submit('read');
  const pending = await turn.wait({ until: 'interaction' });
  if (!('requests' in pending))
    throw new Error('Expected a live native approval');
  expect(pending.turn).toBe(turn);
  expect(pending.requests).toHaveLength(1);
  expect(pending.requests[0]?.type).toBe('approval_request');
  expect(approval).toHaveBeenCalledTimes(1);
  expect(remote.effects).toEqual([]);
  model.assertExhausted();
  const completion = turn.wait();
  completion.catch(() => {});
  await Promise.all([
    turn.cancel({ mode: 'force' }),
    expect(completion).rejects.toBeInstanceOf(TurnAborted),
  ]);
  expect(approval).toHaveBeenCalledTimes(1);
  expect(remote.effects).toEqual([]);
  model.assertExhausted();
}, 10_000);

it('adds and removes the last policy then returns to ordinary MCP updates', async () => {
  const remote = await peer();
  const before = vi.fn(() => ({ action: 'allow' as const }));
  const plain = () =>
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
    });
  const { session, model } = await open(plain(), [
    [lookup()],
    [message('first')],
    [lookup()],
    [message('second')],
    [lookup()],
    [message('third')],
  ]);
  expect((await (await session.submit('first')).wait()).finalOutput).toBe(
    'first',
  );
  await session.update({
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        before,
      }),
    ],
  });
  expect((await (await session.submit('second')).wait()).finalOutput).toBe(
    'second',
  );
  await session.update({ tools: [plain()] });
  await session.update({ tools: [plain()] });
  expect((await (await session.submit('third')).wait()).finalOutput).toBe(
    'third',
  );
  expect(before).toHaveBeenCalledTimes(1);
  expect(remote.effects).toHaveLength(3);
  model.assertExhausted();
}, 15_000);

it('close revokes approval promptly while joining an uncooperative physical callback', async () => {
  const remote = await peer();
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const held = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      approval(ctx) {
        signal = ctx.signal;
        return held;
      },
    }),
    [[lookup()]],
  );
  let observed: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let closeFailure: unknown;
  let closed = false;
  try {
    const turn = await session.submit('read');
    observed = turn.wait().catch(() => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    closing = session.close().then(
      () => {
        closed = true;
      },
      (error) => {
        closeFailure = error;
      },
    );
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(closed).toBe(false);
    expect(remote.effects).toEqual([]);
  } finally {
    release();
  }
  await closing;
  await observed;
  if (closeFailure !== undefined) throw closeFailure;
  expect(remote.effects).toEqual([]);
  model.assertExhausted();
}, 15_000);

it('application deadline force-stops approval but retains physical and failed engine cleanup', async () => {
  const remote = await peer();
  let signal: AbortSignal | undefined;
  const release = Promise.withResolvers<void>();
  const lifecycle: string[] = [];
  const { session, model, provider } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      async approval(ctx) {
        signal = ctx.signal;
        await release.promise;
        lifecycle.push('callback joined');
        return true;
      },
    }),
    [[lookup()]],
  );
  const addon = await binding();
  const originalClose = addon.NativeThread.prototype._close_report;
  let nativeClosed = false;
  const threadClose = vi
    .spyOn(addon.NativeThread.prototype, '_close_report')
    .mockImplementation(async function (this: NativeThread) {
      const report = await originalClose.call(this);
      if (!nativeClosed) {
        nativeClosed = true;
        lifecycle.push('native thread closed');
      }
      return report;
    });
  const incomplete = new Error('engine cleanup incomplete after deadline');
  const engineClose = vi
    .spyOn(addon.Engine.prototype, '_close_report')
    .mockRejectedValueOnce(incomplete);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observed: Promise<unknown> | undefined;
  let closing: Promise<unknown> | undefined;
  let turnSettled = false;
  let closeSettled = false;
  try {
    const turn = await session.submit('read');
    observed = turn.wait().then(
      (result) => {
        turnSettled = true;
        return result;
      },
      (error: unknown) => {
        turnSettled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    const deadline = Promise.withResolvers<void>();
    // The host owns this timer outside the approval's callback scope.
    timer = setTimeout(() => deadline.resolve(), 20);
    await deadline.promise;
    lifecycle.push('deadline reached');
    await session.interrupt({ scope: 'root', mode: 'force' });
    lifecycle.push('stop accepted');
    expect(signal?.aborted).toBe(true);
    expect(remote.effects).toEqual([]);

    closing = session.close().then(
      () => {
        closeSettled = true;
        return undefined;
      },
      (error: unknown) => {
        closeSettled = true;
        lifecycle.push('cleanup failed');
        return error;
      },
    );
    // A real native close receipt separates physical JS cleanup from Core work.
    await vi.waitFor(() => expect(nativeClosed).toBe(true), { timeout: 5000 });
    expect(closeSettled).toBe(false);
    expect(turnSettled).toBe(false);
    expect(engineClose).not.toHaveBeenCalled();
    await expect(provider.close()).rejects.toBeInstanceOf(Error);

    release.resolve();
    expect(await closing).toBe(incomplete);
    expect(await observed).toBeInstanceOf(TurnAborted);
    expect(remote.effects).toEqual([]);
    const nativeCloseCalls = threadClose.mock.calls.length;
    expect(nativeCloseCalls).toBeGreaterThan(0);
    expect(engineClose).toHaveBeenCalledTimes(1);
    await expect(provider.close()).rejects.toBeInstanceOf(Error);
    await expect(session.submit('do not resume')).rejects.toBeInstanceOf(Error);

    // Failed engine cleanup retains this Session's lease and retry phase.
    await session.close();
    lifecycle.push('cleanup joined');
    expect(threadClose).toHaveBeenCalledTimes(nativeCloseCalls);
    expect(engineClose).toHaveBeenCalledTimes(2);
    await provider.close();
    lifecycle.push('provider disposed');
    expect(lifecycle).toEqual([
      'deadline reached',
      'stop accepted',
      'native thread closed',
      'callback joined',
      'cleanup failed',
      'cleanup joined',
      'provider disposed',
    ]);
    expect(remote.effects).toEqual([]);
    model.assertExhausted();
  } finally {
    clearTimeout(timer);
    release.resolve();
    await closing;
    engineClose.mockRestore();
    threadClose.mockRestore();
    await session.close();
    await observed;
    await provider.close();
  }
}, 20_000);

it('joins a held result transform after native close without failing cleanup', async () => {
  const remote = await peer();
  const release = Promise.withResolvers<void>();
  let entered = false;
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      async transformResult(_context, result) {
        entered = true;
        await release.promise;
        return result;
      },
    }),
    [[lookup()]],
  );
  const addon = await binding();
  const originalReport = addon.NativeThread.prototype._close_report;
  let nativeClosed = false;
  const report = vi
    .spyOn(addon.NativeThread.prototype, '_close_report')
    .mockImplementation(async function (this: NativeThread) {
      const result = await originalReport.call(this);
      nativeClosed = true;
      return result;
    });
  let observed: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let closeFailure: unknown;
  let closed = false;
  try {
    const turn = await session.submit('read');
    observed = turn.wait().catch(() => {});
    await vi.waitFor(() => expect(entered).toBe(true));
    closing = session.close().then(
      () => {
        closed = true;
      },
      (error) => {
        closeFailure = error;
      },
    );
    await vi.waitFor(() => expect(nativeClosed).toBe(true));
    expect(closed).toBe(false);
    expect(remote.effects).toHaveLength(1);
    release.resolve();
    await closing;
    await observed;
    if (closeFailure !== undefined) throw closeFailure;
    expect(closed).toBe(true);
    expect(remote.effects).toHaveLength(1);
    model.assertExhausted();
  } finally {
    release.resolve();
    try {
      await closing;
      await observed;
    } finally {
      report.mockRestore();
    }
  }
}, 15_000);

it('keeps a real child policy on its original owner when root-idle update is refused', async () => {
  const remote = await peer('find-record');
  const executor = await startPublicExecutor();
  cleanup.push(() => executor.close());
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'child', message: 'Read find-record.' },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ]
        : [message('root done')];
    return count === 1
      ? [
          call(
            'find_record',
            { key: 'child' },
            { namespace: 'mcp__fixture', callId: 'child-provider-call' },
          ),
        ]
      : [message('child done')];
  };
  const model = new ModelServer(Array.from({ length: 5 }, () => respond));
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  let release!: () => void;
  const held = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  let identity: MCPCallContext | undefined;
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    tools: ['find-record'],
    approvalMode: 'preapproved',
    approval(ctx) {
      identity = ctx;
      return held;
    },
  });
  const replacement = vi.fn(() => true);
  const agent = new Agent({
    instructions: 'Delegate.',
    provider,
    model: 'gpt-5.5',
    tools: [new NativeAgents(), descriptor],
  });
  const session: Session = await agent.session({
    environment: new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    }),
  });
  cleanup.push(() => session.close());
  try {
    expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
      'root done',
    );
    await vi.waitFor(() => expect(identity?.call.childId).toBeTruthy());
    await expect(
      session.update({
        tools: [
          new HttpMCP({
            name: 'fixture',
            url: remote.url,
            tools: ['find-record'],
            approvalMode: 'preapproved',
            approval: replacement,
          }),
        ],
      }),
    ).rejects.toThrow();
    expect(replacement).not.toHaveBeenCalled();
    expect(remote.effects).toEqual([]);
    const children = [];
    for await (const child of session.subagents()) children.push(child);
    const child = children.find((child) => child.id === identity?.call.childId);
    expect(child?.turn).toBeTruthy();
    expect(identity).toMatchObject({
      serverName: 'fixture',
      toolName: 'find-record',
      call: {
        sessionId: session.id,
        childId: child!.id,
        turnId: child!.turn!.turnId,
        callId: 'child-provider-call',
      },
    });
    release();
    expect((await child!.turn!.wait()).finalOutput).toBe('child done');
    expect(
      remote.effects.map(({ name, arguments: args }) => ({
        name,
        arguments: args,
      })),
    ).toEqual([{ name: 'find-record', arguments: { key: 'child' } }]);
    expect(remote.effects[0]?._meta).toMatchObject({
      callId: 'child-provider-call',
    });
    // A completed child turn still owns an open child runtime.
    await expect(
      session.update({
        tools: [
          new HttpMCP({
            name: 'fixture',
            url: remote.url,
            tools: ['find-record'],
            approvalMode: 'preapproved',
            approval: replacement,
          }),
        ],
      }),
    ).rejects.toThrow();
    expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
      'root done',
    );
    expect(replacement).not.toHaveBeenCalled();
    expect(remote.effects).toHaveLength(1);
    model.assertExhausted();
  } finally {
    release();
  }
}, 20_000);

it.each(['add', 'remove', 'replace', 'retain'] as const)(
  'allows NativeAgents pre-policy %s before any child exists',
  async (change) => {
    const remote = await peer();
    const original = vi.fn(() => true);
    const replacement = vi.fn(() => true);
    const declaration = (approval?: () => boolean) =>
      new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        approval,
      });
    const { session, model } = await open(
      declaration(change === 'add' ? undefined : original),
      [[lookup()], [message('still usable')]],
      true,
    );
    await session.update({
      tools: [
        declaration(
          change === 'remove'
            ? undefined
            : change === 'retain'
              ? original
              : replacement,
        ),
      ],
    });
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'still usable',
    );
    expect(original).toHaveBeenCalledTimes(change === 'retain' ? 1 : 0);
    expect(replacement).toHaveBeenCalledTimes(
      change === 'add' || change === 'replace' ? 1 : 0,
    );
    expect(remote.effects).toHaveLength(1);
    model.assertExhausted();
  },
  15_000,
);

it('gives a new native child the accepted MCP roster and callback generation', async () => {
  const originalPeer = await peer();
  const replacementPeer = await peer();
  const original = vi.fn(() => true);
  const replacement = vi.fn((_ctx: MCPCallContext) => true);
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'child', message: 'Read lookup.' },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ]
        : [message('root done')];
    return count === 1
      ? [
          call(
            'lookup',
            { key: 'child' },
            { namespace: 'mcp__fixture', callId: 'child-provider-call' },
          ),
        ]
      : [message('child done')];
  };
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: originalPeer.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      approval: original,
    }),
    Array.from({ length: 4 }, () => respond),
    true,
  );
  await session.update({
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: replacementPeer.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        approval: replacement,
      }),
    ],
  });
  expect((await (await session.submit('delegate')).wait()).finalOutput).toBe(
    'root done',
  );
  await vi.waitFor(() => expect(replacement).toHaveBeenCalledTimes(1));
  const identity = replacement.mock.calls[0]![0];
  const children = [];
  for await (const child of session.subagents()) children.push(child);
  const child = children.find((child) => child.id === identity.call.childId);
  expect(child?.turn).toBeTruthy();
  expect(identity).toMatchObject({
    serverName: 'fixture',
    toolName: 'lookup',
    call: {
      sessionId: session.id,
      childId: child!.id,
      turnId: child!.turn!.turnId,
      callId: 'child-provider-call',
    },
  });
  expect((await child!.turn!.wait()).finalOutput).toBe('child done');
  expect(original).not.toHaveBeenCalled();
  expect(originalPeer.effects).toEqual([]);
  expect(replacementPeer.effects).toMatchObject([
    { name: 'lookup', arguments: { key: 'child' } },
  ]);
  model.assertExhausted();
}, 20_000);

it('excludes configured-disabled questions from a real child catalog while preserving MCP dispatch', async () => {
  const remote = await peer();
  const approval = vi.fn((_ctx: MCPCallContext) => true);
  const excluded = [
    'request_user_input',
    'request_user_input_async',
    'send_user_message_async',
    // NativeAgents separately disables this non-question message feature.
    'send_message_to_user_async',
  ];
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const childRequests: JsonObject[] = [];
  const reply = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count === 1
        ? [
            call(
              'spawn_agent',
              {
                task_name: 'child',
                message: 'Use permitted tools and read lookup.',
              },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ]
        : [message('root done')];
    childRequests.push(request);
    return count === 1
      ? [
          call(
            'lookup',
            { key: 'child' },
            { namespace: 'mcp__fixture', callId: 'allowed-read' },
          ),
        ]
      : [message('child read MCP without questions')];
  };
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      approval,
    }),
    Array.from({ length: 4 }, () => reply),
    true,
  );
  expect((await (await session.submit('Delegate.')).wait()).finalOutput).toBe(
    'root done',
  );
  await vi.waitFor(() => expect(approval).toHaveBeenCalledTimes(1));
  const identity = approval.mock.calls[0]![0].call;
  const children = await Array.fromAsync(session.subagents());
  expect(children).toHaveLength(1);
  const child = children[0]!;
  expect(child.id).toBe(identity.childId);
  expect(identity).toMatchObject({
    sessionId: session.id,
    turnId: child.turn!.turnId,
    callId: 'allowed-read',
  });
  expect((await child.turn!.wait()).finalOutput).toBe(
    'child read MCP without questions',
  );
  expect(childRequests).toHaveLength(2);
  for (const request of childRequests) {
    expect(Array.isArray(request.tools)).toBe(true);
    const identities = (request.tools as JsonObject[]).flatMap((spec) =>
      spec.type === 'namespace'
        ? (spec.tools as JsonObject[]).map((tool) => ({
            namespace: spec.name,
            name: tool.name,
          }))
        : [{ namespace: null, name: spec.name }],
    );
    expect(identities).toHaveLength(7);
    expect(identities).toEqual(
      expect.arrayContaining([
        { namespace: null, name: 'exec_command' },
        { namespace: null, name: 'write_stdin' },
        { namespace: null, name: 'list_mcp_resources' },
        { namespace: null, name: 'list_mcp_resource_templates' },
        { namespace: null, name: 'read_mcp_resource' },
        { namespace: null, name: 'apply_patch' },
        { namespace: 'mcp__fixture', name: 'lookup' },
      ]),
    );
    for (const name of excluded)
      expect(identities.map((tool) => tool.name)).not.toContain(name);
    for (const item of request.input as JsonObject[])
      expect(item.type).not.toBe('additional_tools');
  }
  const outputs = (childRequests[1]!.input as JsonObject[]).filter(
    (item) => item.type === 'function_call_output',
  );
  expect(
    outputs.find((item) => item.call_id === 'allowed-read')?.output,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'input_text', text: 'record-result' }),
    ]),
  );
  expect(remote.effects).toMatchObject([
    { name: 'lookup', arguments: { key: 'child' } },
  ]);
  expect(approval).toHaveBeenCalledTimes(1);
  model.assertExhausted();
}, 30_000);

it('updates the restored root MCP policy before reloading its recorded cold child', async () => {
  const oldPeer = await peer();
  const currentPeer = await peer();
  const oldApproval = vi.fn((_ctx: MCPCallContext) => true);
  const currentApproval = vi.fn((_ctx: MCPCallContext) => true);
  let rootId: string | undefined;
  let target: string | undefined;
  let restored = false;
  const counts = new Map<string, number>();
  const reply = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const key = `${restored}:${id}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (id === rootId)
      return count === 1
        ? [
            call(
              restored ? 'followup_task' : 'spawn_agent',
              restored
                ? { target: target!, message: 'Read again.' }
                : { task_name: 'child', message: 'Read lookup.' },
              {
                namespace: 'collaboration',
                callId: restored ? 'wake' : 'spawn',
              },
            ),
          ]
        : [message('root done')];
    return count === 1
      ? [
          call(
            'lookup',
            { key: restored ? 'current' : 'source' },
            {
              namespace: 'mcp__fixture',
              callId: restored ? 'current-read' : 'source-read',
            },
          ),
        ]
      : [message('child done')];
  };
  const executor = await startPublicExecutor();
  cleanup.push(() => executor.close());
  const model = new ModelServer(Array.from({ length: 8 }, () => reply));
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  const descriptor = (url: string, approval: typeof oldApproval) =>
    new HttpMCP({
      name: 'fixture',
      url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      approval,
    });
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider,
    tools: [new NativeAgents(), descriptor(oldPeer.url, oldApproval)],
  });
  // NativeAgents and MCP leave the captured function catalog empty throughout.
  expect(
    agent.tools.every(
      (tool) => tool instanceof NativeAgents || tool instanceof HttpMCP,
    ),
  ).toBe(true);
  const environment = new Environment({
    url: executor.url,
    cwd: executor.cwd,
    headers: executor.headers,
    tools: ['exec_command', 'write_stdin', 'apply_patch'],
  });
  let state;
  let oldIncarnation: string | null;
  let sourceHistory: unknown[];
  {
    await using source = await agent.session({ environment });
    expect((await (await source.submit('Delegate.')).wait()).finalOutput).toBe(
      'root done',
    );
    await vi.waitFor(() => expect(oldApproval).toHaveBeenCalledTimes(1));
    const invocation = oldApproval.mock.calls[0]![0].call;
    expect(invocation.childId).toBeTruthy();
    target = invocation.childId!;
    const children = await Array.fromAsync(source.subagents());
    const child = children.find((row) => row.id === target)!;
    expect((await child.turn!.wait()).finalOutput).toBe('child done');
    oldIncarnation = invocation.childIncarnation;
    expect(oldIncarnation).toBeTruthy();
    sourceHistory = await Array.fromAsync(source.items({ subagentId: target }));
    state = await source.saveState();
  }
  restored = true;
  await using session = await agent.session({ environment, state });
  expect(session.id).toBe(rootId);
  const cold = await Array.fromAsync(session.subagents());
  expect(cold).toHaveLength(1);
  expect(cold[0]).toMatchObject({
    id: target,
    status: 'active',
    isLive: false,
    turn: null,
  });
  const history = await Array.fromAsync(session.items({ subagentId: target }));
  expect(history.length).toBeGreaterThan(0);
  expect(history).toEqual(sourceHistory!);
  const rootHistory = await Array.fromAsync(session.items());
  await session.update({
    tools: [descriptor(currentPeer.url, currentApproval)],
  });
  expect(session.id).toBe(rootId);
  expect(await Array.fromAsync(session.items())).toEqual(rootHistory);
  expect(await Array.fromAsync(session.items({ subagentId: target }))).toEqual(
    history,
  );
  expect((await Array.fromAsync(session.subagents()))[0]).toMatchObject({
    id: target,
    isLive: false,
  });
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'root done',
  );
  await vi.waitFor(() => expect(currentApproval).toHaveBeenCalledTimes(1));
  const invocation = currentApproval.mock.calls[0]![0].call;
  expect(invocation).toMatchObject({
    sessionId: session.id,
    childId: target,
    callId: 'current-read',
  });
  const child = (await Array.fromAsync(session.subagents()))[0]!;
  expect(child.id).toBe(target);
  expect(invocation.childIncarnation).toBeTruthy();
  expect(invocation.childIncarnation).not.toBe(oldIncarnation!);
  expect(invocation.turnId).toBe(child.turn!.turnId);
  const submission = currentApproval.mock.calls[0]![0].submission;
  expect(submission.childId).toBe(child.id);
  expect(submission.instanceId).toBe(child.turn!.instanceId);
  expect(submission.turnId).toBe(child.turn!.turnId);
  expect((await child.turn!.wait()).finalOutput).toBe('child done');
  await expect(cold[0]!.submit('Stale cold snapshot')).rejects.toThrow();
  expect(oldApproval).toHaveBeenCalledTimes(1);
  expect(oldPeer.effects).toMatchObject([
    { name: 'lookup', arguments: { key: 'source' } },
  ]);
  expect(currentPeer.effects).toMatchObject([
    { name: 'lookup', arguments: { key: 'current' } },
  ]);
  model.assertExhausted();
}, 30_000);

it('preserves policy-free live-child replacement refusal and Session retirement', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remote = await peer('lookup', held);
  const executor = await startPublicExecutor();
  cleanup.push(() => executor.close());
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'child', message: 'Read lookup.' },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ]
        : [message('root done')];
    return count === 1
      ? [
          call(
            'lookup',
            { key: 'child' },
            { namespace: 'mcp__fixture', callId: 'child-call' },
          ),
        ]
      : [message('child done')];
  };
  const model = new ModelServer(Array.from({ length: 4 }, () => respond));
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  const declaration = () =>
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
    });
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider,
    tools: [new NativeAgents(), declaration()],
  });
  const session = await agent.session({
    environment: new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    }),
  });
  cleanup.push(() => session.close());
  try {
    expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
      'root done',
    );
    await vi.waitFor(() => expect(remote.effects).toHaveLength(1));
    const children = await vi.waitFor(
      async () => {
        const children = await Array.fromAsync(session.subagents());
        expect(children[0]?.turn).toBeTruthy();
        return children;
      },
      { timeout: 5_000 },
    );
    expect(children).toHaveLength(1);
    expect(children[0]?.turn).toBeTruthy();
    const childId = children[0]!.id;
    await expect(session.update({ tools: [declaration()] })).rejects.toThrow(
      'Tool replacement requires closed inheriting native children',
    );
    await expect(session.submit('after refused update')).rejects.toThrow(
      'unavailable after failed persistence or cleanup',
    );
    release();
    await session.close();
    expect([...counts.keys()].sort()).toEqual([rootId, childId].sort());
    expect(counts.get(rootId!)).toBe(2);
    expect(counts.get(childId)).toBeGreaterThanOrEqual(1);
    expect(counts.get(childId)).toBeLessThanOrEqual(2);
    expect(
      remote.effects.map(({ name, arguments: args }) => ({
        name,
        arguments: args,
      })),
    ).toEqual([{ name: 'lookup', arguments: { key: 'child' } }]);
    expect(remote.effects[0]?._meta).toMatchObject({ callId: 'child-call' });
    // Retirement requires close; the child's final model continuation may be canceled.
    // Public child.wait() and exhaustion of that optional response are not promised.
  } finally {
    release();
  }
}, 20_000);

it.each(['websocket', 'fallback'] as const)(
  'rewrites real overlapping provider items over %s without stale item reuse',
  async (mode) => {
    const remote = await peer();
    const frames: JsonObject[] = [];
    const failures: unknown[] = [];
    let upgrades = 0;
    const responseEvents = (request: JsonObject) => {
      frames.push(request);
      if (request.generate === false) {
        const id = `provider-warmup-${frames.length}`;
        return [
          { type: 'response.created', response: { id } },
          { type: 'response.completed', response: { id } },
        ];
      }
      const index = frames.filter((frame) => frame.generate !== false).length;
      const id = `provider-response-${index}`;
      const output =
        index === 1
          ? [message('warm')]
          : index === 2
            ? [lookup(), { ...message('pre-tool'), id: 'display-item' }]
            : [message('done')];
      if (index === 3) {
        const text = JSON.stringify(request.input);
        expect(text).toContain('effective');
        expect(text).not.toContain('provider-item');
      }
      if (index > 3) throw new Error('Unexpected provider request');
      return [
        { type: 'response.created', response: { id } },
        ...(index === 2
          ? [
              {
                type: 'response.output_item.added',
                output_index: 1,
                item: {
                  type: 'message',
                  id: 'display-item',
                  role: 'assistant',
                  content: [],
                },
              },
            ]
          : []),
        ...output.map((item, output_index) => ({
          type: 'response.output_item.done',
          output_index,
          item,
        })),
        { type: 'response.completed', response: { id } },
      ];
    };
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const events = responseEvents(
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of events)
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
    const websocket = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      upgrades += 1;
      if (mode === 'fallback') {
        socket.end(
          'HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      websocket.handleUpgrade(request, socket, head, (connection) => {
        connection.on('message', (data) => {
          try {
            for (const event of responseEvents(JSON.parse(data.toString())))
              connection.send(JSON.stringify(event));
          } catch (error) {
            failures.push(error);
            connection.close();
          }
        });
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing provider address');
    cleanup.push(async () => {
      for (const connection of websocket.clients) connection.terminate();
      await new Promise<void>((resolve, reject) =>
        websocket.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(failures).toEqual([]);
    });
    const provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic',
      supportsWebsockets: true,
    });
    cleanup.push(() => provider.close());
    const before = vi.fn(() => ({
      action: 'replaceArguments' as const,
      arguments: { key: 'effective' },
    }));
    const agent = new Agent({
      instructions: 'Use the selected record.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new HttpMCP({
          name: 'fixture',
          url: remote.url,
          tools: ['lookup'],
          approvalMode: 'preapproved',
          before,
        }),
      ],
    });
    const session = await agent.session();
    cleanup.push(() => session.close());
    expect((await (await session.submit('warm')).wait()).finalOutput).toBe(
      'warm',
    );
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    expect(before).toHaveBeenCalledTimes(1);
    expect(
      remote.effects.map(({ name, arguments: args }) => ({
        name,
        arguments: args,
      })),
    ).toEqual([{ name: 'lookup', arguments: { key: 'effective' } }]);
    expect(remote.effects[0]?._meta).toMatchObject({ callId: 'provider-call' });
    expect(frames.filter((frame) => frame.generate !== false)).toHaveLength(3);
    if (mode === 'websocket') expect(upgrades).toBe(1);
    else expect(upgrades).toBeGreaterThan(0);
  },
  20_000,
);

for (const phase of ['before', 'approval'] as const) {
  it.each(['direct', 'code'] as const)(
    `stops and joins the root from ${phase} on %s without effect or continuation`,
    async (route) => {
      const remote = await peer();
      const secret = 'private-policy-reason-never-public';
      const stopped = vi.fn(() => ({
        action: 'stop' as const,
        reason: secret,
      }));
      const approval = vi.fn(() => true);
      const selected =
        route === 'direct'
          ? lookup()
          : {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'stop-cell',
              input:
                'text(JSON.stringify(await tools.mcp__fixture__lookup({key:"original"})));',
            };
      const { session, model } = await open(
        new HttpMCP({
          name: 'fixture',
          url: remote.url,
          tools: ['lookup'],
          before: phase === 'before' ? stopped : () => ({ action: 'allow' }),
          approval: phase === 'approval' ? stopped : approval,
        }),
        [[selected], [message('later root remains usable')]],
        false,
        route === 'code',
      );
      const turn = await session.submit('Stop this call.');
      const events = Array.fromAsync(turn.events());
      const error = await turn.wait().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('Turn stopped by MCP policy');
      expect(String(error)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
      expect(remote.effects).toEqual([]);
      expect(model.requests).toHaveLength(1);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(approval).not.toHaveBeenCalled();
      expect(JSON.stringify(await events)).not.toContain(secret);
      expect(
        (await (await session.submit('Continue with a new root.')).wait())
          .finalOutput,
      ).toBe('later root remains usable');
      expect(remote.effects).toEqual([]);
      model.assertExhausted();
    },
    20_000,
  );
}

it('stops only the owning child while its sibling and parent finish', async () => {
  const remote = await peer();
  let rootId: string | undefined;
  let stoppedId: string | undefined;
  const counts = new Map<string, number>();
  const policy = vi.fn((ctx: MCPCallContext) => {
    stoppedId ??= ctx.call.childId!;
    return ctx.call.childId === stoppedId
      ? { action: 'stop' as const, reason: 'private child reason' }
      : true;
  });
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count < 3
        ? [
            call(
              'spawn_agent',
              { task_name: `child${count}`, message: 'Read lookup.' },
              { namespace: 'collaboration', callId: `spawn${count}` },
            ),
          ]
        : [message('parent done')];
    return count === 1 ? [lookup()] : [message('sibling done')];
  };
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      approval: policy,
    }),
    Array.from({ length: 6 }, () => respond),
    true,
  );
  expect(
    (await (await session.submit('Start two children.')).wait()).finalOutput,
  ).toBe('parent done');
  await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(2));
  const children = await Array.fromAsync(session.subagents());
  expect(children).toHaveLength(2);
  const stopped = children.find((child) => child.id === stoppedId)!;
  const sibling = children.find((child) => child.id !== stoppedId)!;
  await expect(stopped.turn!.wait()).rejects.toThrow(
    'Turn stopped by MCP policy',
  );
  expect((await sibling.turn!.wait()).finalOutput).toBe('sibling done');
  expect(counts.get(stoppedId!)).toBe(1);
  expect(remote.effects).toHaveLength(1);
  expect(
    JSON.stringify(await Array.fromAsync(stopped.turn!.events())),
  ).not.toContain('private child reason');
  model.assertExhausted();
}, 30_000);

it('joins the exact stop receipt before settling its public root', async () => {
  const addon = await binding();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finish = addon._NativePolicyStop.prototype.finish;
  const spy = vi
    .spyOn(addon._NativePolicyStop.prototype, 'finish')
    .mockImplementation(async function (
      this: NonNullable<
        ReturnType<NativeThread['_hold_native_interception_for_stop']>
      >,
    ) {
      await finish.call(this);
      entered.resolve();
      await release.promise;
    });
  const remote = await peer();
  const { session } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      before: () => ({ action: 'stop' }),
    }),
    [[lookup()]],
  );
  let settled = false;
  const result = (await session.submit('Stop and join.')).wait().finally(() => {
    settled = true;
  });
  void result.catch(() => {});
  try {
    await entered.promise;
    expect(settled).toBe(false);
    expect(remote.effects).toEqual([]);
    release.resolve();
    await expect(result).rejects.toThrow('Turn stopped by MCP policy');
  } finally {
    release.resolve();
    await result.catch(() => {});
    spy.mockRestore();
  }
}, 20_000);

it('rejects a revoked late stop and preserves cancellation and successor effects', async () => {
  const remote = await peer();
  const entered = Promise.withResolvers<MCPCallContext>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      async before(ctx) {
        if (calls++ === 0) {
          entered.resolve(ctx);
          await release.promise;
          return { action: 'stop', reason: 'revoked private reason' };
        }
        return { action: 'allow' };
      },
    }),
    [[lookup()], [lookup()], [message('successor dispatched once')]],
  );
  const old = await session.submit('Cancel before policy returns.');
  const result = old.wait();
  void result.catch(() => {});
  const context = await entered.promise;
  const cancelling = old.cancel();
  void cancelling.catch(() => {});
  try {
    await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
    release.resolve();
    await cancelling;
    await expect(result).rejects.toBeInstanceOf(TurnAborted);
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(1);
    expect(
      (await (await session.submit('A new turn may call the peer.')).wait())
        .finalOutput,
    ).toBe('successor dispatched once');
    expect(remote.effects).toHaveLength(1);
    expect(calls).toBe(2);
    model.assertExhausted();
  } finally {
    release.resolve();
    await cancelling.catch(() => {});
    await result.catch(() => {});
  }
}, 20_000);

it('restores the native MCP carrier with Session-only tracing and strict restrictions', async () => {
  const native = await binding();
  const original = native.NativeThread.prototype._next_native_mcp_result;
  let expectedParent: string | undefined;
  const notices: JsonObject[] = [];
  const reader = vi
    .spyOn(native.NativeThread.prototype, '_next_native_mcp_result')
    .mockImplementation(async function (this: NativeThread) {
      const wire = await original.call(this);
      if (wire !== 'null') {
        const notice = JSON.parse(wire) as JsonObject;
        notices.push(notice);
        expect(typeof notice.tracing_context).toBe('string');
        expectedParent = (
          JSON.parse(
            native.trace_span_context(notice.tracing_context as string),
          ) as { span_id: string }
        ).span_id;
      }
      return wire;
    });
  try {
    for (const disabled of [false, true]) {
      const held = Promise.withResolvers<void>();
      const remote = await peer('lookup', held.promise);
      let callbacks = 0;
      const descriptor = new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        async transformResult(context, result) {
          callbacks++;
          expect(context).not.toHaveProperty('tracing_context');
          const current = telemetry.getCurrentSpan()!;
          expect(current.context.parentSpanId).toBe(expectedParent);
          expect(current.context.traceId).toBe('a'.repeat(32));
          expect(current.context.disabled).toBe(disabled);
          const nested = await telemetry.startSpan({
            includeSensitiveData: true,
            disabled: false,
          });
          expect(nested.context.disabled).toBe(disabled);
          expect(nested.context.includeSensitiveData).toBe(false);
          nested.close();
          return result;
        },
      });
      const f = await open(
        descriptor,
        [[lookup()], [message('done')]],
        false,
        false,
        { traceId: 'a'.repeat(32), disabled, includeSensitiveData: false },
      );
      const turn = await f.session.submit('Call lookup.');
      await telemetry.withTrace({ name: 'unrelated ambient' }, async () => {
        held.resolve();
        expect((await turn.wait()).finalOutput).toBe('done');
      });
      expect(callbacks).toBe(1);
      expect(JSON.stringify(await f.session.saveState())).not.toContain(
        'tracing_context',
      );
      await f.session.close();
    }
    expect(notices).toHaveLength(2);
  } finally {
    reader.mockRestore();
    await telemetry.forceFlush();
  }
});
