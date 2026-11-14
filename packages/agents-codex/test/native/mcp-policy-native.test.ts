import { createHash } from 'node:crypto';
import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
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
  type AgentLifecycleEvent,
  type Observation,
  type MCPCallContext,
  type MCPDiscoveryContext,
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
  jsonObject,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  isManualSessionState,
  parseSessionState,
} from '../../src/runtime/state';
import { startPublicExecutor } from './fixtures/public-executor';

const callbackTraceEvents: unknown[] = [];
beforeAll(async () => {
  await telemetry.configure({
    traceProcessors: [
      {
        onEvent(event) {
          callbackTraceEvents.push(event);
        },
      },
    ],
  });
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
  extraNames: readonly string[] = [],
  ask?: { id: string; meta?: JsonObject; mode?: 'form' | 'url' },
  inputSchemas?: Readonly<Record<string, JsonObject>>,
) {
  const effects: JsonObject[] = [];
  const answers: JsonObject[] = [];
  let finishPeerReply = () => {};
  const peerAnswered = new Promise<void>((resolve) => {
    finishPeerReply = resolve;
  });
  const failures: unknown[] = [];
  let initializations = 0;
  let listings = 0;
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
      if (ask && rpc.method === undefined && rpc.id === ask.id) {
        answers.push(rpc);
        finishPeerReply();
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
      if (rpc.method === 'tools/list') {
        listings++;
        result = {
          tools: [raw, ...extraNames].map((name) => ({
            ...recordTool,
            name,
            ...(inputSchemas?.[name]
              ? { inputSchema: inputSchemas[name] }
              : {}),
          })),
        };
      }
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
        if (ask) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(
            'event: message\ndata: ' +
              JSON.stringify({
                jsonrpc: '2.0',
                id: ask.id,
                method: 'elicitation/create',
                params: {
                  mode: ask.mode ?? 'form',
                  message: 'Peer decision after restored approval',
                  ...(ask.mode === 'url'
                    ? {
                        url: 'https://example.test/native-peer-decision',
                        elicitationId: 'native-peer-url-decision',
                      }
                    : {
                        requestedSchema: {
                          type: 'object',
                          properties: { answer: { type: 'string' } },
                          required: ['answer'],
                        },
                      }),
                  ...(ask.meta ? { _meta: ask.meta } : {}),
                },
              }) +
              '\n\n',
          );
          await peerAnswered;
          response.end(
            'event: message\ndata: ' +
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  content: [{ type: 'text', text: 'peer decision settled' }],
                },
              }) +
              '\n\n',
          );
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
    answers,
    get initializations() {
      return initializations;
    },
    get listings() {
      return listings;
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
    raw,
  };
}

it.each([true, false])(
  'filters native MCP discovery for each turn with list caching set to %s',
  async (cacheToolsList) => {
    const extraNames = ['detail'];
    const endpoint = await peer(
      'lookup',
      undefined,
      undefined,
      undefined,
      extraNames,
    );
    const model = new ModelServer([[message('first')], [message('second')]]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const context = { selected: 'lookup' };
    const seen = new Map<string, Set<string>>();
    const descriptor = new HttpMCP<typeof context>({
      name: 'fixture',
      url: endpoint.url,
      tools: ['lookup', 'detail'],
      cacheToolsList,
      toolFilter({ agent, runContext, serverName }, definition) {
        expect(agent?.name).toBe('catalog owner');
        expect(serverName).toBe('fixture');
        expect(runContext.context).toBe(context);
        expect(runContext.signal.aborted).toBe(false);
        const names = seen.get(runContext.turnId) ?? new Set<string>();
        names.add(definition.name);
        seen.set(runContext.turnId, names);
        definition.inputSchema.properties = {};
        return definition.name === context.selected;
      },
    });
    const agent = new Agent({
      name: 'catalog owner',
      instructions: 'Use only the selected record tool.',
      model: 'gpt-5.5',
      provider,
      tools: [descriptor],
    });
    await using session = await agent.session({ context });
    const first = await session.submit('First tool catalog');
    await first.wait();
    const listed = endpoint.listings;
    const firstTools = JSON.stringify(model.requests[0]!.tools ?? []);
    expect(firstTools).toContain('"name":"lookup"');
    expect(firstTools).toContain('"key":{"type":"string"}');
    expect(firstTools).not.toContain('"name":"detail"');

    context.selected = 'detail';
    extraNames.length = 0;
    const second = await session.submit('Second tool catalog');
    await second.wait();
    const secondTools = JSON.stringify(model.requests[1]!.tools ?? []);
    expect(secondTools).not.toContain('"name":"lookup"');
    if (cacheToolsList) {
      expect(endpoint.listings).toBe(listed);
      expect(secondTools).toContain('"name":"detail"');
    } else {
      expect(endpoint.listings).toBeGreaterThan(listed);
      expect(secondTools).not.toContain('"name":"detail"');
    }
    expect([...seen.values()].map((names) => [...names].sort())).toEqual([
      ['detail', 'lookup'],
      cacheToolsList ? ['detail', 'lookup'] : ['lookup'],
    ]);
    expect(endpoint.effects).toEqual([]);
  },
  30_000,
);

async function open(
  descriptor: HttpMCP | StdioMCP,
  responses: ConstructorParameters<typeof ModelServer>[0],
  children = false,
  programmaticToolCalling = false,
  tracing?: import('../../src/runtime/telemetry').TraceOptions,
  profileGraph = false,
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
    handoffs: profileGraph
      ? [
          new Agent({
            name: 'unused',
            instructions: 'Unused target',
            provider,
            model: 'gpt-5.5',
          }),
        ]
      : undefined,
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
it('filters native MCP discovery from a captured Agent profile', async () => {
  const endpoint = await peer();
  const filter = vi.fn((_context: MCPDiscoveryContext) => false);
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: endpoint.url,
      tools: ['lookup'],
      toolFilter: filter,
    }),
    [[message('filtered')]],
    false,
    false,
    undefined,
    true,
  );
  const turn = await session.submit('Check the available tools.');
  expect((await turn.wait()).finalOutput).toBe('filtered');
  expect(filter.mock.calls.map(([context]) => context.runContext)).toEqual([
    expect.objectContaining({ threadId: session.id, turnId: turn.turnId }),
  ]);
  expect(JSON.stringify(model.requests[0]!.tools ?? [])).not.toContain(
    '"name":"lookup"',
  );
  expect(endpoint.effects).toEqual([]);
  model.assertExhausted();
}, 20_000);

it.each([false, true])(
  'projects native Realtime MCP catalogs with a discovery filter configured: %s',
  async (filtered) => {
    const endpoint = await peer();
    const { session, model } = await open(
      new HttpMCP({
        name: 'fixture',
        url: endpoint.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        ...(filtered ? { toolFilter: () => false } : {}),
      }),
      [],
    );
    const configuration = await session.buildRealtimeSipConfig();
    const lookup = [expect.objectContaining({ name: 'mcp__fixture__lookup' })];
    const expected = filtered
      ? expect.not.arrayContaining(lookup)
      : expect.arrayContaining(lookup);
    const websocket = new WebSocketServer({ noServer: true });
    let advertised: unknown;
    model.onUpgrade((request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, (connection) => {
        connection.on('message', (raw) => {
          const frame = JSON.parse(raw.toString());
          if (frame.type !== 'session.update') return;
          advertised = frame.session.tools;
          connection.send(
            JSON.stringify({
              type: 'session.updated',
              session: { ...frame.session, id: 'mcp-catalog-fixture' },
            }),
          );
        });
      });
    });
    try {
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        expect(configuration.tools ?? []).toEqual(expected);
        expect(advertised ?? []).toEqual(expected);
      } finally {
        await voice.close();
      }
    } finally {
      for (const connection of websocket.clients) connection.terminate();
      websocket.close();
    }
    expect(endpoint.effects).toEqual([]);
    model.assertExhausted();
  },
  20_000,
);

const lookup = () => ({
  ...call(
    'lookup',
    { key: 'original' },
    { namespace: 'mcp__fixture', callId: 'provider-call' },
  ),
  id: 'provider-item',
});

it('keeps a filtered native MCP tool out of peer dispatch', async () => {
  const endpoint = await peer();
  const { model, session } = await open(
    new HttpMCP({
      name: 'fixture',
      url: endpoint.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      toolFilter: () => false,
    }),
    [[lookup()], [message('done')]],
  );
  await (await session.submit('Use only the offered tools.')).wait();
  expect(endpoint.effects).toEqual([]);
  expect(JSON.stringify(model.requests[0]!.tools ?? [])).not.toContain(
    '"name":"lookup"',
  );
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
  expectToolOutput(
    model.requests[1]!,
    firstEffect,
    'MCP tool invocation failed',
  );

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
  expectToolOutput(
    model.requests[1]!,
    firstEffect,
    'MCP tool invocation failed',
  );
  expectToolOutput(model.requests[2]!, laterEffect, laterResult);
  expect(remote.initializations, 'HTTP initialize requests').toBe(2);
  expect(remote.effects).toMatchObject([
    { name: 'lookup', arguments: { key: firstEffect }, initialization: 1 },
    { name: 'lookup', arguments: { key: laterEffect }, initialization: 2 },
  ]);
}, 30_000);

it.each(['default', 'format', 'raise'] as const)(
  'keeps the direct HTTP MCP transport failure under the selected %s policy',
  async (policy) => {
    const remote = await peer(
      'lookup',
      undefined,
      reconnectResult,
      firstEffect,
    );
    const diagnostics: Error[] = [];
    const { session, model } = await open(
      new HttpMCP({
        ...reconnectOptions,
        url: remote.url,
        activation: 'session',
        ...(policy === 'format'
          ? {
              failureErrorFunction(context, error) {
                expect(context.toolName).toBe('lookup');
                diagnostics.push(error);
                return 'The record reply was unavailable.';
              },
            }
          : policy === 'raise'
            ? { failureErrorFunction: null }
            : {}),
      }),
      [
        [
          call(
            'lookup',
            { key: firstEffect },
            {
              callId: firstEffect,
              namespace: 'mcp__fixture',
            },
          ),
        ],
        ...(policy === 'raise' ? [] : [[message('done')]]),
      ],
    );
    const turn = await session.submit('Record this once.');
    if (policy === 'raise') {
      const failure = await turn.wait().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      const nativeFailure = failure as NativeError;
      expect(nativeFailure.message).toBe('Native MCP result policy failed');
      expect(Object.hasOwn(nativeFailure, 'cause')).toBe(false);
      const diagnostic = nativeFailure.getMcpCallbackError()?.error;
      expect(diagnostic).toBeInstanceOf(Error);
      expect((diagnostic as Error).message).toMatch(
        /transport|response|closed/i,
      );
      expect(JSON.stringify(nativeFailure)).not.toContain(
        (diagnostic as Error).message,
      );
      expect(model.requests).toHaveLength(1);
    } else {
      expect((await turn.wait()).finalOutput).toBe('done');
      expectToolOutput(
        model.requests[1]!,
        firstEffect,
        policy === 'format'
          ? 'The record reply was unavailable.'
          : 'MCP tool invocation failed',
      );
    }
    expect(diagnostics).toHaveLength(policy === 'format' ? 1 : 0);
    if (diagnostics.length) {
      expect(diagnostics[0]!.message).toMatch(/transport|response|closed/i);
      expect(JSON.stringify(model.requests)).not.toContain(
        diagnostics[0]!.message,
      );
    }
    expect(remote.effects).toHaveLength(1);
  },
  30_000,
);

it('does not send ordinary MCP isError results to the transport failure policy', async () => {
  const remote = await peer('lookup', undefined, {
    content: [{ type: 'text', text: 'The peer rejected this record.' }],
    isError: true,
  });
  const failureErrorFunction = vi.fn(() => 'Unexpected transport diagnostic');
  const { session, model } = await open(
    new HttpMCP({ ...reconnectOptions, url: remote.url, failureErrorFunction }),
    [[lookup()], [message('done')]],
  );
  expect((await (await session.submit('Record it.')).wait()).finalOutput).toBe(
    'done',
  );
  expect(failureErrorFunction).not.toHaveBeenCalled();
  expect(JSON.stringify(model.requests[1])).toContain(
    'The peer rejected this record.',
  );
  expect(remote.effects).toHaveLength(1);
});

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

it('keeps a required per-tool native approval after narrowing to a raw leaf', async () => {
  const remote = await peer('read-one', undefined, undefined, undefined, [
    'read-two',
    'unselected',
  ]);
  const approvals = {
    'read-one': 'prompt',
    'read-two': 'preapproved',
    unselected: 'prompt',
  } as const;
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    tools: ['read-one', 'read-two'],
    toolNameOverrides: { 'read-one': 'reviewed' },
    toolApprovalOverrides: approvals,
  });
  const { session, model } = await open(descriptor, [
    [
      call(
        'reviewed',
        { key: 'one' },
        { namespace: 'mcp__fixture', callId: 'first' },
      ),
    ],
    [message('denied')],
    [
      call(
        'read_two',
        { key: 'two' },
        { namespace: 'mcp__fixture', callId: 'second' },
      ),
    ],
    [message('allowed')],
  ]);
  const first = await session.submit('review', {
    tools: [descriptor.tool('read-one')],
  });
  const pending = await first.wait({ until: 'interaction' });
  if (
    !('requests' in pending) ||
    pending.requests[0]?.type !== 'approval_request'
  )
    throw new Error(
      'Expected the selected read-only tool to require native approval',
    );
  expect(remote.effects).toEqual([]);
  await session.respond(pending.requests[0].reply('deny'));
  expect((await first.wait()).finalOutput).toBe('denied');
  expect(remote.effects).toEqual([]);
  const allowed = await session.submit('allow', {
    tools: [descriptor.tool('read-two')],
  });
  expect((await allowed.wait()).finalOutput).toBe('allowed');
  expect(remote.effects.map((effect) => effect.name)).toEqual(['read-two']);
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
  const originalDiscovery = vi.fn(() => true);
  const replacementDiscovery = vi.fn((_ctx: MCPDiscoveryContext) => true);
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
      toolFilter: originalDiscovery,
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
        toolFilter: replacementDiscovery,
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
  expect(originalDiscovery).not.toHaveBeenCalled();
  expect(
    replacementDiscovery.mock.calls.map(([context]) => context.runContext),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        threadId: child!.id,
        turnId: child!.turn!.turnId,
      }),
    ]),
  );
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

it('releases private MCP diagnostics from settled child turns', async () => {
  const remote = await peer();
  const privateFailure = new Error('synthetic private child MCP diagnostic');
  let rootId: string | undefined;
  let rootRequests = 0;
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id !== rootId) {
      return [
        call(
          'lookup',
          { key: 'child' },
          { namespace: 'mcp__fixture', callId: 'child-selected-diagnostic' },
        ),
      ];
    }
    return rootRequests++ === 0
      ? [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Read lookup.' },
            { namespace: 'collaboration', callId: 'spawn-child-diagnostic' },
          ),
        ]
      : [message('parent done')];
  };
  const release = Promise.withResolvers<void>();
  const result = vi.fn(async () => {
    await release.promise;
    throw privateFailure;
  });
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      transformResult: result,
    }),
    Array.from({ length: 3 }, () => respond),
    true,
  );

  try {
    expect(
      (await (await session.submit('Start a child.')).wait()).finalOutput,
    ).toBe('parent done');
    await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(1));
    const children = await Array.fromAsync(session.subagents());
    expect(children).toHaveLength(1);
    const turn = children[0].turn;
    expect(turn).toBeDefined();
    release.resolve();

    const failure: unknown = await turn!.wait().catch((error) => error);
    expect(failure).toBeInstanceOf(NativeError);
    expect(String(failure)).toContain('Native MCP result policy failed');
    expect((failure as NativeError).getMcpCallbackError()).toBeUndefined();
    model.assertExhausted();
  } finally {
    release.resolve();
  }
}, 20_000);

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

it('routes colliding raw names through stable aliases while step selection narrows', async () => {
  const remote = await peer('a.b', undefined, undefined, undefined, ['a_b']);
  const descriptor = new HttpMCP({
    name: 'docs',
    url: remote.url,
    approvalMode: 'preapproved',
    tools: ['a.b', 'a_b'],
  });
  const dotted = descriptor.tool('a.b');
  const underscored = descriptor.tool('a_b');
  const { session, model } = await open(descriptor, [
    [
      call(
        dotted.name,
        { key: 'one' },
        { namespace: dotted.namespace!, callId: 'first' },
      ),
    ],
    [
      call(
        underscored.name,
        { key: 'two' },
        { namespace: underscored.namespace!, callId: 'second' },
      ),
    ],
    [
      call(
        dotted.name,
        { key: 'three' },
        { namespace: dotted.namespace!, callId: 'third' },
      ),
    ],
    [message('complete')],
  ]);
  const selections = [[dotted, underscored], [underscored], [dotted], [dotted]];
  const turn = await session.submit('read', {
    beforeStep: ({ stepIndex }) => selections[stepIndex],
  });
  expect((await turn.wait()).finalOutput).toBe('complete');
  expect(remote.effects.map((effect) => effect.name)).toEqual([
    'a.b',
    'a_b',
    'a.b',
  ]);
  expect(JSON.stringify(model.requests)).toContain(dotted.name);
});

it('routes a missing peer result through the existing native result transform', async () => {
  const remote = await peer('lookup', undefined, undefined, 'fail');
  const seen: string[] = [];
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    approvalMode: 'preapproved',
    tools: ['lookup'],
    executionTimeout: 0.25,
    transformResult(context, result) {
      seen.push(context.callId);
      expect(result.isError).toBe(true);
      return {
        content: [{ type: 'text', text: 'safe-failure-outcome' }],
        isError: true,
      };
    },
  });
  const { session, model } = await open(descriptor, [
    [
      call(
        'lookup',
        { key: 'fail' },
        { namespace: 'mcp__fixture', callId: 'failed-call' },
      ),
    ],
    [message('complete')],
  ]);
  expect((await (await session.submit('read')).wait()).finalOutput).toBe(
    'complete',
  );
  expect(seen).toEqual(['failed-call']);
  expect(remote.effects).toHaveLength(1);
  expect(JSON.stringify(model.requests)).toContain('safe-failure-outcome');
});

it('resolves a partial declaration against the full peer catalog without admitting its colliding sibling', async () => {
  const remote = await peer('a.b', undefined, undefined, undefined, ['a_b']);
  const complete = new HttpMCP({
    name: 'docs',
    url: remote.url,
    approvalMode: 'preapproved',
    tools: ['a.b', 'a_b'],
  });
  const actual = complete.tool('a.b');
  const seen: string[] = [];
  const partial = new HttpMCP({
    name: 'docs',
    url: remote.url,
    approvalMode: 'preapproved',
    tools: ['a.b'],
    before: (context) => {
      seen.push(context.toolName);
      return { action: 'allow' };
    },
  });
  expect(partial.tool('a.b').name).not.toBe(actual.name);
  const { session, model } = await open(partial, [
    [
      call(
        actual.name,
        { key: 'partial' },
        { namespace: actual.namespace!, callId: 'partial' },
      ),
    ],
    [message('complete')],
  ]);
  const turn = await session.submit('read', {
    tools: [partial.tool('a.b')],
    beforeStep: () => [partial.tool('a.b')],
  });
  expect((await turn.wait()).finalOutput).toBe('complete');
  const denied = await session.submit('deny', {
    beforeStep: () => [complete.tool('a_b')],
  });
  await expect(denied.wait()).rejects.toThrow();
  expect(seen).toEqual(['a.b']);
  expect(remote.effects.map((effect) => effect.name)).toEqual(['a.b']);
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[0])).toContain(actual.name);
  expect(JSON.stringify(model.requests[0])).not.toContain(
    complete.tool('a_b').name,
  );
});

it('does not synthesize a result policy after native peer request cancellation', async () => {
  const release = Promise.withResolvers<void>();
  const remote = await peer('lookup', release.promise);
  const transform = vi.fn(
    (_context: MCPResultContext, result: JsonObject) => result,
  );
  const { session, model } = await open(
    new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      transformResult: transform,
    }),
    [[lookup()], [message('must not continue')]],
  );
  const turn = await session.submit('read');
  const observed = turn.wait().catch((error) => error);
  try {
    await vi.waitFor(() => expect(remote.effects).toHaveLength(1));
    await turn.cancel();
    expect(await observed).toBeInstanceOf(TurnAborted);
    expect(transform).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(remote.effects).toHaveLength(1);
  } finally {
    release.resolve();
    await session.close();
  }
}, 15000);

it.each(['before', 'approval'] as const)(
  'retains raw MCP %s policy identity after an idle graph update',
  async (phase) => {
    const remote = await peer('a.b', undefined, undefined, undefined, ['a_b']);
    const complete = new HttpMCP({
      name: 'docs',
      url: remote.url,
      tools: ['a.b', 'a_b'],
      approvalMode: 'preapproved',
    });
    const actual = complete.tool('a.b');
    const stopped = vi.fn(() => ({ action: 'stop' as const }));
    const partial = new HttpMCP({
      name: 'docs',
      url: remote.url,
      tools: ['a.b'],
      approvalMode: 'preapproved',
      before: phase === 'before' ? stopped : undefined,
      approval: phase === 'approval' ? stopped : undefined,
    });
    const { session, model } = await open(
      partial,
      [
        [message('ready')],
        [
          call(
            actual.name,
            { key: 'after' },
            { namespace: actual.namespace!, callId: 'after' },
          ),
        ],
        [message('must not continue')],
      ],
      false,
      false,
      undefined,
      true,
    );
    expect((await (await session.submit('warm')).wait()).finalOutput).toBe(
      'ready',
    );
    await session.update({ tools: [partial] });
    await expect(
      (
        await session.submit('after update', {
          tools: [partial.tool('a.b')],
          beforeStep: () => [partial.tool('a.b')],
        })
      ).wait(),
    ).rejects.toThrow();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(2);
    const denied = await session.submit('deny sibling', {
      beforeStep: () => [complete.tool('a_b')],
    });
    await expect(denied.wait()).rejects.toThrow();
    expect(model.requests).toHaveLength(2);
  },
  15000,
);

it.each([true, false])(
  'resolves forced MCP collision choice and later clear from captured selected bindings (partial=%s)',
  async (partial) => {
    const remote = await peer('a.b', undefined, undefined, undefined, ['a_b']);
    const complete = new HttpMCP({
      name: 'docs',
      url: remote.url,
      approvalMode: 'preapproved',
      tools: ['a.b', 'a_b'],
    });
    const selected = partial
      ? new HttpMCP({
          name: 'docs',
          url: remote.url,
          approvalMode: 'preapproved',
          tools: ['a.b'],
        })
      : complete;
    const actual = complete.tool('a.b');
    const { session, model } = await open(selected, [
      [
        call(
          actual.name,
          { key: 'forced' },
          { namespace: actual.namespace!, callId: 'forced-collision' },
        ),
      ],
      [message('complete')],
      [message('cleared')],
    ]);
    await session.update({
      modelSettings: { toolChoice: selected.tool('a.b') },
    });
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'complete',
    );
    await session.update({ modelSettings: { toolChoice: null } });
    expect((await (await session.submit('clear')).wait()).finalOutput).toBe(
      'cleared',
    );
    const names = (index: number) => {
      const groups = model.requests[index]!.tools as {
        name?: string;
        tools?: { name: string }[];
      }[];
      return groups
        .find((group) => group.name === actual.namespace)
        ?.tools?.map((tool) => tool.name);
    };
    expect(model.requests[0]!.tool_choice).toBe('required');
    expect(names(0)).toEqual([actual.name]);
    expect(model.requests[2]!.tool_choice).toBe('auto');
    expect(new Set(names(2))).toEqual(
      new Set(
        partial ? [actual.name] : [actual.name, complete.tool('a_b').name],
      ),
    );
    expect(remote.effects.map((effect) => effect.name)).toEqual(['a.b']);
    expect(model.requests).toHaveLength(3);
  },
);

for (const asynchronous of [false, true]) {
  it.each(['transform', 'extract', 'metadata'] as const)(
    `retains the selected %s callback failure for explicit diagnostics (async=${asynchronous})`,
    async (phase) => {
      const privateResult = 'SYNTHETIC_PRIVATE_MCP_RESULT';
      const selected = new Error('SYNTHETIC_SELECTED_CALLBACK_FAILURE');
      await telemetry.forceFlush();
      callbackTraceEvents.length = 0;
      const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (method) => vi.spyOn(console, method).mockImplementation(() => {}),
      );
      onTestFinished(() => logs.forEach((log) => log.mockRestore()));
      const fail = (): never => {
        throw selected;
      };
      const callback = asynchronous ? async () => fail() : fail;
      const remote = await peer('lookup', undefined, {
        content: [{ type: 'text', text: privateResult }],
        isError: true,
      });
      const descriptor = new HttpMCP({
        name: 'fixture',
        url: remote.url,
        approvalMode: 'preapproved',
        tools: ['lookup'],
        ...(phase === 'transform' ? { transformResult: callback } : {}),
        ...(phase === 'extract' ? { extractApplicationData: callback } : {}),
        ...(phase === 'metadata' ? { requestMetadata: callback } : {}),
      });
      const { session, model } = await open(
        descriptor,
        [
          [
            call(
              'lookup',
              { key: 'read' },
              { namespace: 'mcp__fixture', callId: 'cause-call' },
            ),
          ],
        ],
        false,
        false,
        { name: 'Selected MCP callback', includeSensitiveData: true },
      );
      const turn = await session.submit('Read one record.');
      const failure = await turn.wait().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect((failure as NativeError).message).toBe(
        'Native MCP result policy failed',
      );
      expect(Object.hasOwn(failure as NativeError, 'cause')).toBe(false);
      expect((failure as NativeError).getMcpCallbackError()?.error).toBe(
        selected,
      );
      await expect(turn.wait()).rejects.toBe(failure);
      expect(remote.effects).toHaveLength(phase === 'metadata' ? 0 : 1);
      expect(model.requests).toHaveLength(1);
      const items = [];
      for await (const item of session.items()) items.push(item);
      const channels = [
        JSON.stringify(model.requests),
        JSON.stringify(items),
        JSON.stringify(await session.saveState()),
        inspect(failure, { getters: true }),
        JSON.stringify(failure),
      ];
      await session.close();
      await telemetry.forceFlush();
      channels.push(
        JSON.stringify(callbackTraceEvents),
        JSON.stringify(logs.map((log) => log.mock.calls)),
      );
      for (const channel of channels) {
        expect(channel).not.toContain(privateResult);
        expect(channel).not.toContain(selected.message);
      }
    },
  );
}

it.each(['transform', 'extract', 'metadata'] as const)(
  'keeps malformed %s callback results separate from selected exceptions',
  async (phase) => {
    const remote = await peer();
    const invalid = () => ({ unsupported: undefined }) as unknown as JsonObject;
    const descriptor = new HttpMCP({
      name: 'fixture',
      url: remote.url,
      approvalMode: 'preapproved',
      tools: ['lookup'],
      ...(phase === 'transform' ? { transformResult: invalid } : {}),
      ...(phase === 'extract' ? { extractApplicationData: invalid } : {}),
      ...(phase === 'metadata' ? { requestMetadata: invalid } : {}),
    });
    const { session, model } = await open(descriptor, [[lookup()]]);
    const failure = await (
      await session.submit('Read.')
    )
      .wait()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeError);
    expect((failure as NativeError).message).toBe(
      'Native MCP result policy failed',
    );
    expect(Object.hasOwn(failure as NativeError, 'cause')).toBe(false);
    expect((failure as NativeError).getMcpCallbackError()).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  },
);

it('uses a public alias while preserving raw MCP invocation and metadata identity', async () => {
  const remote = await peer('source/read');
  const metadata: unknown[] = [];
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    tools: ['source/read'],
    toolNameOverrides: { 'source/read': 'public_read' },
    approvalMode: 'preapproved',
    requestMetadata(context) {
      metadata.push([
        context.serverName,
        context.toolName,
        context.call.tool.name,
      ]);
      return { application_marker: 'synthetic-alias' };
    },
  });
  const { session, model } = await open(descriptor, [
    [
      call(
        'public_read',
        { key: 'read' },
        { namespace: 'mcp__fixture', callId: 'aliased' },
      ),
    ],
    [message('complete')],
  ]);
  expect((await (await session.submit('Read.')).wait()).finalOutput).toBe(
    'complete',
  );
  expect(JSON.stringify(model.requests[0]!.tools)).toContain(
    '"name":"public_read"',
  );
  expect(metadata).toEqual([['fixture', 'source/read', 'public_read']]);
  expect(remote.effects).toEqual([
    expect.objectContaining({
      name: 'source/read',
      arguments: { key: 'read' },
      _meta: expect.objectContaining({ application_marker: 'synthetic-alias' }),
    }),
  ]);
});

it('keeps colliding public aliases bound to raw tools across narrowing', async () => {
  const raw = ['source/first', 'source/second'];
  const remote = await peer(raw[0], undefined, undefined, undefined, [raw[1]!]);
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    tools: raw,
    toolNameOverrides: Object.fromEntries(raw.map((name) => [name, 'lookup'])),
    approvalMode: 'preapproved',
  });
  const first = descriptor.tool(raw[0]!);
  const second = descriptor.tool(raw[1]!);
  expect(first.name).not.toBe(second.name);
  expect(first.name).toMatch(/^lookup_[a-f0-9]{12}$/);
  const { session, model } = await open(descriptor, [
    [
      call(
        first.name,
        { key: 'first' },
        { namespace: first.namespace!, callId: 'first' },
      ),
    ],
    [
      call(
        second.name,
        { key: 'second' },
        { namespace: second.namespace!, callId: 'second' },
      ),
    ],
    [message('both complete')],
    [
      call(
        second.name,
        { key: 'narrowed' },
        { namespace: second.namespace!, callId: 'narrowed' },
      ),
    ],
    [message('narrowed complete')],
  ]);
  expect((await (await session.submit('Both.')).wait()).finalOutput).toBe(
    'both complete',
  );
  expect(
    (
      await (
        await session.submit('Second.', { beforeStep: () => [second] })
      ).wait()
    ).finalOutput,
  ).toBe('narrowed complete');
  expect(remote.effects.map((effect) => effect.name)).toEqual([
    raw[0],
    raw[1],
    raw[1],
  ]);
  const narrowed = JSON.stringify(model.requests[3]!.tools);
  expect(narrowed).toContain(`"name":"${second.name}"`);
  expect(narrowed).not.toContain(`"name":"${first.name}"`);
});

it.each(['function', 'custom'] as const)(
  'routing union keeps aliases, caller refusal and batch settlement together (%s)',
  async (wire) => {
    const { tool } = await import('../../src');
    const remote = await peer('source/read');
    const metadata: string[][] = [];
    const descriptor = new HttpMCP({
      name: 'fixture',
      url: remote.url,
      tools: ['source/read'],
      toolNameOverrides: { 'source/read': 'public_read' },
      approvalMode: 'preapproved',
      requestMetadata(context) {
        metadata.push([context.toolName, context.call.tool.name]);
        return { routing_union: 'synthetic' };
      },
    });
    const model = new ModelServer([
      [
        call(
          'public_read',
          { key: 'first' },
          { namespace: 'mcp__fixture', callId: 'aliased' },
        ),
      ],
      [
        wire === 'function'
          ? call('guarded', {}, { callId: 'forged' })
          : {
              type: 'custom_tool_call',
              name: 'guarded',
              call_id: 'forged',
              input: '{}',
            },
      ],
      [call('finish', {}, { callId: 'finish' })],
    ]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-routing-union',
      supportsWebsockets: false,
    });
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const forbidden = vi.fn(() => 'FORBIDDEN');
    const permitted = vi.fn(() => 'ALLOWED');
    const checked = vi.fn();
    await using session = await new Agent({
      instructions: 'Read, then finish.',
      model: 'gpt-5.5',
      provider,
      tools: [
        descriptor,
        tool({
          name: 'guarded',
          parameters: z.object({}),
          allowedCallers: ['code'],
          before,
          execute: forbidden,
        }),
        tool({
          name: 'finish',
          parameters: z.object({}),
          allowedCallers: ['direct'],
          execute: permitted,
        }),
      ],
      outputType: {
        mode: 'prompted',
        schema: z.object({ answer: z.string() }),
      },
      toolBatchCompletion(context) {
        if (
          !context.results.some((result) => result.call.tool.name === 'finish')
        )
          return;
        expect(context.results.map((result) => result.call.callId)).toEqual([
          'finish',
        ]);
        expect(context.results[0].output.success).toBe(true);
        return { action: 'finish', output: { answer: 'ready' } };
      },
      beforeComplete(context) {
        checked(context.toolBatchCallIds);
      },
    }).session();
    const result = await (await session.submit('Run.')).wait();
    expect(result.finalOutput).toEqual({ answer: 'ready' });
    expect(result.toolBatchCallIds).toEqual(['finish']);
    expect(before).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    expect(permitted).toHaveBeenCalledTimes(1);
    expect(checked).toHaveBeenCalledExactlyOnceWith(['finish']);
    expect(metadata).toEqual([['source/read', 'public_read']]);
    expect(remote.effects).toEqual([
      expect.objectContaining({
        name: 'source/read',
        arguments: { key: 'first' },
      }),
    ]);
    model.assertExhausted();
  },
  30_000,
);

it('routing union refreshes restored masks while preserving alias and reducer ownership', async () => {
  const { tool, parseSessionState } = await import('../../src');
  const remote = await peer('source/read');
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    tools: ['source/read'],
    toolNameOverrides: { 'source/read': 'public_read' },
    approvalMode: 'preapproved',
  });
  const model = new ModelServer([
    [
      call(
        'public_read',
        { key: 'save' },
        { namespace: 'mcp__fixture', callId: 'aliased-save' },
      ),
    ],
    [message('SAVED')],
    [call('guarded', {}, { callId: 'restored-forged' })],
    [call('finish', {}, { callId: 'restored-finish' })],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-routing-union',
    supportsWebsockets: false,
  });
  const old = vi.fn(() => undefined);
  const base = {
    name: 'Root',
    instructions: 'Read, then finish.',
    model: 'gpt-5.5',
    provider,
  };
  const initial = await new Agent({
    ...base,
    tools: [
      descriptor,
      tool({
        name: 'guarded',
        parameters: z.object({}),
        allowedCallers: ['direct'],
        execute: () => 'OLD',
      }),
      tool({
        name: 'finish',
        parameters: z.object({}),
        allowedCallers: ['direct'],
        execute: () => 'OLD FINISH',
      }),
    ],
    toolBatchCompletion: old,
  }).session();
  expect((await (await initial.submit('Save.')).wait()).finalOutput).toBe(
    'SAVED',
  );
  const state = await initial.saveState();
  const oldCount = old.mock.calls.length;
  await initial.close();
  const before = vi.fn(() => ({ action: 'allow' as const }));
  const forbidden = vi.fn(() => 'FORBIDDEN');
  const permitted = vi.fn(() => 'NEW');
  await using restored = await new Agent({
    ...base,
    tools: [
      descriptor,
      tool({
        name: 'guarded',
        parameters: z.object({}),
        allowedCallers: ['code'],
        before,
        execute: forbidden,
      }),
      tool({
        name: 'finish',
        parameters: z.object({}),
        allowedCallers: ['direct'],
        execute: permitted,
      }),
    ],
    toolBatchCompletion(context) {
      if (!context.results.some((result) => result.call.tool.name === 'finish'))
        return;
      return { action: 'finish', output: 'RESTORED REDUCED' };
    },
  }).session({ state: parseSessionState(JSON.stringify(state)) });
  const result = await (await restored.submit('Finish.')).wait();
  expect(result.finalOutput).toBe('RESTORED REDUCED');
  expect(result.toolBatchCallIds).toEqual(['restored-finish']);
  expect(before).not.toHaveBeenCalled();
  expect(forbidden).not.toHaveBeenCalled();
  expect(permitted).toHaveBeenCalledTimes(1);
  expect(old).toHaveBeenCalledTimes(oldCount);
  expect(remote.effects.map((effect) => effect.name)).toEqual(['source/read']);
  model.assertExhausted();
}, 30_000);

it('routing union keeps selected handoff masks and aliased Worker reduction', async () => {
  const { tool, Handoff } = await import('../../src');
  const remote = await peer('source/read');
  const descriptor = new HttpMCP({
    name: 'fixture',
    url: remote.url,
    tools: ['source/read'],
    toolNameOverrides: { 'source/read': 'public_read' },
    approvalMode: 'preapproved',
  });
  const model = new ModelServer([
    [call('transfer', {}, { callId: 'transfer' })],
    [
      call(
        'public_read',
        { key: 'worker' },
        { namespace: 'mcp__fixture', callId: 'worker-alias' },
      ),
    ],
    [call('worker_guarded', {}, { callId: 'worker-forged' })],
    [call('worker_finish', {}, { callId: 'worker-finish' })],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-routing-union',
    supportsWebsockets: false,
  });
  const finish = vi.fn(() => 'WORKER TOOL');
  const guardedBefore = vi.fn(() => ({ action: 'allow' as const }));
  const guarded = vi.fn(() => 'FORBIDDEN WORKER BODY');
  const worker = new Agent({
    name: 'Worker',
    instructions: 'Read and finish.',
    model: 'gpt-5.5',
    provider,
    tools: [
      descriptor,
      tool({
        name: 'worker_guarded',
        parameters: z.object({}),
        allowedCallers: ['code'],
        before: guardedBefore,
        execute: guarded,
      }),
      tool({
        name: 'worker_finish',
        parameters: z.object({}),
        allowedCallers: ['direct'],
        execute: finish,
      }),
    ],
    toolBatchCompletion(context) {
      if (
        !context.results.some(
          (result) => result.call.tool.name === 'worker_finish',
        )
      )
        return;
      return { action: 'finish', output: 'WORKER REDUCED' };
    },
  });
  const transfer = vi.fn(() => 'accepted');
  const rootReducer = vi.fn(() => {
    throw new Error('Root reducer replaced Worker authority');
  });
  await using session = await new Agent({
    name: 'Root',
    instructions: 'Hand off.',
    model: 'gpt-5.5',
    provider,
    handoffs: [
      new Handoff(
        worker,
        tool({
          name: 'transfer',
          parameters: z.object({}),
          allowedCallers: ['direct'],
          execute: transfer,
        }),
      ),
    ],
    toolBatchCompletion: rootReducer,
  }).session();
  const result = await (await session.submit('Delegate.')).wait();
  expect(result.finalOutput).toBe('WORKER REDUCED');
  expect(result.toolBatchCallIds).toEqual(['worker-finish']);
  expect(rootReducer).not.toHaveBeenCalled();
  expect(guardedBefore).not.toHaveBeenCalled();
  expect(guarded).not.toHaveBeenCalled();
  expect(transfer).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(remote.effects.map((effect) => effect.name)).toEqual(['source/read']);
  expect(await session.getActiveAgent()).toBe(worker);
  model.assertExhausted();
}, 30_000);

// Inspect the native question identity to verify sender isolation.
type PortableMcpCandidate = {
  nativeQuestions: Map<unknown, { native: NativeThread; questionId?: string }>;
};

async function portableMcpApproval(turn: {
  wait(options: { until: 'interaction' }): Promise<unknown>;
}) {
  const pending = (await turn.wait({ until: 'interaction' })) as {
    requests?: import('../../src').ApprovalRequest[];
  };
  expect(pending.requests).toHaveLength(1);
  const request = pending.requests![0]!;
  expect(request.type).toBe('approval_request');
  return request;
}

async function capturePortableMcpCandidate(session: Session) {
  return parseSessionState(JSON.stringify(await session.suspend()));
}

async function portableMcpAgent(
  finalReplies = 1,
  ask?: { id: string; meta?: JsonObject; mode?: 'form' | 'url' },
  onLifecycle?: (event: AgentLifecycleEvent<undefined>) => void,
) {
  const remote = await peer(
    'find-record',
    undefined,
    undefined,
    undefined,
    [],
    ask,
  );
  const sampled = call(
    'reviewed',
    { key: '43' },
    { namespace: 'mcp__fixture', callId: 'portable-native' },
  );
  sampled.arguments = ' { "key" : "43" } ';
  const model = new ModelServer([
    [sampled],
    ...Array.from({ length: finalReplies }, () => [
      message('settled through native decision'),
    ]),
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-portable-mcp',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  const agent = new Agent({
    instructions: 'Read the record.',
    onLifecycle,
    provider,
    model: 'gpt-5.5',
    programmaticToolCalling: false,
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: remote.url,
        tools: ['find-record'],
        toolNameOverrides: { 'find-record': 'reviewed' },
        approvalMode: 'preapproved',
        toolApprovalOverrides: { 'find-record': 'prompt' },
        cacheToolsList: false,
      }),
    ],
  });
  return { agent, model, remote, sampled, provider };
}

it.each(['allow_once', 'deny'] as const)(
  'portable ordinary MCP candidate settles one fresh exact decision (%s)',
  async (decision) => {
    const { agent, model, remote, sampled } = await portableMcpAgent();
    const source = await agent.session();
    cleanup.push(() => source.close());
    const sourceTurn = await source.submit('Read');
    const old = await portableMcpApproval(sourceTurn);
    const oldEntry = (
      source as unknown as PortableMcpCandidate
    ).nativeQuestions.get(old)!;
    expect(oldEntry.questionId).toBeDefined();
    const oldReply = old.reply('allow_once');
    const saved = await capturePortableMcpCandidate(source);
    await source.close();
    expect('manual_continuation' in saved).toBe(true);
    if (!isManualSessionState(saved)) throw new Error('Native frame missing');
    const [data] = saved.manual_continuation.pending_mcp!;
    expect(data).toMatchObject({
      server_name: 'fixture',
      tool_name: 'find-record',
      callable_namespace: 'mcp__fixture',
      callable_name: 'reviewed',
    });
    expect(data).not.toHaveProperty('tool');
    expect(remote.effects).toEqual([]);
    await using restored = await agent.session({ state: saved });
    const fresh = await portableMcpApproval(restored.restoredTurn!);
    const entry = (
      restored as unknown as PortableMcpCandidate
    ).nativeQuestions.get(fresh)!;
    expect(entry.questionId).toBeDefined();
    expect(entry.questionId).not.toBe(oldEntry.questionId);
    expect(entry.questionId).not.toBe(data!.receipt);
    expect(entry.questionId).not.toBe(data!.token);
    expect(model.requests).toHaveLength(1);
    await expect(restored.respond(oldReply)).rejects.toThrow();
    const wire = JSON.stringify({
      kind: 'mcp_approval',
      server_name: data!.server_name,
      request_id: data!.request_id,
      decision: 'allow_once',
    });
    for (const token of [oldEntry.questionId!, data!.receipt, data!.token])
      expect(
        await entry.native._respond_owned_native_question(token, wire),
      ).toBe(false);
    await using wrongOwner = await agent.session();
    await expect(
      wrongOwner.respond(fresh.reply('allow_once')),
    ).rejects.toThrow();
    expect(() => fresh.reply({ allow: true, always: true } as never)).toThrow(
      /allow_once.*deny/,
    );
    expect(remote.effects).toEqual([]);
    const reply = fresh.reply(decision);
    await restored.respond(reply);
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
      'settled through native decision',
    );
    await expect(restored.respond(reply)).rejects.toThrow();
    expect(
      remote.effects.map((effect) => [effect.name, effect.arguments]),
    ).toEqual(
      decision === 'allow_once' ? [['find-record', { key: '43' }]] : [],
    );
    expect(model.requests).toHaveLength(2);
    const input = model.requests[1]!.input as JsonObject[];
    const original = input.filter(
      (item) =>
        item.type === 'function_call' && item.call_id === 'portable-native',
    );
    const outputs = input.filter(
      (item) =>
        item.type === 'function_call_output' &&
        item.call_id === 'portable-native',
    );
    expect(original).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(original[0]).toMatchObject({
      namespace: 'mcp__fixture',
      name: 'reviewed',
      arguments: sampled.arguments,
    });
    model.assertExhausted();
  },
  30_000,
);

it('portable ordinary MCP candidate refuses a changed declaration before an effect', async () => {
  const { agent, model, remote } = await portableMcpAgent();
  const source = await agent.session();
  cleanup.push(() => source.close());
  const turn = await source.submit('Read');
  await portableMcpApproval(turn);
  const saved = await capturePortableMcpCandidate(source);
  await source.close();
  const description = recordTool.description;
  try {
    recordTool.description = 'A materially different current declaration';
    await expect(agent.session({ state: saved })).rejects.toThrow(
      /declaration|source|catalog|changed/,
    );
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(1);
  } finally {
    recordTool.description = description;
  }
}, 30_000);

it('portable ordinary MCP candidate cancellation keeps no approval grant', async () => {
  const { agent, model, remote } = await portableMcpAgent();
  const source = await agent.session();
  cleanup.push(() => source.close());
  const turn = await source.submit('Read');
  await portableMcpApproval(turn);
  const saved = await capturePortableMcpCandidate(source);
  await source.close();
  let expired: import('../../src').NativeQuestionReply;
  let oldId: string;
  {
    await using cancelled = await agent.session({ state: saved });
    const stale = await portableMcpApproval(cancelled.restoredTurn!);
    expired = stale.reply('allow_once');
    oldId = (cancelled as unknown as PortableMcpCandidate).nativeQuestions.get(
      stale,
    )!.questionId!;
    await cancelled.restoredTurn!.cancel({ mode: 'force' });
    await expect(cancelled.respond(expired)).rejects.toThrow();
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(1);
  }
  await using restored = await agent.session({ state: saved });
  const fresh = await portableMcpApproval(restored.restoredTurn!);
  expect(
    (restored as unknown as PortableMcpCandidate).nativeQuestions.get(fresh)!
      .questionId,
  ).not.toBe(oldId);
  await expect(restored.respond(expired)).rejects.toThrow();
  await restored.respond(fresh.reply('allow_once'));
  expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
    'settled through native decision',
  );
  expect(remote.effects).toHaveLength(1);
  expect(model.requests).toHaveLength(2);
  model.assertExhausted();
}, 30_000);

it.each([
  ['source_thread_id', '11111111-1111-4111-8111-111111111111'],
  ['server_name', 'other-fixture'],
  ['tool_name', 'reviewed'],
  ['callable_name', 'find-record'],
  ['declaration_sha256', '0'.repeat(64)],
])(
  'portable ordinary MCP candidate refuses a substituted %s',
  async (field, value) => {
    const { agent, model, remote } = await portableMcpAgent();
    const source = await agent.session();
    cleanup.push(() => source.close());
    const turn = await source.submit('Read');
    await portableMcpApproval(turn);
    const saved = await capturePortableMcpCandidate(source);
    await source.close();
    const forged = jsonObject.parse(JSON.parse(JSON.stringify(saved)));
    const continuation = jsonObject.parse(forged.manual_continuation);
    const data = jsonObject.parse(
      (continuation.pending_mcp as JsonObject[])[0],
    );
    data[field!] = value!;
    continuation.pending_mcp = [data];
    forged.manual_continuation = continuation;
    let unexpected: Session | undefined;
    try {
      await expect(
        (async () => {
          const state = parseSessionState(JSON.stringify(forged));
          unexpected = await agent.session({ state });
        })(),
      ).rejects.toThrow(/MCP|mcp|declaration|owner|source|catalog|call/);
    } finally {
      await unexpected?.close();
    }
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(1);
  },
  30_000,
);

it('portable ordinary MCP candidate gives copied snapshots separate native owners', async () => {
  const { agent, model, remote } = await portableMcpAgent(2);
  const source = await agent.session();
  const turn = await source.submit('Read');
  const old = await portableMcpApproval(turn);
  const oldReply = old.reply('allow_once');
  const saved = await capturePortableMcpCandidate(source);
  await expect(source.respond(oldReply)).rejects.toThrow();
  expect(remote.effects).toEqual([]);
  await source.close();
  await using left = await agent.session({ state: saved });
  await using right = await agent.session({ state: saved });
  expect(left.id).not.toBe(right.id);
  const a = await portableMcpApproval(left.restoredTurn!);
  const b = await portableMcpApproval(right.restoredTurn!);
  const aEntry = (left as unknown as PortableMcpCandidate).nativeQuestions.get(
    a,
  )!;
  const bEntry = (right as unknown as PortableMcpCandidate).nativeQuestions.get(
    b,
  )!;
  expect(aEntry.questionId).not.toBe(bEntry.questionId);
  const reply = a.reply('allow_once');
  await expect(right.respond(reply)).rejects.toThrow();
  expect(
    await bEntry.native._respond_owned_native_question(
      aEntry.questionId!,
      JSON.stringify({
        kind: 'mcp_approval',
        server_name: 'fixture',
        request_id: 'mcp_tool_call_approval_portable-native',
        decision: 'allow_once',
      }),
    ),
  ).toBe(false);
  expect(remote.effects).toEqual([]);
  expect(model.requests).toHaveLength(1);
  await left.respond(reply);
  expect((await left.restoredTurn!.wait()).finalOutput).toBe(
    'settled through native decision',
  );
  expect(await bEntry.native._native_question_pending(bEntry.questionId!)).toBe(
    true,
  );
  expect(remote.effects).toHaveLength(1);
  await right.respond(b.reply('deny'));
  await right.restoredTurn!.wait();
  await expect(left.respond(reply)).rejects.toThrow();
  expect(remote.effects).toHaveLength(1);
  expect(model.requests).toHaveLength(3);
}, 30_000);

it.each(['endpoint', 'callback'] as const)(
  'portable ordinary MCP candidate denies current root %s replacement',
  async (replacement) => {
    const { agent, model, remote, provider } = await portableMcpAgent();
    const source = await agent.session();
    const turn = await source.submit('Read');
    await portableMcpApproval(turn);
    const saved = await capturePortableMcpCandidate(source);
    await source.close();
    const other = await peer('find-record');
    let callbacks = 0;
    const changed = new Agent({
      instructions: 'Read the record.',
      provider,
      model: 'gpt-5.5',
      programmaticToolCalling: false,
      tools: [
        new HttpMCP({
          name: 'fixture',
          url: replacement === 'endpoint' ? other.url : remote.url,
          tools: ['find-record'],
          toolNameOverrides: { 'find-record': 'reviewed' },
          approvalMode: 'preapproved',
          toolApprovalOverrides: { 'find-record': 'prompt' },
          cacheToolsList: false,
          ...(replacement === 'callback'
            ? {
                before: () => {
                  callbacks++;
                  return { action: 'allow' as const };
                },
              }
            : {}),
        }),
      ],
    });
    await expect(changed.session({ state: saved })).rejects.toThrow();
    expect(callbacks).toBe(0);
    expect(remote.effects).toEqual([]);
    expect(other.effects).toEqual([]);
    expect(model.requests).toHaveLength(1);
  },
  30_000,
);

it.each([
  ['form', false],
  ['form', true],
  ['url', false],
  ['url', true],
] as const)(
  'restored ordinary MCP keeps the subsequent peer %s elicitation owner (spoof metadata: %s)',
  async (mode, spoofApprovalMeta) => {
    const { agent, remote, model } = await portableMcpAgent(1, {
      id: 'mcp_tool_call_approval_portable-native',
      mode,
      ...(spoofApprovalMeta
        ? { meta: { codex_approval_kind: 'mcp_tool_call' } }
        : {}),
    });
    const source = await agent.session();
    cleanup.push(() => source.close());
    const old = await portableMcpApproval(await source.submit('Read'));
    const oldReply = old.reply('allow_once');
    const saved = await capturePortableMcpCandidate(source);
    await source.close();
    await using restored = await agent.session({ state: saved });
    const fresh = await portableMcpApproval(restored.restoredTurn!);
    const freshReply = fresh.reply('allow_once');
    await restored.respond(freshReply);
    const pending = await restored.restoredTurn!.wait({ until: 'interaction' });
    if (!('requests' in pending))
      throw new Error('Peer elicitation was not published');
    expect(pending.requests).toHaveLength(1);
    const remoteQuestion = pending.requests[0]!;
    if (
      remoteQuestion.type !== 'elicitation_request' ||
      remoteQuestion.mode !== mode
    )
      throw new Error('Peer elicitation acquired approval authority');
    expect(remote.effects).toHaveLength(1);
    await expect(restored.respond(oldReply)).rejects.toThrow();
    await expect(restored.respond(freshReply)).rejects.toThrow();
    await expect(restored.suspend()).rejects.toThrow();
    let peerReply;
    if (remoteQuestion.mode === 'url') {
      expect(remoteQuestion.url).toBe(
        'https://example.test/native-peer-decision',
      );
      expect(remoteQuestion.elicitationId).toBe('native-peer-url-decision');
      peerReply = remoteQuestion.replyUrlAccept();
    } else {
      peerReply = remoteQuestion.reply({ answer: 'fresh peer decision' });
    }
    await restored.respond(peerReply);
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
      'settled through native decision',
    );
    expect(remote.effects).toHaveLength(1);
    await expect(restored.respond(peerReply)).rejects.toThrow();
    expect(remote.answers).toHaveLength(1);
    expect(remote.answers[0]?.result).toMatchObject({ action: 'accept' });
    expect(remote.answers[0]?.id).toBe(
      'mcp_tool_call_approval_portable-native',
    );
    expect(model.requests).toHaveLength(2);
    model.assertExhausted();
  },
  30_000,
);

it.each([false, true])(
  'uses opt-in best-effort strict managed MCP schemas (%s)',
  async (strictToolSchemas) => {
    const openSchema = {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: [],
      additionalProperties: true,
    };
    const remote = await peer(
      'lookup',
      undefined,
      undefined,
      undefined,
      ['open_tool'],
      undefined,
      {
        lookup: {
          type: 'object',
          properties: { key: { type: 'string' }, optional: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        open_tool: openSchema,
      },
    );
    const { session, model } = await open(
      new HttpMCP({
        ...reconnectOptions,
        url: remote.url,
        tools: ['lookup', 'open_tool'],
        strictToolSchemas,
      }),
      [[message('done')]],
    );
    expect(
      (await (await session.submit('Review tool schemas.')).wait()).finalOutput,
    ).toBe('done');
    const namespace = (model.requests[0]!.tools as JsonObject[]).find(
      (tool) => tool.name === 'mcp__fixture',
    );
    const tools = namespace?.tools as JsonObject[] | undefined;
    expect(tools?.find((tool) => tool.name === 'lookup')).toMatchObject({
      strict: strictToolSchemas,
      parameters: {
        required: strictToolSchemas ? ['key', 'optional'] : ['key'],
      },
    });
    expect(tools?.find((tool) => tool.name === 'open_tool')).toMatchObject({
      strict: false,
      parameters: { additionalProperties: true },
    });
    expect(remote.effects).toEqual([]);
  },
);

it.each([
  'trusted',
  'untrusted',
  'legacy',
  'recapture',
  'recapture_untrusted',
  'recapture_legacy',
  'wrong_turn',
  'wrong_profile',
] as const)(
  'keeps native MCP lifecycle acknowledgment through cold capture (%s)',
  async (mode) => {
    const events: string[] = [];
    const { agent, model, remote } = await portableMcpAgent(
      1,
      undefined,
      (event) => events.push(event.kind),
    );
    const source = await agent.session();
    cleanup.push(() => source.close());
    const original = await source.submit('Read');
    await portableMcpApproval(original);
    expect(events).toEqual(['start']);
    expect(remote.effects).toEqual([]);
    let serialized = JSON.stringify(await source.suspend());
    await source.close();
    const recorded = JSON.parse(serialized);
    const marker = recorded.manual_continuation._sdk_lifecycle_start;
    expect(marker).toMatchObject({ turn_id: original.turnId });
    if (mode.includes('legacy')) {
      delete recorded.manual_continuation._sdk_lifecycle_start;
      serialized = JSON.stringify(recorded);
    }
    const authenticated = (value: string) =>
      parseSessionState(value, {
        expectedSha256: createHash('sha256').update(value).digest('hex'),
      });
    if (mode === 'wrong_turn' || mode === 'wrong_profile') {
      if (mode === 'wrong_turn')
        recorded.manual_continuation._sdk_lifecycle_start.turn_id =
          'another-turn';
      else {
        const ack = recorded.manual_continuation._sdk_lifecycle_start;
        if (ack.profile) ack.profile.epoch++;
        else ack.profile = { profile_id: 'another-native-profile', epoch: 1 };
      }
      await expect(
        agent
          .session({ state: authenticated(JSON.stringify(recorded)) })
          .then((opened) => {
            cleanup.push(() => opened.close());
            return opened;
          }),
      ).rejects.toThrow(/Lifecycle acknowledgment/);
      expect(events).toEqual(['start']);
      expect(model.requests).toHaveLength(1);
      expect(remote.effects).toEqual([]);
      return;
    }
    const repeatedStart = mode.includes('untrusted') || mode.includes('legacy');
    const started = repeatedStart ? ['start', 'start'] : ['start'];
    const state = mode.includes('untrusted')
      ? parseSessionState(serialized)
      : authenticated(serialized);
    const first = await agent.session({ state });
    cleanup.push(() => first.close());
    let restored = first;
    let request = await portableMcpApproval(first.restoredTurn!);
    expect(model.requests).toHaveLength(1);
    expect(remote.effects).toEqual([]);
    expect(events).toEqual(started);
    if (mode.includes('recapture')) {
      const again = JSON.stringify(await first.suspend());
      expect(
        JSON.parse(again).manual_continuation._sdk_lifecycle_start,
      ).toEqual(marker);
      await first.close();
      const next = await agent.session({ state: authenticated(again) });
      cleanup.push(() => next.close());
      restored = next;
      request = await portableMcpApproval(next.restoredTurn!);
      expect(events).toEqual(started);
      expect(model.requests).toHaveLength(1);
      expect(remote.effects).toEqual([]);
    }
    await restored.respond(request.reply('allow_once'));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
      'settled through native decision',
    );
    expect(events).toEqual([...started, 'end']);
    expect(remote.effects.map((effect) => effect.name)).toEqual([
      'find-record',
    ]);
    expect(model.requests).toHaveLength(2);
    await expect(restored.suspend()).rejects.toThrow();
    model.assertExhausted();
  },
);

it.each(['allow_once', 'deny'] as const)(
  'remembers only the current raw native MCP policy and asks again after cold restore (%s)',
  async (choice) => {
    const remote = await peer('find-record', undefined, undefined, undefined, [
      'write-other',
    ]);
    const names = ['reviewed', 'reviewed', 'other', 'reviewed', 'reviewed'];
    const model = new ModelServer(
      names.flatMap((name, index) => [
        [
          call(
            name,
            { key: String(index) },
            { namespace: 'mcp__fixture', callId: `remembered-${index}` },
          ),
        ],
        [message(`done-${index}`)],
      ]),
    );
    const config = await model.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-remembered-mcp',
      supportsWebsockets: false,
    });
    cleanup.push(() => provider.close());
    const agent = new Agent({
      instructions: 'Use the chosen tool.',
      provider,
      model: 'gpt-5.5',
      programmaticToolCalling: false,
      tools: [
        new HttpMCP({
          name: 'fixture',
          url: remote.url,
          tools: ['find-record', 'write-other'],
          toolNameOverrides: {
            'find-record': 'reviewed',
            'write-other': 'other',
          },
          approvalMode: 'preapproved',
          toolApprovalOverrides: {
            'find-record': 'prompt',
            'write-other': 'prompt',
          },
          cacheToolsList: false,
        }),
      ],
    });
    const source = await agent.session();
    cleanup.push(() => source.close());
    const first = await source.submit('first');
    const request = await portableMcpApproval(first);
    expect(remote.effects).toHaveLength(0);
    const nativeOwner = (
      source as unknown as PortableMcpCandidate
    ).nativeQuestions.get(request);
    if (!nativeOwner?.questionId)
      throw new Error('Expected current native question owner');
    const deniedWire = {
      kind: 'mcp_approval',
      server_name: 'fixture',
      request_id: 'mcp_tool_call_approval_remembered-0',
      decision: 'deny',
    };
    await expect(
      nativeOwner.native._respond_owned_native_question(
        nativeOwner.questionId,
        JSON.stringify(deniedWire),
        true,
      ),
    ).rejects.toThrow();
    await expect(
      nativeOwner.native._respond_owned_native_question(
        nativeOwner.questionId,
        JSON.stringify({
          ...deniedWire,
          decision: 'allow_once',
          content: { approved: true },
        }),
        true,
      ),
    ).rejects.toThrow();
    expect(
      await nativeOwner.native._native_question_pending(nativeOwner.questionId),
    ).toBe(true);
    expect(remote.effects).toHaveLength(0);
    const rememberedReply = request.reply(choice, { always: true });
    await source.respond(rememberedReply);
    expect((await first.wait()).finalOutput).toBe('done-0');
    await expect(source.respond(rememberedReply)).rejects.toThrow();
    expect(
      (await (await source.submit('same tool, new arguments')).wait())
        .finalOutput,
    ).toBe('done-1');
    const different = await source.submit('other raw tool');
    await source.respond((await portableMcpApproval(different)).reply('deny'));
    expect((await different.wait()).finalOutput).toBe('done-2');
    expect(
      (await (await source.submit('original tool again')).wait()).finalOutput,
    ).toBe('done-3');
    const saved = await source.saveState();
    await source.close();
    await using restored = await agent.session({ state: saved });
    const final = await restored.submit('fresh cold owner');
    const fresh = await portableMcpApproval(final);
    await expect(restored.respond(rememberedReply)).rejects.toThrow();
    await restored.respond(fresh.reply('deny'));
    expect((await final.wait()).finalOutput).toBe('done-4');
    expect(remote.effects.map((entry) => entry.name)).toEqual(
      choice === 'allow_once'
        ? ['find-record', 'find-record', 'find-record']
        : [],
    );
    expect(remote.effects.map((entry) => entry.arguments)).toEqual(
      choice === 'allow_once' ? [{ key: '0' }, { key: '1' }, { key: '3' }] : [],
    );
    expect(JSON.stringify(model.requests)).not.toContain('rememberMcp');
    expect(JSON.stringify(saved)).not.toContain('remembered_mcp');
    model.assertExhausted();
  },
  30_000,
);

it.each(['credential', 'endpoint', 'declaration'] as const)(
  'remembered native MCP choice refuses a changed current %s',
  async (change) => {
    const schemas: Record<string, JsonObject> = {
      'find-record': { ...recordTool.inputSchema },
    };
    const original = await peer(
      'find-record',
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      schemas,
    );
    const replacement = await peer('find-record');
    const model = new ModelServer([
      [
        call(
          'reviewed',
          { key: 'first' },
          { namespace: 'mcp__fixture', callId: 'remember-source' },
        ),
      ],
      [message('first done')],
      [
        call(
          'reviewed',
          { key: 'second' },
          { namespace: 'mcp__fixture', callId: 'remember-changed' },
        ),
      ],
      [message('changed done')],
    ]);
    const config = await model.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-remembered-change',
      supportsWebsockets: false,
    });
    cleanup.push(() => provider.close());
    const descriptor = (changed: boolean) =>
      new HttpMCP({
        name: 'fixture',
        url: changed && change === 'endpoint' ? replacement.url : original.url,
        tools: ['find-record'],
        toolNameOverrides: { 'find-record': 'reviewed' },
        approvalMode: 'preapproved',
        toolApprovalOverrides: { 'find-record': 'prompt' },
        ...(changed && change === 'credential'
          ? { bearerToken: 'new-synthetic-token' }
          : {}),
        cacheToolsList: false,
      });
    const agent = new Agent({
      instructions: 'Use the record.',
      provider,
      model: 'gpt-5.5',
      programmaticToolCalling: false,
      tools: [descriptor(false)],
    });
    await using session = await agent.session();
    const first = await session.submit('first');
    await session.respond(
      (await portableMcpApproval(first)).reply('allow_once', { always: true }),
    );
    expect((await first.wait()).finalOutput).toBe('first done');
    expect(original.effects).toHaveLength(1);
    if (change === 'declaration')
      schemas['find-record'] = {
        ...recordTool.inputSchema,
        properties: {
          ...recordTool.inputSchema.properties,
          revision: { type: 'string' },
        },
      };
    await session.update({ tools: [descriptor(true)] });
    const changed = await session.submit('changed binding');
    const request = await portableMcpApproval(changed);
    expect(original.effects).toHaveLength(1);
    expect(replacement.effects).toHaveLength(0);
    await session.respond(request.reply('deny'));
    expect((await changed.wait()).finalOutput).toBe('changed done');
    expect(original.effects).toHaveLength(1);
    expect(replacement.effects).toHaveLength(0);
    model.assertExhausted();
  },
  30_000,
);

it('requires a fresh native MCP decision after reconnect without replaying the lost effect', async () => {
  const remote = await peer('lookup', undefined, reconnectResult, firstEffect);
  const { model, session } = await open(
    new HttpMCP({
      ...reconnectOptions,
      url: remote.url,
      activation: 'session',
      toolApprovalOverrides: { lookup: 'prompt' },
    }),
    reconnectResponses(),
  );
  expect(remote.initializations).toBe(1);
  const turn = await session.submit('Record both entries.');
  const first = await portableMcpApproval(turn);
  const stale = first.reply('allow_once');
  await session.respond(first.reply('allow_once', { always: true }));
  const second = await portableMcpApproval(turn);
  expect(second).not.toBe(first);
  expect(remote.effects).toMatchObject([
    { name: 'lookup', arguments: { key: firstEffect }, initialization: 1 },
  ]);
  await expect(session.respond(stale)).rejects.toThrow();
  await session.respond(second.reply('deny'));
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(remote.effects).toHaveLength(1);
  expect(remote.initializations).toBe(2);
  expectToolOutput(
    model.requests[1]!,
    firstEffect,
    'MCP tool invocation failed',
  );
  model.assertExhausted();
}, 30_000);

it.each(['wire', 'arguments'] as const)(
  'v0 strict MCP optional-null compatibility: %s',
  async (mode) => {
    const remote = await peer(
      'lookup',
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      {
        lookup: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            optional: { type: 'string' },
            nullable: { type: ['string', 'null'] },
          },
          required: ['key'],
          additionalProperties: false,
        },
      },
    );
    const { session, model } = await open(
      new HttpMCP({
        ...reconnectOptions,
        url: remote.url,
        tools: ['lookup'],
        strictToolSchemas: true,
      }),
      [
        [
          call(
            'lookup',
            { key: 'strict-case', optional: null, nullable: null },
            { namespace: 'mcp__fixture', callId: 'strict-null' },
          ),
        ],
        [message('done')],
      ],
    );
    expect(
      (await (await session.submit('Use the optional defaults.')).wait())
        .finalOutput,
    ).toBe('done');
    if (mode === 'arguments') {
      expect(remote.effects).toHaveLength(1);
      expect(remote.effects[0].arguments).toEqual({
        key: 'strict-case',
        nullable: null,
      });
    } else {
      const namespace = (model.requests[0].tools as JsonObject[]).find(
        (tool) => tool.name === 'mcp__fixture',
      );
      const spec = (namespace!.tools as JsonObject[]).find(
        (tool) => tool.name === 'lookup',
      )!;
      const acceptsNull = (schema: JsonObject): boolean =>
        schema.type === 'null' ||
        (Array.isArray(schema.type) && schema.type.includes('null')) ||
        (Array.isArray(schema.anyOf) &&
          schema.anyOf.some((value) => acceptsNull(value as JsonObject)));
      expect(spec.strict).toBe(true);
      const properties = (spec.parameters as JsonObject)
        .properties as JsonObject;
      expect(acceptsNull(properties.optional as JsonObject)).toBe(true);
    }
    expect(model.requests).toHaveLength(2);
  },
);

it.each(['cold', 'recapture', 'changed_policy', 'tampered_call'] as const)(
  'keeps strict MCP effective arguments behind its canonical cold owner (%s)',
  async (mode) => {
    const schema = {
      type: 'object',
      properties: {
        key: { type: 'string' },
        optional: { type: 'string' },
        nullable: { type: ['string', 'null'] },
      },
      required: ['key'],
      additionalProperties: false,
    };
    const remote = await peer(
      'lookup',
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { lookup: schema },
    );
    const args = { key: 'strict-cold', optional: null, nullable: null };
    const sampled = call('lookup', args, {
      namespace: 'mcp__fixture',
      callId: 'strict-cold',
    });
    sampled.arguments =
      ' { "key": "strict-cold", "optional": null, "nullable": null } ';
    const model = new ModelServer([[sampled], [message('strict cold done')]]);
    const config = await model.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-strict-mcp',
      supportsWebsockets: false,
    });
    cleanup.push(() => provider.close());
    const agentFor = (strict: boolean) =>
      new Agent({
        instructions: 'Read the record.',
        provider,
        model: 'gpt-5.5',
        programmaticToolCalling: false,
        tools: [
          new HttpMCP({
            name: 'fixture',
            url: remote.url,
            tools: ['lookup'],
            approvalMode: 'preapproved',
            toolApprovalOverrides: { lookup: 'prompt' },
            cacheToolsList: false,
            strictToolSchemas: strict,
          }),
        ],
      });
    const agent = agentFor(true);
    const source = await agent.session();
    cleanup.push(() => source.close());
    const original = await source.submit('Read');
    const old = await portableMcpApproval(original);
    const oldReply = old.reply('allow_once');
    expect(remote.effects).toEqual([]);
    let serialized = JSON.stringify(await source.suspend());
    await source.close();
    const recorded = JSON.parse(serialized);
    expect(recorded.manual_continuation.pending_mcp[0].arguments).toEqual(args);
    const authenticated = (value: string) =>
      parseSessionState(value, {
        expectedSha256: createHash('sha256').update(value).digest('hex'),
      });
    if (mode === 'tampered_call') {
      recorded.manual_continuation.pending_mcp[0].arguments.optional = 'forged';
      await expect(
        agent
          .session({ state: authenticated(JSON.stringify(recorded)) })
          .then((opened) => {
            cleanup.push(() => opened.close());
            return opened;
          }),
      ).rejects.toThrow();
      expect(remote.effects).toEqual([]);
      expect(model.requests).toHaveLength(1);
      return;
    }
    if (mode === 'changed_policy') {
      await expect(
        agentFor(false)
          .session({ state: authenticated(serialized) })
          .then((opened) => {
            cleanup.push(() => opened.close());
            return opened;
          }),
      ).rejects.toThrow();
      expect(remote.effects).toEqual([]);
      expect(model.requests).toHaveLength(1);
      return;
    }
    let restored = await agent.session({ state: authenticated(serialized) });
    cleanup.push(() => restored.close());
    let request = await portableMcpApproval(restored.restoredTurn!);
    expect(remote.effects).toEqual([]);
    expect(model.requests).toHaveLength(1);
    if (mode === 'recapture') {
      serialized = JSON.stringify(await restored.suspend());
      expect(
        JSON.parse(serialized).manual_continuation.pending_mcp[0].arguments,
      ).toEqual(args);
      await restored.close();
      restored = await agent.session({ state: authenticated(serialized) });
      request = await portableMcpApproval(restored.restoredTurn!);
    }
    await expect(restored.respond(oldReply)).rejects.toThrow();
    expect(remote.effects).toEqual([]);
    await restored.respond(request.reply('allow_once'));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
      'strict cold done',
    );
    expect(remote.effects.map((effect) => effect.arguments)).toEqual([
      { key: 'strict-cold', nullable: null },
    ]);
    expect(model.requests).toHaveLength(2);
    model.assertExhausted();
  },
  30_000,
);

it.each(['before', 'approval'] as const)(
  'shares strict MCP effective arguments with app %s and the actual RPC',
  async (phase) => {
    const schema = {
      type: 'object',
      properties: {
        key: { type: 'string' },
        optional: { type: 'string' },
        nullable: { type: ['string', 'null'] },
      },
      required: ['key'],
      additionalProperties: false,
    };
    const remote = await peer(
      'lookup',
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { lookup: schema },
    );
    const views: { original: JsonObject; effective: JsonObject }[] = [];
    const metadata: JsonObject[] = [];
    const observe = (ctx: MCPCallContext) => {
      views.push({
        original: structuredClone(ctx.originalArguments),
        effective: structuredClone(ctx.effectiveArguments),
      });
    };
    const { session, model } = await open(
      new HttpMCP({
        ...reconnectOptions,
        url: remote.url,
        tools: ['lookup'],
        strictToolSchemas: true,
        ...(phase === 'before'
          ? {
              before(ctx: MCPCallContext) {
                observe(ctx);
                return { action: 'allow' as const };
              },
            }
          : {
              approval(ctx: MCPCallContext) {
                observe(ctx);
                return true;
              },
            }),
        requestMetadata(event) {
          metadata.push(structuredClone(event.arguments));
          return {};
        },
      }),
      [
        [
          call(
            'lookup',
            { key: 'strict-app', optional: null, nullable: null },
            { namespace: 'mcp__fixture', callId: 'strict-app' },
          ),
        ],
        [message('strict app done')],
      ],
    );
    expect((await (await session.submit('Read')).wait()).finalOutput).toBe(
      'strict app done',
    );
    expect(views).toEqual([
      {
        original: { key: 'strict-app', optional: null, nullable: null },
        effective: { key: 'strict-app', nullable: null },
      },
    ]);
    expect(metadata).toEqual([{ key: 'strict-app', nullable: null }]);
    expect(remote.effects.map((effect) => effect.arguments)).toEqual([
      { key: 'strict-app', nullable: null },
    ]);
    expect(model.requests).toHaveLength(2);
    model.assertExhausted();
  },
  30_000,
);
