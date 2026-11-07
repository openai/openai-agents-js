import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  tool,
  manualTool,
  type Session,
} from '../../src';
import {
  decode,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from '../../src/runtime/binding';

// These fixtures observe actual native HTTP or Model-boundary requests, where
// Core's typed schema could have discarded the accepted Zod constraints.
const sessions: Session[] = [];
const servers: Server[] = [];
const sockets: WebSocketServer[] = [];
const providers: NativeProvider[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0).reverse()) await session.close();
  for (const ws of sockets.splice(0)) {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      ws.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const provider of providers.splice(0)) await provider.close();
});

function lookup(
  minimum: number,
  identity = {
    name: 'lookup',
    description: 'Read a record using its key and team owner.',
  },
) {
  return tool({
    ...identity,
    parameters: z.object({
      key: z.string().min(minimum).describe('Record key'),
      record: z.object({
        owner: z.object({ team: z.string().min(2) }),
        label: z.string().min(4),
      }),
    }),
    execute: ({ key }) => key,
  });
}

function declarations(request: JsonObject): JsonObject[] {
  const result: JsonObject[] = [];
  const add = (values: JsonValue) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const definedTool = jsonObject.parse(value);
      if (definedTool.type === 'namespace') add(definedTool.tools ?? []);
      else if (definedTool.type === 'function' && definedTool.name === 'lookup')
        result.push(definedTool);
    }
  };
  add(request.tools ?? []);
  if (Array.isArray(request.input)) {
    for (const value of request.input) {
      const item = jsonObject.parse(value);
      if (item.type === 'additional_tools') add(item.tools ?? []);
    }
  }
  return result;
}

async function fixture(
  websocket = false,
  itemFor?: (request: JsonObject) => JsonObject,
  disconnectAfterRequest = false,
) {
  const received: JsonObject[] = [];
  const frames: JsonObject[] = [];
  const reply = (request: JsonObject): JsonObject[] => {
    if (request.generate === false) {
      return [
        { type: 'response.created', response: { id: 'resp_warmup_schema' } },
        { type: 'response.completed', response: { id: 'resp_warmup_schema' } },
      ];
    }
    const count = received.length + frames.length;
    const id = 'resp_schema_' + count;
    const item = itemFor?.(request) ?? {
      type: 'message',
      id: 'msg_schema_' + count,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ready', annotations: [] }],
    };
    return [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
  };
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(decode(jsonObject, Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of reply(received.at(-1)!))
      response.write('data: ' + JSON.stringify(event) + '\n\n');
    response.end();
  });
  servers.push(server);
  if (websocket) {
    const ws = new WebSocketServer({ server, perMessageDeflate: false });
    sockets.push(ws);
    ws.on('connection', (socket) =>
      socket.on('message', (bytes) => {
        const frame = decode(jsonObject, bytes.toString());
        frames.push(frame);
        if (disconnectAfterRequest && frame.generate !== false) {
          socket.terminate();
          return;
        }
        for (const event of reply(frame)) socket.send(JSON.stringify(event));
      }),
    );
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Schema fixture did not bind');
  const provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'fixture',
    supportsWebsockets: websocket,
  });
  providers.push(provider);
  return { provider, received, frames };
}

async function answer(session: Session, text: string) {
  expect((await (await session.submit(text)).wait()).finalOutput).toBe('ready');
}

function expectLookup(request: JsonObject, tool: ReturnType<typeof lookup>) {
  const actual = declarations(request);
  expect(actual).toHaveLength(1);
  expect(actual[0].description).toBe(tool.description);
  expect(actual[0].parameters).toEqual(tool.parameters);
  const parameters = jsonObject.parse(actual[0].parameters);
  expect(
    jsonObject.parse(jsonObject.parse(parameters.properties).key),
  ).toMatchObject({
    minLength: expect.any(Number),
    description: 'Record key',
  });
  expect(JSON.stringify(request)).not.toContain('[agents-schema:');
}

describe('native function schema fidelity', () => {
  it.each([false, true])(
    'preserves full schemas across native transport and restore (WebSocket: %s)',
    async (websocket) => {
      const peer = await fixture(websocket);
      const declaration = lookup(9);
      const agent = new Agent({
        instructions: 'Answer briefly.',
        model: 'gpt-5.5',
        provider: peer.provider,
        tools: [declaration],
      });
      const session = await agent.session();
      sessions.push(session);
      await answer(session, 'Remember the record.');
      const requests = websocket ? peer.frames : peer.received;
      expect(requests.length).toBeGreaterThan(0);
      const published = requests.find(
        (request) => declarations(request).length > 0,
      );
      expect(published).toBeDefined();
      expectLookup(published!, declaration);
      if (websocket) expect(peer.received).toHaveLength(0);
      // A second turn exercises the WebSocket continuation receipt.
      await answer(session, 'Remember another record.');
      const state = await session.saveState();
      await session.close();
      const boundary = requests.length;
      const restored = await agent.session({ state });
      sessions.push(restored);
      await answer(restored, 'Read the saved record.');
      const republished = requests
        .slice(boundary)
        .find((request) => declarations(request).length > 0);
      expect(republished).toBeDefined();
      expectLookup(republished!, declaration);
    },
  );
});

it.each(['Agent.run', 'Session.suspend'])(
  'restores a manual action after %s over WebSocket without replaying it',
  restoreWebSocketCheckpoint,
  30_000,
);

async function restoreWebSocketCheckpoint(entry: string) {
  let responses = 0;
  const peer = await fixture(true, (): JsonObject => {
    responses++;
    return responses === 1
      ? {
          type: 'function_call',
          call_id: 'lookup-manual',
          name: 'lookup',
          arguments: '{"key":"record-A"}',
        }
      : {
          type: 'message',
          id: 'manual-finished',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'continued', annotations: [] },
          ],
        };
  });
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5.5',
    provider: peer.provider,
    tools: [lookup],
  });
  const nextRequest = async (session: Session) => {
    for await (const event of session.events()) {
      const request = lookup.match(event);
      if (request) return request;
    }
    throw new Error('No manual request');
  };
  let state;
  let original;
  if (entry === 'Agent.run') {
    const paused = await agent
      .run('Read record A.')
      .catch((error: unknown) => error);
    assert(paused instanceof InteractionRequired);
    state = paused.state;
  } else {
    const session = await agent.session();
    sessions.push(session);
    await session.submit('Read record A.');
    original = await nextRequest(session);
    const disconnected = Promise.all(
      [...sockets[0].clients].map((socket) => once(socket, 'close')),
    );
    state = await session.suspend();
    await session.close();
    await disconnected;
  }
  assert(state?.format_version === 5);
  expect(responses).toBe(1);
  const turnId = state.manual_continuation.turn_id;
  const answerLookup = (action: unknown) => {
    const current = lookup.match(action);
    assert(current);
    expect(current.callId).toBe('lookup-manual');
    expect(current.turnId).toBe(turnId);
    expect(current.arguments).toEqual({ key: 'record-A' });
    return current.reply('answer-A');
  };
  let result;
  if (original) {
    const restored = await agent.session({ state });
    sessions.push(restored);
    const current = await nextRequest(restored);
    expect(current.turnId).toBe(original.turnId);
    await expect(restored.respond(original.reply('stale'))).rejects.toThrow();
    const turn = restored.restoredTurn!;
    await restored.respond(answerLookup(current));
    result = await turn.wait();
  } else {
    result = await agent.run(null, { state, onInteraction: answerLookup });
  }
  expect(result.finalOutput).toBe('continued');
  expect(responses).toBe(2);
  expect(peer.received).toHaveLength(0);
  const continued = peer.frames
    .filter((frame) => frame.generate !== false)
    .at(-1)!;
  expect(continued.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'lookup-manual',
        output: 'answer-A',
      }),
    ]),
  );
}

it('reports restored WebSocket schemas above the transport cap before dispatch', async () => {
  const peer = await fixture(true);
  // Core's typed schema omits examples; the admitted carrier restores them.
  // JSON escapes each NUL to six bytes, keeping the source string smaller.
  const example = '\0'.repeat(Math.floor((64 * 1024 * 1024) / 6) + 1);
  const declaration = tool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({ key: z.string().meta({ examples: [example] }) }),
    execute: ({ key }) => key,
  });
  const schemaBytes = Buffer.byteLength(JSON.stringify(declaration.parameters));
  expect(schemaBytes).toBeGreaterThan(64 * 1024 * 1024);
  const agent = new Agent({
    instructions: 'Answer briefly.',
    model: 'gpt-5.5',
    provider: peer.provider,
    tools: [declaration],
  });
  const session = await agent.session();
  sessions.push(session);
  const turn = await session.submit('Read a record.');
  await expect(turn.wait()).rejects.toThrow(
    'Native WebSocket request exceeds the 64 MiB UTF-8 transport limit; model context limits are separate.',
  );
  await session.close();
  expect(peer.frames.filter((frame) => frame.generate !== false).length).toBe(
    0,
  );
  expect(peer.received.length).toBe(0);
}, 60_000);

it('does not replay a WebSocket request accepted before a disconnect', async () => {
  const peer = await fixture(true, undefined, true);
  const agent = new Agent({
    instructions: 'Answer briefly.',
    model: 'gpt-5.5',
    provider: peer.provider,
  });
  const session = await agent.session();
  sessions.push(session);
  const turn = await session.submit('Answer once.');
  await expect(turn.wait()).rejects.toThrow(
    'Native WebSocket request outcome is unknown after a send or disconnect; it will not be replayed.',
  );
  await session.close();
  expect(peer.frames.filter((frame) => frame.generate !== false).length).toBe(
    1,
  );
  expect(peer.received.length).toBe(0);
}, 30_000);
