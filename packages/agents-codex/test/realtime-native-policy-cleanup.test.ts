import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  backgroundResult,
  isFunctionApprovalRequest,
  realtimeHandoff,
  tool,
} from '../src';
import type { Session as NativeSession } from '../src/runtime/session';
import { ModelServer, call, message } from './native/fixtures/model-server';

type Frame = Record<string, any>;

// This peer scripts provider frames only. Session, policy admission, callback
// cancellation and native root settlement all use the real binding.
class PolicyPeer {
  readonly frames: Frame[] = [];
  private readonly server = new WebSocketServer({ noServer: true });
  private socket?: WebSocket;
  readonly disconnected = Promise.withResolvers<void>();
  constructor(model: ModelServer) {
    model.onUpgrade((request, transport, head) => {
      this.server.handleUpgrade(request, transport, head, (connection) =>
        this.server.emit('connection', connection, request),
      );
    });
    this.server.on('connection', (connection) => {
      this.socket = connection;
      connection.once('close', () => this.disconnected.resolve());
      const accepted: Frame = {};
      connection.on('message', (raw) => {
        const frame: Frame = JSON.parse(raw.toString());
        this.frames.push(frame);
        if (frame.type === 'session.update') {
          merge(accepted, frame.session);
          this.send({
            type: 'session.updated',
            session: { ...structuredClone(accepted), id: 'policy-session' },
          });
        } else if (frame.type === 'response.create') {
          const id = `continuation-${this.frames.length}`;
          this.send({ type: 'response.created', response: { id } });
          this.send({ type: 'response.done', response: { id, output: [] } });
        }
      });
    });
  }
  send(frame: Frame): void {
    if (!this.socket) throw new Error('Provider is not connected');
    this.socket.send(JSON.stringify(frame));
  }
  call(name: string, args: Frame, callId: string): string {
    return this.calls([[name, args, callId]], `response-${callId}`);
  }
  calls(
    calls: [string, Frame, string][],
    responseId: string,
    start = true,
  ): string {
    const items = calls.map(([name, args, callId]) => ({
      id: `item-${callId}`,
      type: 'function_call',
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
    }));
    if (start)
      this.send({ type: 'response.created', response: { id: responseId } });
    items.forEach((item, output_index) =>
      this.send({
        type: 'response.output_item.done',
        response_id: responseId,
        output_index,
        item,
      }),
    );
    this.send({
      type: 'response.done',
      response: { id: responseId, output: items },
    });
    return responseId;
  }
  async output(callId: string): Promise<string> {
    let result: Frame | undefined;
    await vi.waitFor(
      () => {
        result = this.frames.find(
          (frame) =>
            frame.type === 'conversation.item.create' &&
            frame.item?.type === 'function_call_output' &&
            frame.item.call_id === callId,
        );
        expect(result).toBeDefined();
      },
      { timeout: 10000 },
    );
    return result!.item.output;
  }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function merge(current: Frame, update: Frame): void {
  for (const [key, value] of Object.entries(update)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    )
      merge(current[key], value);
    else current[key] = structuredClone(value);
  }
}
async function providerFor(model: ModelServer): Promise<NativeProvider> {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-policy',
    supportsWebsockets: false,
  });
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each([
  ['opening', false],
  ['opening', true],
  ['voice', false],
  ['voice', true],
  ['retained', false],
  ['opening', 'before_wait'],
  ['opening', 'approval_wait'],
  ['opening', 'metadata'],
  ['opening', 'metadata_only'],
  ['voice', 'metadata'],
] as const)(
  'rechecks the captured %s Agent MCP predicate before dispatch (hooks: %s)',
  async (source, hooks) => {
    const effects: unknown[] = [];
    const remote = createServer(async (request, response) => {
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
      let result: Frame = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'predicate-fixture', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            { name: 'lookup', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      else if (rpc.method === 'tools/call') {
        effects.push(rpc.params);
        result = { content: [{ type: 'text', text: 'accepted record' }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise<void>((resolve) =>
      remote.listen(0, '127.0.0.1', resolve),
    );
    const address = remote.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing MCP address');
    const model = new ModelServer(
      source !== 'voice'
        ? [
            [
              call(
                'lookup',
                {},
                { namespace: 'mcp__records', callId: 'backend-lookup' },
              ),
            ],
            [message('backend accepted')],
          ]
        : [],
    );
    const peer = new PolicyPeer(model);
    const context = { enabled: true };
    const hookEntered = Promise.withResolvers<void>();
    const releaseHook = Promise.withResolvers<void>();
    const waitsForHook = hooks === 'before_wait' || hooks === 'approval_wait';
    const checksMetadata = hooks === 'metadata' || hooks === 'metadata_only';
    const hasHooks = Boolean(hooks) && hooks !== 'metadata_only';
    let revokeInMetadata = false;
    const requestMetadata = vi.fn(async () => {
      await Promise.resolve();
      if (revokeInMetadata) context.enabled = false;
      return { fixture_note: 'allowed-metadata' };
    });
    let holdHook = false;
    const before = vi.fn(async () => {
      if (hooks === 'before_wait' && holdHook) {
        hookEntered.resolve();
        await releaseHook.promise;
      }
      return hooks === 'before_wait'
        ? {
            action: 'replaceArguments' as const,
            arguments: { tag: 'replacement' },
          }
        : { action: 'allow' as const };
    });
    const approval = vi.fn(async () => {
      if (hooks === 'approval_wait' && holdHook) {
        hookEntered.resolve();
        await releaseHook.promise;
      }
      return true;
    });
    const predicate = vi.fn(
      (
        run: { agent: unknown; context: unknown },
        reference: { name: string; namespace?: string | null },
      ) => {
        expect(run.context).toBe(context);
        expect(reference.name).toContain('lookup');
        expect(reference.namespace).toBeUndefined();
        return context.enabled;
      },
    );
    try {
      await using provider = await providerFor(model);
      const selected = new Agent<typeof context>({
        name: 'Selected',
        instructions: 'Read records.',
        provider,
        tools: [
          new HttpMCP({
            name: 'records',
            url: `http://127.0.0.1:${address.port}/mcp`,
            tools: ['lookup'],
            approvalMode: 'preapproved',
            ...(hasHooks ? { before, approval } : {}),
            ...(checksMetadata ? { requestMetadata } : {}),
          }),
        ],
        realtime: { toolEnabled: predicate },
      });
      const opening =
        source !== 'voice'
          ? selected
          : new Agent<typeof context>({
              name: 'Backend',
              instructions: 'Help.',
              provider,
            });
      await using session = await opening.session({ context });
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const events: Frame[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) events.push(event);
      })().catch(() => {});
      try {
        if (source === 'voice') await voice.updateAgent(selected);
        const advertised = peer.frames
          .filter((frame) => frame.type === 'session.update')
          .at(-1)!;
        const declaration = advertised.session.tools.find((tool: Frame) =>
          tool.name.includes('lookup'),
        );
        expect(declaration).toBeDefined();
        peer.call(declaration.name, {}, 'mcp-allowed');
        expect(await peer.output('mcp-allowed')).toContain('accepted record');
        expect(effects).toHaveLength(1);
        if (hooks === 'before_wait')
          expect(effects[0]).toMatchObject({
            arguments: { tag: 'replacement' },
          });
        expect(before).toHaveBeenCalledTimes(hasHooks ? 1 : 0);
        expect(approval).toHaveBeenCalledTimes(hasHooks ? 1 : 0);
        const advertisedReference = predicate.mock.calls[0]![1];
        if (source === 'retained') {
          await vi.waitFor(() =>
            expect(
              events.some(
                (event) =>
                  event.type === 'response' &&
                  event.status === 'done' &&
                  event.responseId?.startsWith('continuation-'),
              ),
            ).toBe(true),
          );
          peer.send({
            type: 'response.created',
            response: { id: 'before-replacement' },
          });
          await vi.waitFor(() =>
            expect(events).toContainEqual(
              expect.objectContaining({
                type: 'response',
                responseId: 'before-replacement',
                status: 'created',
              }),
            ),
          );
          await session.update({
            tools: [
              new HttpMCP({
                name: 'records',
                url: `http://127.0.0.1:${address.port}/mcp?replacement=1`,
                tools: ['lookup'],
                approvalMode: 'preapproved',
              }),
            ],
          });
        }
        const callsBeforeDenial = predicate.mock.calls.length;
        context.enabled = waitsForHook || checksMetadata;
        revokeInMetadata = checksMetadata;
        holdHook = waitsForHook;
        if (source === 'retained')
          peer.calls(
            [[declaration.name, {}, 'mcp-denied']],
            'before-replacement',
            false,
          );
        else peer.call(declaration.name, {}, 'mcp-denied');
        if (waitsForHook) {
          await hookEntered.promise;
          context.enabled = false;
          releaseHook.resolve();
        }
        await peer.output('mcp-denied');
        expect(effects).toHaveLength(1);
        expect(predicate.mock.calls.length).toBeGreaterThan(callsBeforeDenial);
        expect(predicate.mock.calls.at(-1)![0].agent).toBe(selected);
        expect(predicate.mock.calls.at(-1)![1]).toEqual(advertisedReference);
        expect(before).toHaveBeenCalledTimes(
          hasHooks ? (waitsForHook || checksMetadata ? 2 : 1) : 0,
        );
        expect(approval).toHaveBeenCalledTimes(
          hasHooks ? (waitsForHook || checksMetadata ? 2 : 1) : 0,
        );
        if (checksMetadata) {
          context.enabled = true;
          revokeInMetadata = false;
          peer.call(declaration.name, {}, 'mcp-restored');
          expect(await peer.output('mcp-restored')).toContain(
            'accepted record',
          );
          expect(effects).toHaveLength(2);
          expect(effects[1]).toMatchObject({
            _meta: { fixture_note: 'allowed-metadata' },
          });
          expect(requestMetadata).toHaveBeenCalledTimes(3);
        }
      } finally {
        releaseHook.resolve();
        await voice.close();
        await reading;
      }
      const predicateCalls = predicate.mock.calls.length;
      if (checksMetadata) context.enabled = false;
      if (source !== 'voice') {
        expect(
          (await (await session.submit('backend read')).wait()).finalOutput,
        ).toBe('backend accepted');
        expect(effects).toHaveLength(checksMetadata ? 3 : 2);
        expect(before).toHaveBeenCalledTimes(
          hasHooks ? (checksMetadata ? 4 : waitsForHook ? 3 : 2) : 0,
        );
        expect(approval).toHaveBeenCalledTimes(
          hasHooks ? (checksMetadata ? 4 : waitsForHook ? 3 : 2) : 0,
        );
      }
      expect(predicate).toHaveBeenCalledTimes(predicateCalls);
      expect(await session.getActiveAgent()).toBe(opening);
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
      remote.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        remote.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  30000,
);

nativeIt(
  'rechecks Agent realtime.toolEnabled before a host function executes',
  async () => {
    const execute = vi.fn(() => 'record');
    const context = { enabled: true };
    const predicate = vi.fn(() => context.enabled);
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Read records.',
        provider,
        tools: [tool({ name: 'lookup', parameters: z.object({}), execute })],
        realtime: { toolEnabled: predicate },
      }).session({ context });
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        context.enabled = false;
        const advertisedCalls = predicate.mock.calls.length;
        peer.call('lookup', {}, 'host-denied');
        await peer.output('host-denied');
        expect(predicate.mock.calls.length).toBeGreaterThan(advertisedCalls);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['dispatch', 'post-hook'] as const)(
  'rechecks Agent tool permission after a pending connection grant at %s',
  async (stage) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    let enabled = true;
    let beforeRan = false;
    const execute = vi.fn(() => 'record');
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Read records.',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute,
            before:
              stage === 'post-hook'
                ? () => {
                    beforeRan = true;
                    return { action: 'allow' };
                  }
                : undefined,
          }),
        ],
        realtime: { toolEnabled: () => enabled },
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        isToolEnabled: () => {
          if (!hold || (stage === 'post-hook' && !beforeRan)) return true;
          entered.resolve();
          return release.promise.then(() => true);
        },
      });
      try {
        hold = true;
        peer.call('lookup', {}, 'agent-revoked');
        await entered.promise;
        enabled = false;
        release.resolve();
        expect(await peer.output('agent-revoked')).toContain('not found');
        expect(execute).not.toHaveBeenCalled();

        hold = false;
        enabled = true;
        peer.call('lookup', {}, 'agent-reenabled');
        expect(await peer.output('agent-reenabled')).toContain('record');
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      release.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['agent', 'session', 'handoff'] as const)(
  'rechecks native Realtime %s authority after suspended function input policy',
  async (policy) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let enabled = true;
    let hold = false;
    const execute = vi.fn(() => 'record');
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    const before = async () => {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      return { action: 'allow' as const };
    };
    try {
      await using provider = await providerFor(model);
      const target = new Agent({
        name: 'Target',
        instructions: 'Help.',
        provider,
      });
      const opening = new Agent({
        name: 'Opening',
        instructions: 'Read records.',
        provider,
        ...(policy === 'handoff'
          ? {
              handoffs: [
                realtimeHandoff(target, {
                  name: 'lookup',
                  isEnabled: async () => {
                    await before();
                    return true;
                  },
                  onHandoff: execute,
                }),
              ],
            }
          : {
              tools: [
                tool({
                  name: 'lookup',
                  parameters: z.object({}),
                  before,
                  execute,
                }),
              ],
            }),
        realtime: { toolEnabled: () => policy === 'session' || enabled },
      });
      await using session = await opening.session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        isToolEnabled: () => policy !== 'session' || enabled,
      });
      try {
        hold = true;
        peer.call('lookup', {}, 'hook-revoked');
        await entered.promise;
        enabled = false;
        release.resolve();
        expect(await peer.output('hook-revoked')).toContain('not found');
        expect(execute).not.toHaveBeenCalled();
        expect(await session.getActiveAgent()).toBe(opening);
      } finally {
        release.resolve();
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      release.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['agent', 'session'] as const)(
  'rechecks handoff enablement after the final awaited %s predicate',
  async (policy) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let dispatch = false;
    let checkedHandoff = false;
    let enabled = true;
    const onHandoff = vi.fn();
    const finalPredicate = async () => {
      if (dispatch && checkedHandoff) {
        entered.resolve();
        await release.promise;
      }
      return true;
    };
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      const target = new Agent({
        name: 'Target',
        instructions: 'Help.',
        provider,
      });
      const opening = new Agent({
        name: 'Opening',
        instructions: 'Help.',
        provider,
        handoffs: [
          realtimeHandoff(target, {
            name: 'transfer',
            isEnabled: () => {
              if (dispatch) checkedHandoff = true;
              return enabled;
            },
            onHandoff,
          }),
        ],
        realtime: {
          toolEnabled: policy === 'agent' ? finalPredicate : () => true,
        },
      });
      await using session = await opening.session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        ...(policy === 'session' ? { isToolEnabled: finalPredicate } : {}),
      });
      try {
        dispatch = true;
        peer.call('transfer', {}, 'handoff-revoked');
        await entered.promise;
        enabled = false;
        release.resolve();
        expect(await peer.output('handoff-revoked')).toContain('not found');
        expect(onHandoff).not.toHaveBeenCalled();
        expect(await session.getActiveAgent()).toBe(opening);
      } finally {
        release.resolve();
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      release.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([
  ['agent', 'promise', false],
  ['session', 'promise', false],
  ['agent', 'thenable', false],
  ['session', 'thenable', false],
  ['agent', 'thenable', true],
] as const)(
  'rechecks %s authority after final %s handoff enablement (allowed=%s)',
  async (policy, resultKind, allowed) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let dispatch = false;
    let handoffChecks = 0;
    let enabled = true;
    const onHandoff = vi.fn();
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      const target = new Agent({
        name: 'Target',
        instructions: 'Help.',
        provider,
      });
      const opening = new Agent({
        name: 'Opening',
        instructions: 'Help.',
        provider,
        handoffs: [
          realtimeHandoff(target, {
            name: 'transfer',
            isEnabled: () => {
              if (!dispatch || ++handoffChecks !== 2) return true;
              entered.resolve();
              const result = release.promise.then(() => true);
              return resultKind === 'promise'
                ? result
                : ({
                    then(resolve: (value: boolean) => void) {
                      void result.then(resolve);
                    },
                  } as Promise<boolean>);
            },
            onHandoff,
          }),
        ],
        realtime: { toolEnabled: () => policy !== 'agent' || enabled },
      });
      await using session = await opening.session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        isToolEnabled: () => policy !== 'session' || enabled,
      });
      try {
        dispatch = true;
        peer.call('transfer', {}, 'async-handoff');
        await entered.promise;
        enabled = allowed;
        release.resolve();
        expect(await peer.output('async-handoff')).toContain(
          allowed ? 'Handoff reserved.' : 'not found',
        );
        expect(onHandoff).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(handoffChecks).toBe(2);
        if (!allowed) expect(await session.getActiveAgent()).toBe(opening);
      } finally {
        release.resolve();
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      release.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['deny', 'replaceArguments'] as const)(
  'runs native Realtime function input policy %s before execution',
  async (action) => {
    const execute = vi.fn(({ value }: { value: string }) => value);
    const before = vi.fn(() =>
      action === 'deny'
        ? { action: 'deny' as const, reason: 'Unavailable' }
        : {
            action: 'replaceArguments' as const,
            arguments: { value: 'approved' },
          },
    );
    const selected = tool({
      name: 'checked',
      parameters: z.object({ value: z.string() }),
      before,
      execute,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help.',
        model: 'gpt-5.5',
        provider,
        tools: [selected],
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        peer.call('checked', { value: 'original' }, 'checked-call');
        const output = await peer.output('checked-call');
        expect(before).toHaveBeenCalledOnce();
        if (action === 'deny') {
          expect(execute).not.toHaveBeenCalled();
          expect(output).toContain('Unavailable');
        } else {
          expect(execute).toHaveBeenCalledOnce();
          expect(execute.mock.calls[0][0]).toEqual({ value: 'approved' });
          expect(output).toContain('approved');
        }
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

for (const phase of ['before', 'execute'] as const) {
  nativeIt.each(['interrupt', 'close'] as const)(
    'joins the last Realtime ' +
      phase +
      ' callback cleanup beyond 100ms during %s',
    async (operation) => {
      const entered = Promise.withResolvers<void>();
      const cleaning = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleaned = vi.fn();
      const held = async (signal: AbortSignal): Promise<void> => {
        entered.resolve();
        try {
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        } finally {
          cleaning.resolve();
          await release.promise;
          cleaned();
        }
      };
      const execute = vi.fn(
        async (_args: unknown, { signal }: { signal: AbortSignal }) => {
          if (phase === 'execute') await held(signal);
          return 'LATE_CALLBACK_MARKER';
        },
      );
      const selected = tool({
        name: 'held',
        parameters: z.object({}),
        execute,
        ...(phase === 'before'
          ? {
              before: async ({ signal }: { signal: AbortSignal }) => {
                await held(signal);
                return { action: 'allow' as const };
              },
            }
          : {}),
      });
      const model = new ModelServer([[message('Caller remains open.')]]);
      const peer = new PolicyPeer(model);
      try {
        await using provider = await providerFor(model);
        await using session = await new Agent({
          instructions: 'Help.',
          model: 'gpt-5.5',
          provider,
          tools: [selected],
        }).session();
        const voice = await session.realtime({ model: 'fixture-realtime' });
        try {
          const responseId = peer.call('held', {}, 'held-call');
          await entered.promise;
          let settled = false;
          const stopping = (
            operation === 'close' ? voice.close() : voice.interrupt(responseId)
          ).finally(() => {
            settled = true;
          });
          void stopping.catch(() => {});
          await cleaning.promise;
          await delay(200);
          expect(settled).toBe(false);
          expect(cleaned).not.toHaveBeenCalled();
          release.resolve();
          await stopping;
          expect(cleaned).toHaveBeenCalledOnce();
          if (phase === 'before') expect(execute).not.toHaveBeenCalled();
          expect(
            (await (await session.submit('continue')).wait()).finalOutput,
          ).toBe('Caller remains open.');
        } finally {
          release.resolve();
          await voice.close();
        }
        await peer.disconnected.promise;
        expect(
          peer.frames.filter(
            (frame) =>
              frame.type === 'conversation.item.create' &&
              frame.item?.type === 'function_call_output' &&
              frame.item.call_id === 'held-call',
          ),
        ).toEqual([]);
        model.assertExhausted();
      } finally {
        release.resolve();
        await peer.close();
        await ModelServer.closeAll();
      }
    },
    30000,
  );
}

nativeIt.each([
  { background: false, maxFunctionConcurrency: undefined },
  { background: true, maxFunctionConcurrency: undefined },
  { background: false, maxFunctionConcurrency: 1 },
  { background: true, maxFunctionConcurrency: 1 },
])(
  'runs overlapping public response tools on one native root and preserves background=$background with maxFunctionConcurrency=$maxFunctionConcurrency',
  async ({ background, maxFunctionConcurrency }) => {
    const enteredA = vi.fn();
    const enteredB = vi.fn();
    const stoppedA = vi.fn();
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    let signalB: AbortSignal | undefined;
    const a = tool({
      name: 'wait_a',
      parameters: z.object({}),
      execute: async (_args, { signal }) => {
        enteredA();
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
            void releaseA.promise.then(resolve);
          });
        } finally {
          stoppedA();
        }
        return 'FORBIDDEN_A_LATE_OUTPUT';
      },
    });
    const b = tool({
      name: 'wait_b',
      parameters: z.object({}),
      execute: async (_args, { signal }) => {
        signalB = signal;
        enteredB();
        await releaseB.promise;
        return background ? backgroundResult('B accepted') : 'B accepted';
      },
    });
    const model = new ModelServer([[message('Caller remains open.')]]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use the declared tools.',
        model: 'gpt-5.5',
        provider,
        tools: [a, b],
      }).session({ maxFunctionConcurrency });
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const observations = session.events();
      const roots = new Set<string>();
      const rootDone = (async () => {
        for await (const event of observations) {
          if (event.type === 'turn_started') roots.add(event.turnId!);
          if (event.type === 'turn_finished') return;
        }
      })();
      void rootDone.catch(() => {});
      try {
        const responseA = peer.call('wait_a', {}, 'overlap-a');
        await vi.waitFor(() => expect(enteredA).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        peer.call('wait_b', {}, 'overlap-b');
        if (maxFunctionConcurrency === undefined) {
          // Without a limit, B enters while A has not returned.
          await vi.waitFor(() => expect(enteredB).toHaveBeenCalledOnce(), {
            timeout: 10000,
          });
        } else {
          // The ACK fences provider frames for B while A holds the only permit.
          await voice.update({ instructions: 'Use the declared tools.' });
          expect(enteredB).not.toHaveBeenCalled();
        }
        expect(stoppedA).not.toHaveBeenCalled();
        await voice.interrupt(responseA);
        await vi.waitFor(() => expect(stoppedA).toHaveBeenCalledOnce());
        // Retiring A must release its permit without poisoning B's shared root.
        await vi.waitFor(() => expect(enteredB).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        expect(signalB!.aborted).toBe(false);
        const followups = peer.frames.filter(
          (frame) => frame.type === 'response.create',
        ).length;
        releaseB.resolve();
        expect(await peer.output('overlap-b')).toContain('B accepted');
        await rootDone;
        // A settings ACK fences the local provider writer after batch completion.
        await voice.update({ instructions: 'Completed native tools.' });
        expect(roots.size).toBe(1);
        expect(
          peer.frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(followups + (background ? 0 : 1));
        expect(model.requests).toHaveLength(0);
      } finally {
        releaseA.resolve();
        releaseB.resolve();
        await observations.return?.();
        await voice.close();
      }
      await peer.disconnected.promise;
      expect(
        peer.frames.filter(
          (frame) =>
            frame.type === 'conversation.item.create' &&
            frame.item?.type === 'function_call_output' &&
            frame.item.call_id === 'overlap-a',
        ),
      ).toEqual([]);
      expect(
        (await (await session.submit('continue')).wait()).finalOutput,
      ).toBe('Caller remains open.');
      model.assertExhausted();
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'resolves native voice policies for each active profile and filters functions and handoffs',
  async () => {
    const context = { marker: 'policy-owner' };
    const seen: string[] = [];
    const hidden = tool({
      name: 'hidden',
      parameters: z.object({}),
      execute: () => 'forbidden',
    });
    const visible = tool({
      name: 'visible',
      parameters: z.object({}),
      execute: () => 'accepted',
    });
    const target = new Agent({
      name: 'B',
      instructions: 'B',
      tools: [visible, hidden],
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        name: 'A',
        instructions: 'A',
        tools: [visible, hidden],
        handoffs: [target],
        provider,
      }).session({ context });
      const voice = await session.realtime({
        model: 'fixture-realtime',
        instructions: async (run) => {
          expect(run.context).toBe(context);
          return `Voice for ${run.agent.name}`;
        },
        isToolEnabled: async (run, declaration) => {
          expect(run.context).toBe(context);
          seen.push(
            `${run.agent.name}:${declaration.type}:${declaration.name}`,
          );
          return declaration.name === 'visible';
        },
      });
      try {
        const initial = peer.frames.find(
          (frame) => frame.type === 'session.update',
        )!;
        expect(initial.session.instructions).toContain('Voice for A');
        expect(
          initial.session.tools
            .filter((entry: Frame) =>
              ['visible', 'hidden', 'transfer_to_b'].includes(entry.name),
            )
            .map((entry: Frame) => entry.name),
        ).toEqual(['visible']);
        expect(seen).toContain('A:handoff:transfer_to_b');
        const start = peer.frames.length;
        await session.update({ agent: target });
        const updated = peer.frames
          .slice(start)
          .find((frame) => frame.type === 'session.update')!;
        expect(updated.session.instructions).toContain('Voice for B');
        expect(
          updated.session.tools
            .filter((entry: Frame) =>
              ['visible', 'hidden', 'transfer_to_b'].includes(entry.name),
            )
            .map((entry: Frame) => entry.name),
        ).toEqual(['visible']);
        peer.call('visible', {}, 'profile-call');
        expect(await peer.output('profile-call')).toBe('accepted');
        expect(seen).toContain('B:function:visible');
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'recovers native response batches after rejected unknown calls (mixed=%s)',
  async (mixed) => {
    const execute = vi.fn(() => 'accepted');
    const selected = tool({ name: 'known', parameters: z.object({}), execute });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use known.',
        tools: [selected],
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        peer.calls(
          [
            ['unknown', {}, 'rejected-call'],
            ...(mixed
              ? [['known', {}, 'mixed-call'] as [string, Frame, string]]
              : []),
          ],
          'rejected-response',
        );
        if (mixed) {
          expect(await peer.output('mixed-call')).toBe('accepted');
          await vi.waitFor(() =>
            expect(
              peer.frames.filter((frame) => frame.type === 'response.create'),
            ).toHaveLength(1),
          );
        }
        await voice.update({ instructions: 'Still listening.' });
        expect(
          peer.frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(mixed ? 1 : 0);
        peer.call('known', {}, 'recovery-call');
        expect(await peer.output('recovery-call')).toBe('accepted');
        await vi.waitFor(() =>
          expect(
            peer.frames.filter((frame) => frame.type === 'response.create'),
          ).toHaveLength(mixed ? 2 : 1),
        );
        expect(execute).toHaveBeenCalledTimes(mixed ? 2 : 1);
        const rejected = peer.frames.filter(
          (frame) =>
            frame.item?.type === 'function_call_output' &&
            frame.item.call_id === 'rejected-call',
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0].item.output).toBe('Tool unknown not found');
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'finishes unavailable native tool observations (approval=%s)',
  async (needsApproval) => {
    let enabled = true;
    const execute = vi.fn(() => 'forbidden');
    const selected = tool({
      name: 'revoked',
      parameters: z.object({}),
      needsApproval,
      execute,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use revoked.',
        tools: [selected],
        provider,
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        isToolEnabled: () => enabled,
      });
      const observations = session.events();
      const seen: { type: string; callId?: string; status?: string }[] = [];
      const completed = (async () => {
        for await (const event of observations) {
          seen.push(event);
          if (event.type === 'turn_finished') return;
        }
      })();
      void completed.catch(() => {});
      try {
        enabled = false;
        peer.call('revoked', {}, 'revoked-call');
        expect(await peer.output('revoked-call')).toBe(
          'Tool revoked not found',
        );
        await completed;
        expect(
          seen
            .filter(
              (event) =>
                event.type === 'tool_started' || event.type === 'tool_finished',
            )
            .map(({ type, status }) => ({ type, status })),
        ).toEqual([
          { type: 'tool_started', status: undefined },
          { type: 'tool_finished', status: 'failed' },
        ]);
        expect(execute).not.toHaveBeenCalled();
        expect(await session.pendingInteractions()).toEqual([]);
      } finally {
        await voice.close();
        await observations.return?.();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([
  { explicit: false, remembered: false },
  { explicit: true, remembered: false },
  { explicit: false, remembered: true },
  { explicit: true, remembered: true },
])(
  'formats only implicit native approval rejection (explicit=$explicit, remembered=$remembered)',
  async ({ explicit, remembered }) => {
    let denyInput = false;
    const execute = vi.fn(() => 'forbidden');
    const formatter = vi.fn(async () => 'Application declined');
    const selected = tool({
      name: 'risky',
      parameters: z.object({}),
      needsApproval: true,
      runBeforeApproval: true,
      before: () =>
        denyInput
          ? { action: 'deny' as const, reason: 'Input denied' }
          : { action: 'allow' as const },
      execute,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use risky.',
        tools: [selected],
        provider,
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        toolErrorFormatter: formatter,
      });
      const reader = session.interactions();
      try {
        peer.call('risky', {}, 'approval-call');
        const { value: request } = await reader.next();
        if (!isFunctionApprovalRequest(request))
          throw new Error('Native approval missing');
        await session.respond(
          request.reject(explicit ? 'Explicit denial' : undefined, {
            always: remembered,
          }),
        );
        expect(await peer.output('approval-call')).toBe(
          explicit ? 'Explicit denial' : 'Application declined',
        );
        expect(formatter).toHaveBeenCalledTimes(explicit ? 0 : 1);
        if (remembered) {
          peer.call('risky', {}, 'remembered-call');
          expect(await peer.output('remembered-call')).toBe(
            explicit ? 'Explicit denial' : 'Application declined',
          );
          expect(formatter).toHaveBeenCalledTimes(explicit ? 0 : 2);
          denyInput = true;
          peer.call('risky', {}, 'policy-denied-call');
          expect(await peer.output('policy-denied-call')).toBe('Input denied');
          expect(formatter).toHaveBeenCalledTimes(explicit ? 0 : 2);
        }
        expect(execute).not.toHaveBeenCalled();
        expect(await session.pendingInteractions()).toEqual([]);
        expect(model.requests).toHaveLength(0);
      } finally {
        await reader.return?.();
        await voice.close();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['invalid', 'null', 'exception'] as const)(
  'validates native approval formatter returns and joins cleanup (%s)',
  async (outcome) => {
    const execute = vi.fn(() => 'forbidden');
    const formatter = vi.fn(async () => {
      if (outcome === 'exception')
        throw new Error('Application formatter failure');
      return outcome === 'null' ? null : 42;
    });
    const selected = tool({
      name: 'risky',
      parameters: z.object({}),
      needsApproval: true,
      execute,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use risky.',
        tools: [selected],
        provider,
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        // Exercise an unchecked application return through the public runtime boundary.
        toolErrorFormatter: formatter as never,
      });
      const reader = session.interactions();
      try {
        peer.call('risky', {}, 'formatter-return');
        const { value: request } = await reader.next();
        if (!isFunctionApprovalRequest(request))
          throw new Error('Native approval missing');
        if (outcome === 'invalid') {
          await expect(session.respond(request.reject())).rejects.toThrow(
            'formatter must return a string, null or undefined',
          );
          await voice.close();
          await peer.disconnected.promise;
          expect(await session.pendingInteractions()).toEqual([]);
          expect(
            peer.frames
              .filter(
                (frame) =>
                  frame.item?.type === 'function_call_output' &&
                  frame.item.call_id === 'formatter-return',
              )
              .map((frame) => frame.item.output),
          ).toEqual(['The function failed.']);
          expect(formatter).toHaveBeenCalledTimes(1);
          expect(execute).not.toHaveBeenCalled();
          expect(model.requests).toHaveLength(0);
          return;
        } else {
          await session.respond(request.reject());
        }
        expect(await peer.output('formatter-return')).toBe(
          'Tool execution was rejected',
        );
        expect(formatter).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        expect(await session.pendingInteractions()).toEqual([]);
        expect(model.requests).toHaveLength(0);
      } finally {
        await reader.return?.();
        await voice.close();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'discards a late native availability allowance after voice close',
  async () => {
    const entered = Promise.withResolvers<void>();
    const execute = vi.fn(() => 'forbidden');
    let checks = 0;
    const selected = tool({ name: 'known', parameters: z.object({}), execute });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use known.',
        tools: [selected],
        provider,
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        isToolEnabled: async ({ signal }) => {
          if (++checks > 1) {
            entered.resolve();
            await new Promise<void>((resolve) => {
              if (signal!.aborted) resolve();
              else
                signal!.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
          }
          return true;
        },
      });
      try {
        peer.call('known', {}, 'retired-call');
        await entered.promise;
        await voice.close();
        expect(execute).not.toHaveBeenCalled();
        expect(
          peer.frames.some((frame) => frame.item?.call_id === 'retired-call'),
        ).toBe(false);
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'rejects a stale explicit voice capture after an equal-schema public update',
  async () => {
    const originalEffect = vi.fn(() => 'original');
    const replacementEffect = vi.fn(() => 'replacement');
    const original = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: originalEffect,
    });
    const replacement = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: replacementEffect,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help.',
        model: 'gpt-5.5',
        provider,
        tools: [original],
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        tools: [original],
        isToolEnabled: () => true,
      });
      const captured = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const nativeSession = session as unknown as NativeSession<
        string,
        unknown
      >;
      const select = nativeSession._realtimeFunctionTools.bind(nativeSession);
      const selection = vi.spyOn(nativeSession, '_realtimeFunctionTools');
      selection.mockImplementationOnce(async (...args) => {
        const first = await select(...args);
        captured.resolve();
        await resume.promise;
        return first;
      });
      try {
        const updates = () =>
          peer.frames.filter((frame) => frame.type === 'session.update').length;
        const initialUpdates = updates();
        const refreshing = session
          .update({ instructions: 'Refresh the voice.' })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await captured.promise;
        const beforeReplacement = (session as unknown as { catalog: object })
          .catalog;
        const replacing = session.update({ tools: [replacement] }).then(
          () => undefined,
          (error: unknown) => error,
        );
        await vi.waitFor(() =>
          expect((session as unknown as { catalog: object }).catalog).not.toBe(
            beforeReplacement,
          ),
        );
        // Accepted replacement before the stale voice publication.
        expect(updates()).toBe(initialUpdates);
        resume.resolve();
        const error = await refreshing;
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/another captured catalog\/profile/);
        await replacing;
        expect(updates()).toBe(initialUpdates);
        expect(originalEffect).not.toHaveBeenCalled();
        expect(replacementEffect).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        selection.mockRestore();
        await voice.close();
      }
    } finally {
      await ModelServer.closeAll();
    }
  },
);

nativeIt.each([false, true])(
  'continues native Realtime after original-input recovery (approval=%s)',
  async (managed) => {
    const execute = vi.fn(() => 'unexpected');
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const after = vi.fn((output) => output);
    const approve = vi.fn(() => true);
    const recover = vi.fn((_context, _error, original) => {
      expect(original).toEqual({ value: 7 });
      return 'Invalid checked input';
    });
    const selected = tool({
      name: 'checked',
      parameters: z.object({ value: z.string() }),
      needsApproval: managed ? approve : false,
      inputErrorFunction: recover,
      before,
      after,
      execute,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help.',
        model: 'gpt-5.5',
        provider,
        tools: [selected],
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        const initial = peer.frames.filter(
          (frame) => frame.type === 'response.create',
        ).length;
        peer.call('checked', { value: 7 }, 'invalid-original');
        expect(await peer.output('invalid-original')).toBe(
          'Invalid checked input',
        );
        await vi.waitFor(
          () =>
            expect(
              peer.frames.filter((frame) => frame.type === 'response.create'),
            ).toHaveLength(initial + 1),
          { timeout: 1000 },
        );
        await voice.update({ instructions: 'Help.' });
        expect(
          peer.frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(initial + 1);
        expect(
          peer.frames.filter(
            (frame) =>
              frame.type === 'conversation.item.create' &&
              frame.item?.call_id === 'invalid-original',
          ),
        ).toHaveLength(1);
        expect(recover).toHaveBeenCalledOnce();
        expect(approve).not.toHaveBeenCalled();
        expect(before).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);
