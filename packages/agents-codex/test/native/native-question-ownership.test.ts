import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeAgents,
  NativeProvider,
  StdioMCP,
  type NativeQuestion,
  type Session,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { TurnAborted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

const wireId = 873;
const schema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};

type PeerCall = {
  label: string;
  response: ServerResponse;
  session: string;
  finish(text: string): void;
};

// Forms travel on actual tools/call response streams. No SDK identity is made
// here. Reusing the peer's numeric ID must not reuse a native question grant.
async function ownershipPeer() {
  const calls = new Map<string, PeerCall>();
  const replies: {
    id: number;
    result?: { action?: string; content?: unknown };
  }[] = [];
  const effects: string[] = [];
  const failures: unknown[] = [];
  const unsolicitedStreams = new Map<ServerResponse, string>();
  const pending = new Map<string, PeerCall>();
  const event = (response: ServerResponse, value: unknown) => {
    if (response.destroyed || response.writableEnded)
      throw new Error('Cannot emit a request on a retired transport');
    response.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const form = () => ({
    jsonrpc: '2.0',
    id: wireId,
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Owned fixture form',
      requestedSchema: schema,
    },
  });
  const peer = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        const session = request.headers['mcp-session-id'];
        if (typeof session === 'string' && session) {
          unsolicitedStreams.set(response, session);
          response.once('close', () => unsolicitedStreams.delete(response));
        }
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (!rpc.method) {
        replies.push(rpc);
        response.writeHead(202).end();
        const session = String(request.headers['mcp-session-id'] ?? '');
        const owner = pending.get(session);
        pending.delete(session);
        if (
          owner &&
          !owner.response.destroyed &&
          !owner.response.writableEnded
        ) {
          if (rpc.result?.action === 'accept') effects.push(owner.label);
          owner.finish(
            `${owner.label}:${rpc.result?.action}:${JSON.stringify(rpc.result?.content ?? null)}`,
          );
        }
        return;
      }
      const session =
        rpc.method === 'initialize'
          ? randomUUID()
          : String(request.headers['mcp-session-id'] ?? '');
      let result: unknown = {};
      if (rpc.method === 'initialize') {
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'ownership-peer', version: '1' },
        };
      } else if (rpc.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Change one fixture record',
              annotations: { destructiveHint: true, readOnlyHint: false },
              inputSchema: {
                type: 'object',
                properties: { label: { type: 'string' } },
                required: ['label'],
                additionalProperties: false,
              },
            },
          ],
        };
      } else if (rpc.method === 'tools/call') {
        const label = rpc.params.arguments.label;
        if (typeof label !== 'string' || calls.has(label))
          throw new Error('Expected one tools/call per fixture label');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        const selected: PeerCall = {
          label,
          response,
          session,
          finish(text) {
            if (response.destroyed || response.writableEnded) return;
            event(response, {
              jsonrpc: '2.0',
              id: rpc.id,
              result: { content: [{ type: 'text', text }] },
            });
            response.end();
          },
        };
        calls.set(label, selected);
        response.once('close', () => {
          if (pending.get(session) === selected) pending.delete(session);
        });
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': session,
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('No peer port');
  const close = async () => {
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
    expect(failures).toEqual([]);
  };
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    replies,
    effects,
    async entered(label: string) {
      return vi.waitFor(
        () => {
          const selected = calls.get(label);
          if (!selected) throw new Error(`No tools/call for ${label}`);
          return selected;
        },
        { timeout: 8000, interval: 20 },
      );
    },
    emit(selected: PeerCall) {
      // Each actual native MCP client has its negotiated transport session.
      // Sibling sessions can ask with the same numeric ID at the same time.
      if (pending.has(selected.session))
        throw new Error('A form is already awaiting this client reply');
      pending.set(selected.session, selected);
      event(selected.response, form());
    },
    async emitUnsolicited(session: string) {
      const stream = await vi.waitFor(
        () => {
          for (const [response, responseSession] of unsolicitedStreams) {
            if (
              responseSession === session &&
              !response.destroyed &&
              !response.writableEnded
            ) {
              return response;
            }
          }
          throw new Error('No unsolicited GET stream');
        },
        { timeout: 8000, interval: 20 },
      );
      event(stream, form());
    },
    [Symbol.asyncDispose]: close,
  };
}

async function waitForChildTurn(session: Session) {
  return vi.waitFor(
    async () => {
      const children = await Array.fromAsync(session.subagents());
      expect(children).toHaveLength(1);
      const [child] = children;
      if (!child?.turn) throw new Error('Expected the actual child turn');
      return { child, turn: child.turn };
    },
    { timeout: 5_000 },
  );
}

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

const lookup = (label: string) =>
  call(
    'lookup',
    { label },
    { namespace: 'mcp__ownership', callId: 'reused-call' },
  );

async function question(
  session: Session,
  child: string | null,
  type: NativeQuestion['type'],
) {
  return vi.waitFor(
    async () => {
      const found = (await session.pendingInteractions()).find(
        (item): item is NativeQuestion =>
          item.type === type && item.subagentId === child,
      );
      if (!found) throw new Error(`No ${type} for ${child ?? 'root'}`);
      return found;
    },
    { timeout: 8000, interval: 20 },
  );
}

it.each(['direct', 'code'] as const)(
  'keeps a delayed root reply with its original turn across numeric request and call ID reuse (%s)',
  async (route) => {
    await using peer = await ownershipPeer();
    const routedLookup = (label: string) =>
      route === 'direct'
        ? lookup(label)
        : {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'reused-call',
            input: `text(await tools.mcp__ownership__lookup(${JSON.stringify({ label })}));`,
          };
    const model = new ModelServer([
      [routedLookup('original')],
      [routedLookup('successor')],
      [message('successor done')],
    ]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Call the selected lookup.',
      model: 'gpt-5.5',
      provider,
      programmaticToolCalling: route === 'code',
      tools: [
        new HttpMCP({
          name: 'ownership',
          url: peer.url,
          tools: ['lookup'],
          approvalMode: 'preapproved',
        }),
      ],
    }).session();
    const original = await session.submit('original');
    const originalCall = await peer.entered('original');
    peer.emit(originalCall);
    const first = await question(session, null, 'elicitation_request');
    if (first.type !== 'elicitation_request' || first.mode !== 'form')
      throw new Error('Expected a form');
    expect(first).toMatchObject({
      turnId: original.turnId,
      submissionId: original.submissionId,
      subagentId: null,
    });
    const delayed = first.reply({ value: 'must-not-arrive' });
    const ended = original.wait().catch((error: unknown) => error);
    await original.cancel();
    expect(await ended).toBeInstanceOf(Error);
    await vi.waitFor(() =>
      expect(
        originalCall.response.destroyed || originalCall.response.writableEnded,
      ).toBe(true),
    );

    const successor = await session.submit('successor');
    peer.emit(await peer.entered('successor'));
    const second = await question(session, null, 'elicitation_request');
    if (second.type !== 'elicitation_request' || second.mode !== 'form')
      throw new Error('Expected a form');
    expect(second).not.toBe(first);
    expect(second.turnId).toBe(successor.turnId);
    expect(second.submissionId).toBe(successor.submissionId);
    expect(second.turnId).not.toBe(first.turnId);
    expect(() => first.reply({ value: 'stale' })).toThrow('expired');
    await expect(session.respond(delayed)).rejects.toThrow('expired');
    expect(await session.pendingInteractions()).toEqual([second]);
    expect(peer.effects).toEqual([]);
    await session.respond(second.reply({ value: 'successor-value' }));
    expect((await successor.wait()).finalOutput).toBe('successor done');
    expect(peer.effects).toEqual(['successor']);
    expect(JSON.stringify(model.requests[2].input)).toContain(
      'successor-value',
    );
    expect(JSON.stringify(model.requests[2].input)).not.toContain(
      'must-not-arrive',
    );
    expect(
      peer.replies.filter((reply) => reply.result?.action === 'accept'),
    ).toHaveLength(1);
    expect(
      peer.replies.filter((reply) => reply.result?.action === 'accept'),
    ).toMatchObject([
      {
        jsonrpc: '2.0',
        id: wireId,
        result: { action: 'accept', content: { value: 'successor-value' } },
      },
    ]);
    model.assertExhausted();
  },
  30_000,
);

it('ends an unanswered issued root form at an application deadline without accepting a late answer', async () => {
  await using peer = await ownershipPeer();
  const model = new ModelServer([[lookup('deadline')]]);
  await using provider = await providerFor(model);
  await using session = await new Agent({
    instructions: 'Call the selected lookup.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new HttpMCP({
        name: 'ownership',
        url: peer.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
      }),
    ],
  }).session();
  const turn = await session.submit('deadline');
  const entered = await peer.entered('deadline');
  peer.emit(entered);
  const request = await question(session, null, 'elicitation_request');
  if (request.type !== 'elicitation_request' || request.mode !== 'form')
    throw new Error('Expected a form');
  expect(request).toMatchObject({
    turnId: turn.turnId,
    submissionId: turn.submissionId,
    subagentId: null,
  });
  const late = request.reply({ value: 'must-not-arrive' });
  const completion = turn.wait();
  let settled = false;
  void completion.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  // The application starts its deadline only after a real form is issued.
  // Expiring an observer alone does not answer or cancel the native request.
  const deadline = AbortSignal.timeout(25);
  await once(deadline, 'abort');
  expect(deadline.reason).toMatchObject({ name: 'TimeoutError' });
  expect(settled).toBe(false);
  expect(await session.pendingInteractions()).toEqual([request]);
  expect(peer.replies).toEqual([]);
  expect(peer.effects).toEqual([]);

  await turn.cancel({ mode: 'force' });
  await expect(completion).rejects.toBeInstanceOf(TurnAborted);
  expect(settled).toBe(true);
  await vi.waitFor(() =>
    expect(entered.response.destroyed || entered.response.writableEnded).toBe(
      true,
    ),
  );
  expect(() => request.reply({ value: 'late' })).toThrow('expired');
  await expect(session.respond(late)).rejects.toThrow('expired');
  expect(await session.pendingInteractions()).toEqual([]);
  expect(
    peer.replies.filter((reply) => reply.result?.action === 'accept'),
  ).toEqual([]);
  expect(peer.effects).toEqual([]);
  expect(model.requests).toHaveLength(1);
  model.assertExhausted();
}, 30_000);

it('declines late unassociated delivery while a successor uses the same server', async () => {
  await using peer = await ownershipPeer();
  const model = new ModelServer([
    [lookup('original')],
    [message('original done')],
    [lookup('successor')],
    [message('successor done')],
  ]);
  await using provider = await providerFor(model);
  await using session = await new Agent({
    instructions: 'Call lookup.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new HttpMCP({
        name: 'ownership',
        url: peer.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
      }),
    ],
  }).session();
  const original = await session.submit('original');
  (await peer.entered('original')).finish('original result');
  expect((await original.wait()).finalOutput).toBe('original done');
  const successor = await session.submit('successor');
  const nextCall = await peer.entered('successor');
  // A server can retain an old callback, but its unsolicited GET request has
  // no trusted response-stream admission. Current-server membership is no grant.
  await peer.emitUnsolicited(nextCall.session);
  await vi.waitFor(
    () =>
      expect(peer.replies).toMatchObject([
        { id: wireId, result: { action: 'cancel' } },
      ]),
    { timeout: 8000 },
  );
  expect(await session.pendingInteractions()).toEqual([]);
  expect(peer.effects).toEqual([]);
  peer.emit(nextCall);
  const current = await question(session, null, 'elicitation_request');
  if (current.type !== 'elicitation_request' || current.mode !== 'form')
    throw new Error('Expected a form');
  expect(current.turnId).toBe(successor.turnId);
  await session.respond(current.reply({ value: 'actual-current-request' }));
  expect((await successor.wait()).finalOutput).toBe('successor done');
  expect(peer.effects).toEqual(['successor']);
  expect(JSON.stringify(model.requests[3].input)).toContain(
    'actual-current-request',
  );
  model.assertExhausted();
}, 30_000);

function threadId(request: JsonObject): string {
  const metadata = request.client_metadata as Record<string, string>;
  return String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
}

it('binds opted-in child forms to the actual child incarnation and leaves a sibling answerable after interruption', async () => {
  const executor = await startPublicExecutor();
  try {
    await using peer = await ownershipPeer();
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: JsonObject) => {
      const id = threadId(request);
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id !== rootId)
        return count === 1 ? [lookup(id)] : [message(`child ${id} done`)];
      if (count === 4) {
        if (!interruptedChildId)
          throw new Error('Expected a captured child ID');
        return [
          call(
            'interrupt_agent',
            { target: interruptedChildId },
            {
              namespace: 'collaboration',
              callId: 'interrupt-alpha',
            },
          ),
        ];
      }
      return count <= 2
        ? [
            call(
              'spawn_agent',
              {
                task_name: count === 1 ? 'alpha' : 'beta',
                message: 'Call lookup.',
              },
              { namespace: 'collaboration', callId: `spawn-${count}` },
            ),
          ]
        : [message('root done')];
    };
    const model = new ModelServer(Array.from({ length: 8 }, () => respond));
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Delegate lookup to two children.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents({ interactions: true }),
        new HttpMCP({
          name: 'ownership',
          url: peer.url,
          tools: ['lookup'],
          approvalMode: 'preapproved',
        }),
      ],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect(
      (await (await session.submit('start both')).wait()).finalOutput,
    ).toBe('root done');
    const children = await vi.waitFor(
      async () => {
        const current = await Array.fromAsync(session.subagents());
        expect(current).toHaveLength(2);
        expect(current.every((child) => child.turn !== null)).toBe(true);
        return current;
      },
      { timeout: 5_000 },
    );
    const [alpha, beta] = children;
    const interruptedChildId = alpha.id;
    if (!alpha.turn || !beta.turn) throw new Error('Expected live child turns');
    const original = alpha.turn;
    const sibling = beta.turn;
    peer.emit(await peer.entered(alpha.id));
    const first = await question(session, alpha.id, 'elicitation_request');
    if (first.type !== 'elicitation_request' || first.mode !== 'form')
      throw new Error('Expected a child form');
    expect(first).toMatchObject({
      subagentId: alpha.id,
      turnId: original.turnId,
      submissionId: original.submissionId,
    });
    peer.emit(await peer.entered(beta.id));
    const current = await question(session, beta.id, 'elicitation_request');
    if (current.type !== 'elicitation_request' || current.mode !== 'form')
      throw new Error('Expected a sibling form');
    expect(current).toMatchObject({
      subagentId: beta.id,
      turnId: sibling.turnId,
      submissionId: sibling.submissionId,
    });
    expect(current.submissionId).not.toBe(first.submissionId);
    expect(await session.pendingInteractions()).toHaveLength(2);
    const delayed = first.reply({ value: 'cancelled-child-value' });
    const ended = original.wait().catch((error: unknown) => error);
    expect(
      (
        await (
          await session.submit('Interrupt alpha and leave beta running.')
        ).wait()
      ).finalOutput,
    ).toBe('root done');
    expect(await ended).toBeInstanceOf(Error);
    await vi.waitFor(() =>
      expect(
        peer.calls.get(alpha.id)?.response.destroyed ||
          peer.calls.get(alpha.id)?.response.writableEnded,
      ).toBe(true),
    );
    await expect(session.respond(delayed)).rejects.toThrow('expired');
    expect(await session.pendingInteractions()).toEqual([current]);
    await session.respond(current.reply({ value: 'sibling-value' }));
    expect((await sibling.wait()).finalOutput).toBe(`child ${beta.id} done`);
    expect(peer.effects).toEqual([beta.id]);
    const next = model.requests
      .filter((request) => threadId(request) === beta.id)
      .at(-1)!;
    expect(JSON.stringify(next.input)).toContain('sibling-value');
    expect(JSON.stringify(next.input)).not.toContain('cancelled-child-value');
    model.assertExhausted();
  } finally {
    await executor.close();
  }
}, 40_000);

for (const interactions of [false, true]) {
  it(`requires explicit child opt-in for a real MCP approval, interactions=${interactions}`, async () => {
    const executor = await startPublicExecutor();
    const releaseChild = Promise.withResolvers<void>();
    try {
      await using peer = await ownershipPeer();
      let rootId: string | undefined;
      const counts = new Map<string, number>();
      const respond = async (request: JsonObject) => {
        const id = threadId(request);
        rootId ??= id;
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        if (id !== rootId) {
          if (count === 1) return [lookup(id)];
          await releaseChild.promise;
          return [message('child done')];
        }
        return count === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'approval_child', message: 'Call lookup.' },
                { namespace: 'collaboration', callId: 'spawn' },
              ),
            ]
          : [message('root done')];
      };
      const model = new ModelServer(Array.from({ length: 4 }, () => respond));
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Delegate lookup.',
        model: 'gpt-5.5',
        provider,
        tools: [
          interactions
            ? new NativeAgents({ interactions: true })
            : new NativeAgents(),
          new HttpMCP({
            name: 'ownership',
            url: peer.url,
            tools: ['lookup'],
            approvalMode: 'native',
          }),
        ],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('delegate')).wait()).finalOutput,
      ).toBe('root done');
      const { child, turn } = await waitForChildTurn(session);
      if (interactions) {
        const request = await question(session, child.id, 'approval_request');
        if (request.type !== 'approval_request')
          throw new Error('Expected a native approval');
        expect(request).toMatchObject({
          subagentId: child.id,
          turnId: turn.turnId,
          submissionId: turn.submissionId,
        });
        expect(peer.calls.size).toBe(0);
        await session.respond(request.reply('allow_once'));
        (await peer.entered(child.id)).finish('approved child tool result');
        expect(() => request.reply('allow_once')).toThrow('expired');
      }
      releaseChild.resolve();
      expect((await turn.wait()).finalOutput).toBe('child done');
      expect(peer.calls.size).toBe(interactions ? 1 : 0);
      expect(await session.pendingInteractions()).toEqual([]);
      const next = model.requests
        .filter((request) => threadId(request) === child.id)
        .at(-1)!;
      if (interactions)
        expect(JSON.stringify(next.input)).toContain(
          'approved child tool result',
        );
      model.assertExhausted();
    } finally {
      releaseChild.resolve();
      await executor.close();
    }
  }, 30_000);
}

it('denies an actual opted-in child command approval before any file effect and revokes a prepared allow', async () => {
  const executor = await startPublicExecutor();
  // The only write target stays inside the fixture's ordinary working directory.
  // This test never requests access to its parent or changes daemon protections.
  const target = join(executor.cwd, `child-denial-${randomUUID()}`);
  try {
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: JsonObject) => {
      const id = threadId(request);
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId) {
        return count === 1
          ? [
              call(
                'spawn_agent',
                {
                  task_name: 'command_child',
                  message: 'Request the fixture command.',
                },
                { namespace: 'collaboration', callId: 'spawn-command' },
              ),
            ]
          : [message('root done')];
      }
      return count === 1
        ? [
            call(
              'exec_command',
              {
                cmd: `printf child-proof > '${target.replaceAll("'", "'\\''")}'`,
                sandbox_permissions: 'require_escalated',
                justification: 'One fixture-owned command requiring a decision',
              },
              { callId: 'child-exec-denial' },
            ),
          ]
        : [message('child denial observed')];
    };
    const model = new ModelServer(Array.from({ length: 4 }, () => respond));
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Delegate one fixture command.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents({ interactions: true })],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect((await (await session.submit('delegate')).wait()).finalOutput).toBe(
      'root done',
    );
    const { child, turn } = await waitForChildTurn(session);
    const request = await question(session, child.id, 'approval_request');
    if (request.type !== 'approval_request')
      throw new Error('Expected an actual child approval');
    expect(request).toMatchObject({
      sessionId: session.id,
      subagentId: child.id,
      turnId: turn.turnId,
      submissionId: turn.submissionId,
      call: null,
    });
    expect(request.description).toContain(target);
    expect(
      model.requests.filter((entry) => threadId(entry) === child.id),
    ).toHaveLength(1);
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const preparedAllow = request.reply('allow_once');
    await session.respond(request.reply('deny'));
    await expect(session.respond(preparedAllow)).rejects.toThrow('expired');
    expect((await turn.wait()).finalOutput).toBe('child denial observed');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await session.pendingInteractions()).toEqual([]);
    const childRequests = model.requests.filter(
      (entry) => threadId(entry) === child.id,
    );
    expect(childRequests).toHaveLength(2);
    const outputs = (childRequests[1].input as JsonObject[]).filter(
      (item) =>
        item.type === 'function_call_output' &&
        item.call_id === 'child-exec-denial',
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs[0].output)).toMatch(
      /denied|reject|declin|not approved/i,
    );
    model.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);

const stdioSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  $defs: {
    role: {
      type: 'object',
      properties: { code: { type: 'string', minLength: 2 } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  properties: {
    profile: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2 },
        roles: { type: 'array', items: { $ref: '#/$defs/role' }, minItems: 1 },
      },
      required: ['name', 'roles'],
      additionalProperties: false,
    },
    count: { type: 'integer', minimum: 0 },
  },
  required: ['profile', 'count'],
  additionalProperties: false,
  allOf: [{ properties: { count: { minimum: 2 } } }],
};
const stdioValues = {
  profile: { name: 'Ada', roles: [{ code: 'ok' }] },
  count: 2,
};

async function stdioRecords(path: string): Promise<JsonObject[]> {
  const text = await readFile(path, 'utf8');
  // A live peer may still be appending. Observe only complete records.
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

async function stdioPids(path: string): Promise<number[]> {
  return (await stdioRecords(path)).map(({ pid }) => {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Peer recorded an invalid process ID');
    return pid;
  });
}

function stdioAlive(pid: number): boolean {
  try {
    // Signal 0 observes the process, including on Windows; it does not stop it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function stdioStopped(pid: number) {
  await vi.waitFor(
    () => expect(stdioAlive(pid), `peer ${pid} remains alive`).toBe(false),
    { timeout: 8000, interval: 20 },
  );
}

async function stdioPeer(
  directory: string,
  name: string,
  form: boolean,
  options: {
    lifetime?: 'turn';
    schedule?: 'call' | 'catalog';
    location?: 'environment';
  } = {},
) {
  const config = join(directory, `${name}-config.json`);
  const starts = join(directory, `${name}-starts.jsonl`);
  const journal = join(directory, `${name}-journal.jsonl`);
  const source = resolve(import.meta.dirname, 'fixtures/owned-form-stdio.mjs');
  const program =
    options.location === 'environment'
      ? join(directory, `${name}-peer.mjs`)
      : source;
  if (options.location === 'environment') await copyFile(source, program);
  await Promise.all([
    writeFile(
      config,
      JSON.stringify({
        label: name,
        form,
        startupForm: options.schedule === 'catalog',
        schema: stdioSchema,
      }),
    ),
    writeFile(starts, ''),
    writeFile(journal, ''),
  ]);
  return {
    starts,
    journal,
    declaration: new StdioMCP({
      name,
      tools: ['lookup'],
      approvalMode: 'preapproved',
      command: process.execPath,
      args: [program, config, starts, journal],
      cwd: directory,
      ...(options.lifetime ? { lifetime: options.lifetime } : {}),
      ...(options.location ? { location: options.location } : {}),
    }),
  };
}

it('validates a deferred turn-scoped catalog before provider or tool effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-deferred-catalog-'));
  try {
    const peer = await stdioPeer(directory, 'missing_selected', false, {
      lifetime: 'turn',
    });
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const selected = new StdioMCP({
      name: peer.declaration.name,
      tools: ['missing_from_catalog'],
      before,
      command: peer.declaration.command,
      args: peer.declaration.args,
      cwd: peer.declaration.cwd,
      lifetime: 'turn',
    });
    const model = new ModelServer([]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Do not act before the selected catalog is valid.',
      model: 'gpt-5.5',
      provider,
      tools: [selected],
    }).session();
    expect(await stdioPids(peer.starts)).toEqual([]);
    const turn = await session.submit('Use the selected tool.');
    await expect(turn.wait()).rejects.toThrow(/catalog|selected tool/i);
    const pids = await stdioPids(peer.starts);
    expect(pids).toHaveLength(1);
    await stdioStopped(pids[0]);
    const records = await stdioRecords(peer.journal);
    expect(records.some((entry) => entry.kind === 'catalog')).toBe(true);
    expect(records.filter((entry) => entry.kind === 'call')).toEqual([]);
    expect(model.requests).toHaveLength(0);
    expect(before).not.toHaveBeenCalled();
    expect(await session.pendingInteractions()).toEqual([]);
    model.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('preserves an inherited callable stdio process for default children when the root opts into turn lifetime', async () => {
  const executor = await startPublicExecutor();
  const directory = await mkdtemp(
    join(executor.cwd, 'agents-child-stdio-lifetime-'),
  );
  const releaseChild = Promise.withResolvers<void>();
  try {
    const peer = await stdioPeer(directory, 'inherited', false, {
      lifetime: 'turn',
      location: 'environment',
    });
    let rootId: string | undefined;
    let rootPid: number | undefined;
    let childFollowup: JsonObject | undefined;
    const counts = new Map<string, number>();
    const respond = async (request: JsonObject) => {
      const id = threadId(request);
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId) {
        if (count === 1) {
          // Root preparation has admitted its process before its first model
          // request. The child does not exist yet, so this PID is unambiguous.
          const launched = await stdioPids(peer.starts);
          expect(launched).toHaveLength(1);
          rootPid = launched[0];
          return [
            call(
              'spawn_agent',
              {
                task_name: 'ordinary_child',
                message: 'Call inherited lookup once.',
              },
              { namespace: 'collaboration', callId: 'spawn-inherited' },
            ),
          ];
        }
        return [message('root done')];
      }
      if (count === 1) {
        return [
          call(
            'lookup',
            {},
            { namespace: 'mcp__inherited', callId: 'child-lookup' },
          ),
        ];
      }
      childFollowup = request;
      await releaseChild.promise;
      return [message('child inherited lookup done')];
    };
    const model = new ModelServer(Array.from({ length: 4 }, () => respond));
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Delegate lookup to an ordinary child.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents(), peer.declaration],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    try {
      expect(await stdioPids(peer.starts)).toEqual([]);
      expect(
        (await (await session.submit('delegate')).wait()).finalOutput,
      ).toBe('root done');
      if (rootPid === undefined)
        throw new Error('Root model never observed its admitted process');
      const { child, turn } = await waitForChildTurn(session);
      await vi.waitFor(
        () => {
          if (!childFollowup)
            throw new Error('Child has not received its native MCP result');
        },
        { timeout: 8000, interval: 20 },
      );
      const followup = childFollowup;
      if (!followup)
        throw new Error('Expected the actual child result request');
      const launched = await stdioPids(peer.starts);
      expect(launched).toHaveLength(2);
      const childPid = launched.find((pid) => pid !== rootPid);
      if (childPid === undefined)
        throw new Error('Expected a separate child session process');
      expect(
        (await stdioRecords(peer.journal)).filter(
          (entry) => entry.kind === 'call',
        ),
      ).toMatchObject([{ pid: childPid, ordinal: 1 }]);
      expect(threadId(followup)).toBe(child.id);
      expect(JSON.stringify(followup.input)).toContain(
        `inherited:pid=${childPid}:call=1`,
      );
      await stdioStopped(rootPid);
      expect(stdioAlive(childPid)).toBe(true);
      releaseChild.resolve();
      expect((await turn.wait()).finalOutput).toBe(
        'child inherited lookup done',
      );
      expect(stdioAlive(childPid)).toBe(true);
      expect(await session.pendingInteractions()).toEqual([]);
      model.assertExhausted();
      await session.close();
      await stdioStopped(childPid);
      expect(stdioAlive(rootPid)).toBe(false);
      expect(
        (await stdioPids(peer.starts)).every((pid) => !stdioAlive(pid)),
      ).toBe(true);
    } finally {
      releaseChild.resolve();
    }
  } finally {
    try {
      await executor.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 40_000);

for (const schedule of ['call', 'catalog'] as const) {
  it(`isolates turn-scoped stdio ${schedule} forms while preserving a callable session-scoped sibling across two turns`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'agents-question-lifetimes-'),
    );
    try {
      const persistent = await stdioPeer(directory, 'persistent', false);
      const selected = await stdioPeer(directory, 'owned_form', true, {
        lifetime: 'turn',
        schedule,
      });
      const lookupPeer = (name: string) =>
        call(
          'lookup',
          {},
          { namespace: `mcp__${name}`, callId: `lookup-${name}` },
        );
      const model = new ModelServer([
        [lookupPeer('persistent')],
        [lookupPeer('owned_form')],
        [message('first done')],
        [lookupPeer('persistent')],
        [lookupPeer('owned_form')],
        [message('second done')],
      ]);
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Read both selected peers.',
        model: 'gpt-5.5',
        provider,
        tools: [persistent.declaration, selected.declaration],
      }).session();
      expect(persistent.declaration.lifetime).toBe('session');
      expect(await stdioPids(selected.starts)).toEqual([]);
      const persistentPids = await stdioPids(persistent.starts);
      expect(persistentPids).toHaveLength(1);
      const persistentPid = persistentPids[0];
      expect(stdioAlive(persistentPid)).toBe(true);
      const ownedPids: number[] = [];

      for (const [index, expected] of ['first done', 'second done'].entries()) {
        const turn = await session.submit(`turn ${index + 1}`);
        const request = await question(session, null, 'elicitation_request');
        if (request.type !== 'elicitation_request' || request.mode !== 'form')
          throw new Error('Expected a real stdio form');
        expect(request).toMatchObject({
          turnId: turn.turnId,
          submissionId: turn.submissionId,
          subagentId: null,
        });
        expect(request.schema).toEqual(stdioSchema);
        expect(request.description).toContain(`during ${schedule}`);
        if (schedule === 'catalog') {
          expect(model.requests).toHaveLength(index * 3);
          expect(
            (await stdioRecords(selected.journal)).filter(
              (entry) => entry.kind === 'call',
            ),
          ).toHaveLength(index);
        }
        const launched = await stdioPids(selected.starts);
        expect(launched).toHaveLength(index + 1);
        const ownedPid = launched[index];
        ownedPids.push(ownedPid);
        expect(new Set(ownedPids).size).toBe(ownedPids.length);
        expect(stdioAlive(ownedPid)).toBe(true);
        expect(stdioAlive(persistentPid)).toBe(true);
        expect(await stdioPids(persistent.starts)).toEqual([persistentPid]);

        // Root allOf and nested object/array/ref constraints must survive the
        // standard MCP codec. Invalid replies leave the actual waiter pending.
        expect(() => request.reply({ ...stdioValues, count: 1 })).toThrow();
        expect(() =>
          request.reply({
            ...stdioValues,
            profile: { name: 'Ada', roles: [{ code: 'x' }] },
          }),
        ).toThrow();
        expect(
          (await stdioRecords(selected.journal)).filter(
            (entry) => entry.kind === 'reply',
          ),
        ).toHaveLength(index);
        expect(await session.pendingInteractions()).toEqual([request]);
        await session.respond(request.reply(stdioValues));
        expect((await turn.wait()).finalOutput).toBe(expected);
        await stdioStopped(ownedPid);
        expect(stdioAlive(persistentPid)).toBe(true);

        const accepted = (await stdioRecords(selected.journal)).filter(
          (entry) => entry.kind === 'reply',
        );
        expect(accepted).toHaveLength(index + 1);
        expect(accepted[index]).toMatchObject({
          pid: ownedPid,
          requestId: wireId,
          result: { action: 'accept', content: stdioValues },
        });
        expect(JSON.stringify(model.requests[index * 3 + 1].input)).toContain(
          `persistent:pid=${persistentPid}:call=${index + 1}`,
        );
        expect(JSON.stringify(model.requests[index * 3 + 2].input)).toContain(
          `owned_form:pid=${ownedPid}:call=1`,
        );
        expect(JSON.stringify(model.requests[index * 3 + 2].input)).toContain(
          'Ada',
        );
        if (index === 0) {
          await session.update({ tools: [persistent.declaration] });
          await session.update({
            tools: [persistent.declaration, selected.declaration],
          });
          expect(await stdioPids(persistent.starts)).toEqual([persistentPid]);
          expect(await stdioPids(selected.starts)).toEqual(ownedPids);
          expect(stdioAlive(persistentPid)).toBe(true);
          expect(stdioAlive(ownedPid)).toBe(false);
        }
      }
      model.assertExhausted();
      await session.close();
      await stdioStopped(persistentPid);
      for (const pid of ownedPids) expect(stdioAlive(pid)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
}

it('refuses a default persistent stdio form without invoking the native-question callback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-persistent-form-'));
  try {
    const peer = await stdioPeer(directory, 'persistent_form', true);
    const model = new ModelServer([
      [
        call(
          'lookup',
          {},
          { namespace: 'mcp__persistent_form', callId: 'form' },
        ),
      ],
      [message('negative response observed')],
    ]);
    await using provider = await providerFor(model);
    const onInteraction = vi.fn(() => {
      throw new Error('A session-scoped peer has no original-turn form grant');
    });
    const result = await new Agent({
      instructions: 'Call the persistent peer.',
      model: 'gpt-5.5',
      provider,
      tools: [peer.declaration],
    }).run('request input', { onInteraction });
    expect(result.finalOutput).toBe('negative response observed');
    expect(peer.declaration.lifetime).toBe('session');
    expect(onInteraction).not.toHaveBeenCalled();
    const recorded = await stdioRecords(peer.journal);
    expect(recorded.filter((entry) => entry.kind === 'form')).toHaveLength(1);
    expect(recorded.filter((entry) => entry.kind === 'reply')).toHaveLength(1);
    expect(recorded.filter((entry) => entry.kind === 'reply')).toMatchObject([
      { requestId: wireId, result: { action: 'cancel' } },
    ]);
    expect(
      recorded.some(
        (entry) =>
          entry.kind === 'reply' &&
          (entry.result as JsonObject).action === 'accept',
      ),
    ).toBe(false);
    expect(JSON.stringify(model.requests[1].input)).toContain('cancel');
    const launched = await stdioPids(peer.starts);
    expect(launched).toHaveLength(1);
    for (const pid of launched) await stdioStopped(pid);
    model.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('refuses a persistent stdio catalog prompt before admission and joins its process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-unowned-startup-'));
  try {
    const peer = await stdioPeer(directory, 'opening_form', true, {
      schedule: 'catalog',
    });
    const model = new ModelServer([]);
    await using provider = await providerFor(model);
    const agent = new Agent({
      instructions: 'Do not run before startup completes.',
      model: 'gpt-5.5',
      provider,
      tools: [peer.declaration],
    });
    let session: Session | undefined;
    try {
      // Core may cancel the prompt and allow a cooperative peer to finish its
      // catalog, or Session opening may reject. Neither outcome admits a turn.
      try {
        session = await agent.session();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      const recorded = await vi.waitFor(async () => {
        const records = await stdioRecords(peer.journal);
        expect(records.filter((entry) => entry.kind === 'reply')).toHaveLength(
          1,
        );
        return records;
      });
      expect(recorded.filter((entry) => entry.kind === 'form')).toMatchObject([
        { stage: 'catalog', requestId: wireId },
      ]);
      const replies = recorded.filter((entry) => entry.kind === 'reply');
      expect(replies).toHaveLength(1);
      const response = replies[0].result as JsonObject;
      expect(['decline', 'cancel']).toContain(response.action);
      expect(response.content ?? null).toBeNull();
      expect(recorded.filter((entry) => entry.kind === 'call')).toEqual([]);
      if (session) expect(await session.pendingInteractions()).toEqual([]);
      expect(model.requests).toEqual([]);
    } finally {
      await session?.close();
    }
    const launched = await stdioPids(peer.starts);
    expect(launched).toHaveLength(1);
    for (const pid of launched) await stdioStopped(pid);
    model.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

// Public model arguments cannot manufacture native approval event fields such
// as grant_root, network_approval_context, additional_permissions or kind.
// Those rejection cases require real Core producer fixtures. Do not turn
// synthetic events with a made-up _sdk_question_id into ownership evidence.
