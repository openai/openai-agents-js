import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailTripwire,
  Environment,
  NativeAgents,
  HttpMCP,
  NativeProvider,
  ToolOutput,
  type Turn,
  manualTool,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { nativeCheckpoint } from '../../src/runtime/state';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-app-data',
    supportsWebsockets: false,
  });
}

async function startApplicationDataPeer() {
  const failures: unknown[] = [];
  const peer = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'app-peer', version: '1' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'lookup',
                    inputSchema: {
                      type: 'object',
                      properties: { query: { type: 'string' } },
                      required: ['query'],
                    },
                  },
                ],
              }
            : rpc.method === 'tools/call'
              ? {
                  content: [{ type: 'text', text: 'peer-public' }],
                  _meta: { ticket: 'peer-meta' },
                  structuredContent: { count: 7 },
                  isError: false,
                }
              : {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  return { peer, failures, url: `http://127.0.0.1:${address.port}/mcp` };
}

async function waitForManualRequests(turn: Turn, callIds: readonly string[]) {
  await vi.waitFor(async () => {
    const pending = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in pending)) throw new Error('Expected manual requests');
    expect(new Set(pending.requests.map((request) => request.callId))).toEqual(
      new Set(callIds),
    );
  });
}

nativeIt.each([false, true])(
  'retains live terminal application data only with the canonical output, reject=%s',
  async (reject) => {
    const model = new ModelServer([
      [call('finish', {}, { callId: 'terminal-data' })],
    ]);
    await using provider = await providerFor(model);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using session = await new Agent({
      instructions: 'Finish with the supplied tool.',
      provider,
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: () =>
            new ToolOutput([{ type: 'inputText', text: 'done' }], true, {
              ticket: 'private-terminal',
            }),
        }),
      ],
      outputGuardrails: [
        {
          name: 'hold-live-terminal',
          async callback() {
            entered.resolve();
            await release.promise;
            return { tripwireTriggered: reject };
          },
        },
      ],
    }).session();
    const turn = await session.submit('Finish');
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(turn.applicationToolOutputs).toEqual([]);
    } finally {
      release.resolve();
    }
    if (reject) {
      await expect(turn.wait()).rejects.toBeInstanceOf(GuardrailTripwire);
      expect(turn.applicationToolOutputs).toEqual([]);
      expect(JSON.stringify(await session.saveState())).not.toContain(
        'private-terminal',
      );
      return;
    }
    const result = await turn.wait();
    expect(result.finalOutput).toBe('done');
    expect(result.applicationToolOutputs).toEqual([
      expect.objectContaining({
        callId: 'terminal-data',
        applicationData: { ticket: 'private-terminal' },
      }),
    ]);
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(await session.saveState())).toContain(
      'private-terminal',
    );
  },
);

nativeIt.each(['original', 'transformed', 'malformed'] as const)(
  'extracts MCP application data after %s result with validated delivery',
  async (mode) => {
    const { peer, failures, url } = await startApplicationDataPeer();
    let extracts = 0;
    const model = new ModelServer([
      [
        call(
          'lookup',
          { query: 'input' },
          { namespace: 'mcp__application', callId: 'mcp-app-data' },
        ),
      ],
      (request) => {
        expect(JSON.stringify(request)).not.toContain(
          'private-mcp-application',
        );
        const output = (
          request.input as { type: string; output?: unknown }[]
        ).find((item) => item.type === 'function_call_output');
        expect(JSON.stringify(output?.output)).toContain(
          mode === 'transformed' ? '8' : '7',
        );
        return [message('done')];
      },
    ]);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use lookup.',
        provider,
        tools: [
          new HttpMCP({
            name: 'application',
            url,
            tools: ['lookup'],
            approvalMode: 'preapproved',
            ...(mode === 'original'
              ? {}
              : {
                  transformResult: async (_context, result) =>
                    mode === 'malformed'
                      ? { ...result, content: 'invalid' }
                      : {
                          ...result,
                          content: [{ type: 'text', text: 'edited-public' }],
                          structuredContent: { count: 8 },
                        },
                }),
            async extractApplicationData(context, result) {
              extracts++;
              expect(context.arguments).toEqual({ query: 'input' });
              expect(context.toolDisplayName).toBe('lookup');
              expect(result.structuredContent).toEqual({
                count: mode === 'transformed' ? 8 : 7,
              });
              expect(result._meta).toEqual({ ticket: 'peer-meta' });
              return { ticket: 'private-mcp-application' };
            },
          }),
        ],
      }).session();
      const turn = await session.submit('Look up');
      if (mode === 'malformed') {
        await expect(turn.wait()).rejects.toThrow('MCP result policy failed');
        expect(turn.applicationToolOutputs).toEqual([]);
      } else {
        const result = await turn.wait();
        expect(result.applicationToolOutputs).toHaveLength(1);
        expect(result.applicationToolOutputs![0]).toMatchObject({
          callId: 'mcp-app-data',
          applicationData: { ticket: 'private-mcp-application' },
        });
        expect(
          JSON.stringify((await session.historySnapshot()).items),
        ).not.toContain('private-mcp-application');
        expect(JSON.stringify(await session.saveState())).toContain(
          'private-mcp-application',
        );
      }
      expect(extracts).toBe(1);
      expect(failures).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  },
  30000,
);

nativeIt(
  'retains generated-code function application data after native acceptance',
  async () => {
    let effects = 0;
    const model = new ModelServer([
      [
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'application-cell',
          input: 'text(await tools.record({}));',
        },
      ],
      (request) => {
        expect(JSON.stringify(request)).not.toContain(
          'private-nested-application',
        );
        expect(JSON.stringify(request)).toContain('nested-public');
        return [message('done')];
      },
    ]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Call record from code once.',
      provider,
      programmaticToolCalling: true,
      tools: [
        tool({
          name: 'record',
          parameters: z.object({}),
          execute: (_args, context) => {
            expect(context.call?.route).toBe('code');
            effects++;
            return new ToolOutput(
              [{ type: 'inputText', text: 'nested-public' }],
              true,
              { ticket: 'private-nested-application' },
            );
          },
        }),
      ],
    }).session();
    const turn = await session.submit('Run the code.');
    const result = await turn.wait();
    expect(result.finalOutput).toBe('done');
    expect(result.applicationToolOutputs).toEqual([
      expect.objectContaining({
        name: 'record',
        applicationData: { ticket: 'private-nested-application' },
      }),
    ]);
    expect(
      JSON.stringify((await session.historySnapshot()).items),
    ).not.toContain('private-nested-application');
    expect(JSON.stringify(await session.saveState())).toContain(
      'private-nested-application',
    );
    expect(effects).toBe(1);
  },
  30000,
);

nativeIt(
  'retains one validated manual application result and rejects its duplicate',
  async () => {
    const model = new ModelServer([
      [call('record', {}, { callId: 'manual-data' })],
      (request) => {
        expect(JSON.stringify(request)).toContain('public manual');
        expect(JSON.stringify(request)).not.toContain('private-manual');
        return [message('manual done')];
      },
    ]);
    await using provider = await providerFor(model);
    const declaration = manualTool({
      name: 'record',
      description: 'Record a public result',
      parameters: z.object({}),
      result: z.string().transform(
        (text) =>
          new ToolOutput([{ type: 'inputText', text }], true, {
            ticket: 'private-manual',
          }),
      ),
    });
    await using session = await new Agent({
      instructions: 'Use the supplied tool.',
      provider,
      tools: [declaration],
    }).session();
    const turn = await session.submit('Record');
    let handled = false;
    for await (const event of session.events()) {
      const request = declaration.match(event);
      if (!request) continue;
      const reply = request.reply('public manual');
      await session.respond(reply);
      await expect(session.respond(reply)).rejects.toThrow();
      handled = true;
      break;
    }
    expect(handled).toBe(true);
    expect((await turn.wait()).applicationToolOutputs).toEqual([
      expect.objectContaining({
        callId: 'manual-data',
        applicationData: { ticket: 'private-manual' },
      }),
    ]);
    expect(
      JSON.stringify((await session.historySnapshot()).items),
    ).not.toContain('private-manual');
    expect(JSON.stringify(await session.saveState())).toContain(
      'private-manual',
    );
    model.assertExhausted();
  },
);

nativeIt(
  'preserves accepted application data in completion after a manual checkpoint restore',
  async () => {
    const model = new ModelServer([
      [call('record', {}, { callId: 'before-pause' })],
      [call('pause', {}, { callId: 'manual-pause' })],
      [message('resumed')],
    ]);
    await using provider = await providerFor(model);
    const pause = manualTool({
      name: 'pause',
      description: 'Pause for approval',
      parameters: z.object({}),
      result: z.string(),
    });
    const agent = new Agent({
      instructions: 'Use the supplied tools.',
      provider,
      tools: [
        tool({
          name: 'record',
          parameters: z.object({}),
          execute: () =>
            new ToolOutput([{ type: 'inputText', text: 'recorded' }], true, {
              ticket: 'accepted-before-suspension',
            }),
        }),
        pause,
      ],
    });
    let state;
    {
      await using source = await agent.session();
      const turn = await source.submit('Record, then pause');
      for await (const event of source.events()) {
        if (!pause.match(event)) continue;
        expect(turn.applicationToolOutputs).toHaveLength(1);
        state = await source.suspend();
        break;
      }
    }
    expect(state).toBeDefined();
    await using restored = await agent.session({ state: state! });
    for await (const event of restored.events()) {
      const request = pause.match(event);
      if (!request) continue;
      await restored.respond(request.reply('continue'));
      break;
    }
    const result = await restored.wait();
    expect(result.finalOutput).toBe('resumed');
    expect(result.applicationToolOutputs).toEqual([
      expect.objectContaining({
        callId: 'before-pause',
        applicationData: { ticket: 'accepted-before-suspension' },
      }),
    ]);
    expect(JSON.stringify(await restored.saveState())).toContain(
      'accepted-before-suspension',
    );
    expect(JSON.stringify(model.requests)).not.toContain(
      'accepted-before-suspension',
    );
    model.assertExhausted();
  },
);

nativeIt.each([false, true])(
  'exposes accepted child application data, MCP extraction precedes ordered child start=%s',
  async (earlyMcpResult) => {
    let roots = 0,
      children = 0;
    const respond = (request: JsonObject) => {
      const meta = request.client_metadata as Record<string, string>;
      const { agent_name } = JSON.parse(meta['x-codex-turn-metadata']);
      if (agent_name === '/root') {
        if (++roots === 1)
          return [
            call(
              'spawn_agent',
              { task_name: 'worker', message: 'Use record.' },
              { namespace: 'collaboration', callId: 'spawn-data-child' },
            ),
          ];
        if (roots === 2) return [call('pause', {}, { callId: 'parent-pause' })];
        return [message('root done')];
      }
      return ++children === 1
        ? [
            earlyMcpResult
              ? call(
                  'lookup',
                  { query: 'input' },
                  {
                    namespace: 'mcp__application',
                    callId: 'child-data',
                  },
                )
              : call('record', {}, { callId: 'child-data' }),
          ]
        : [message('child done')];
    };
    const model = new ModelServer(Array.from({ length: 5 }, () => respond));
    const pause = manualTool({
      name: 'pause',
      description: 'Pause',
      parameters: z.object({}),
      result: z.string(),
    });
    const executor = await startPublicExecutor();
    const mcp = earlyMcpResult ? await startApplicationDataPeer() : undefined;
    const releaseStart = Promise.withResolvers<void>();
    let childStartHeld = false;
    let childOutputAssigned = false;
    const prototype = (await binding()).NativeThread.prototype;
    const nextBatch = prototype._next_session_events;
    const assignMcpResult =
      prototype._resolve_native_mcp_result_with_assignment;
    const readSpy = mcp
      ? vi
          .spyOn(prototype, '_next_session_events')
          .mockImplementation(async function (this: NativeThread) {
            const batch = await nextBatch.call(this);
            if (
              batch.some((raw) => {
                const event = JSON.parse(raw);
                return (
                  event.subagent_id &&
                  ['task_started', 'turn_started'].includes(event.msg.type)
                );
              })
            ) {
              childStartHeld = true;
              await releaseStart.promise;
            }
            return batch;
          })
      : undefined;
    const assignSpy = mcp
      ? vi
          .spyOn(prototype, '_resolve_native_mcp_result_with_assignment')
          .mockImplementation(async function (this: NativeThread, ...args) {
            const assignment = await assignMcpResult.call(this, ...args);
            if (args[2] === 'child-data' && assignment[1])
              childOutputAssigned = true;
            return assignment;
          })
      : undefined;
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Delegate then pause.',
        model: 'gpt-5.5',
        provider,
        tools: [
          new NativeAgents(),
          pause,
          mcp
            ? new HttpMCP({
                name: 'application',
                url: mcp.url,
                tools: ['lookup'],
                approvalMode: 'preapproved',
                extractApplicationData: () => ({
                  ticket: 'private-child-ticket',
                }),
              })
            : tool({
                name: 'record',
                parameters: z.object({}),
                execute: () =>
                  new ToolOutput(
                    [{ type: 'inputText', text: 'child public' }],
                    true,
                    { ticket: 'private-child-ticket' },
                  ),
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
      const root = await session.submit('Delegate');
      if (mcp) {
        try {
          await vi.waitFor(
            () => {
              expect(childStartHeld).toBe(true);
              expect(childOutputAssigned).toBe(true);
            },
            { timeout: 6000 },
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(root.applicationToolOutputs).toEqual([]);
        } finally {
          releaseStart.resolve();
        }
      }
      const pending = await root.wait({ until: 'manual_tool' });
      if (!('requests' in pending)) throw new Error('Expected parent pause');
      const child = await vi.waitUntil(
        async () =>
          (await Array.fromAsync(session.subagents()))[0]?.turn ?? false,
        { timeout: 3000 },
      );
      const completed = await child.wait();
      expect(completed.applicationToolOutputs).toEqual([
        expect.objectContaining({
          callId: 'child-data',
          applicationData: { ticket: 'private-child-ticket' },
        }),
      ]);
      expect(child.applicationToolOutputs).toEqual(
        completed.applicationToolOutputs,
      );
      completed.applicationToolOutputs![0]!.applicationData.ticket = 'changed';
      expect(child.applicationToolOutputs[0]?.applicationData).toEqual({
        ticket: 'private-child-ticket',
      });
      const request = pause.match(pending.requests[0]);
      if (!request) throw new Error('Expected exact parent request');
      await session.respond(request.reply('continue'));
      expect((await root.wait()).applicationToolOutputs).toEqual([
        expect.objectContaining({
          callId: 'child-data',
          rootTurnId: root.turnId,
          applicationData: { ticket: 'private-child-ticket' },
        }),
      ]);
      expect(JSON.stringify(model.requests)).not.toContain(
        'private-child-ticket',
      );
      model.assertExhausted();
      expect(mcp?.failures ?? []).toEqual([]);
    } finally {
      releaseStart.resolve();
      assignSpy?.mockRestore();
      readSpy?.mockRestore();
      mcp?.peer.closeAllConnections();
      mcp?.peer.close();
      await executor.close();
    }
  },
  30000,
);

nativeIt(
  'preserves staged restored manual data through a second suspension before canonical output',
  async () => {
    const model = new ModelServer([
      [
        call('record', {}, { callId: 'staged-first' }),
        call('record', {}, { callId: 'still-pending' }),
      ],
      [message('both complete')],
    ]);
    await using provider = await providerFor(model);
    const declaration = manualTool({
      name: 'record',
      description: 'Record a manual value',
      parameters: z.object({}),
      result: z
        .string()
        .transform(
          (text) =>
            new ToolOutput(
              [{ type: 'inputText', text }],
              true,
              text === 'first'
                ? { ticket: 'private-staged-manual' }
                : undefined,
            ),
        ),
    });
    const agent = new Agent({
      instructions: 'Call both tools.',
      provider,
      tools: [declaration],
    });
    let firstState;
    {
      await using source = await agent.session();
      const turn = await source.submit('Begin');
      await waitForManualRequests(turn, ['staged-first', 'still-pending']);
      firstState = await source.suspend().catch((cause) => {
        throw new Error('first suspension', { cause });
      });
    }
    let secondState;
    {
      await using restored = await agent
        .session({ state: firstState })
        .catch((cause) => {
          throw new Error('first restore', { cause });
        });
      const turn = restored.restoredTurn!;
      const pending = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in pending))
        throw new Error('Expected restored manual calls');
      const first = pending.requests
        .map((row) => declaration.match(row))
        .find((row) => row?.callId === 'staged-first');
      if (!first) throw new Error('Expected first restored call');
      await restored.respond(first.reply('first'));
      expect(turn.applicationToolOutputs).toEqual([]);
      secondState = await restored.suspend().catch((cause) => {
        throw new Error('second suspension', { cause });
      });
    }
    await using final = await agent
      .session({ state: secondState })
      .catch((cause) => {
        throw new Error('second restore', { cause });
      });
    const turn = final.restoredTurn!;
    const pending = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in pending))
      throw new Error('Expected remaining manual call');
    expect(pending.requests).toHaveLength(1);
    const second = declaration.match(pending.requests[0]);
    if (!second) throw new Error('Expected remaining exact call');
    expect(second.callId).toBe('still-pending');
    expect(turn.applicationToolOutputs).toEqual([]);
    await final.respond(second.reply('second'));
    expect((await turn.wait()).applicationToolOutputs).toEqual([
      expect.objectContaining({
        callId: 'staged-first',
        applicationData: { ticket: 'private-staged-manual' },
      }),
    ]);
    expect(secondState).not.toHaveProperty('application_tool_outputs');
    expect(secondState).toHaveProperty('pending_application_tool_outputs', [
      expect.objectContaining({
        callId: 'staged-first',
        applicationData: { ticket: 'private-staged-manual' },
      }),
    ]);
    expect(JSON.stringify(nativeCheckpoint(secondState))).not.toContain(
      'private-staged-manual',
    );
    const duplicate = JSON.parse(JSON.stringify(secondState));
    duplicate.pending_application_tool_outputs.push(
      structuredClone(duplicate.pending_application_tool_outputs[0]),
    );
    await expect(agent.session({ state: duplicate })).rejects.toThrow(
      'Duplicate pending application tool output',
    );
    expect(JSON.stringify(model.requests)).not.toContain(
      'private-staged-manual',
    );
    expect(JSON.stringify(await final.saveState())).toContain(
      'private-staged-manual',
    );
    model.assertExhausted();
  },
);

nativeIt.each([false, true])(
  'keeps a restored terminal candidate staged until canonical acceptance, reject=%s',
  async (reject) => {
    const model = new ModelServer([
      [
        call('record', {}, { callId: 'held-staged' }),
        call('pause', {}, { callId: 'held-pause' }),
      ],
      ...(reject ? [] : [[message('ordinary after held')]]),
    ]);
    await using provider = await providerFor(model);
    const record = manualTool({
      name: 'record',
      description: 'Record',
      parameters: z.object({}),
      result: z.string().transform(
        (text) =>
          new ToolOutput([{ type: 'inputText', text }], true, {
            ticket: 'private-held-stage',
          }),
      ),
    });
    const pause = manualTool({
      name: 'pause',
      description: 'Pause',
      parameters: z.object({}),
      result: z.string(),
    });
    const originalAgent = new Agent({
      instructions: 'Use both tools.',
      provider,
      tools: [record, pause],
    });
    let firstState;
    {
      await using source = await originalAgent.session();
      const turn = await source.submit('Begin');
      await waitForManualRequests(turn, ['held-staged', 'held-pause']);
      firstState = await source.suspend();
    }
    let state;
    {
      await using source = await originalAgent.session({ state: firstState });
      const turn = source.restoredTurn!;
      const waiting = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in waiting)) throw new Error('Expected restored calls');
      const request = waiting.requests
        .map((row) => record.match(row))
        .find(Boolean);
      if (!request) throw new Error('Expected record grant');
      await source.respond(request.reply('held public'));
      state = await source.suspend();
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = vi.fn(() => 'must not execute');
    await using final = await new Agent({
      instructions: 'Use both tools.',
      provider,
      tools: [
        tool({
          name: 'record',
          parameters: z.object({}),
          finishTurn: true,
          execute,
        }),
        pause,
      ],
      outputGuardrails: [
        {
          name: 'hold-terminal',
          async callback(context) {
            if (context.toolCall?.callId === 'held-staged') {
              entered.resolve();
              await release.promise;
            }
            return { tripwireTriggered: reject };
          },
        },
      ],
    }).session({ state });
    try {
      const turn = final.restoredTurn!;
      const waiting = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in waiting))
        throw new Error('Expected final manual grant');
      const request = pause.match(waiting.requests[0]);
      if (!request) throw new Error('Expected exact pause grant');
      const replied = final.respond(request.reply('ready'));
      await entered.promise;
      await replied;
      expect(turn.applicationToolOutputs).toEqual([]);
      release.resolve();
      if (reject) {
        await expect(turn.wait()).rejects.toBeInstanceOf(GuardrailTripwire);
        expect(turn.applicationToolOutputs).toEqual([]);
        expect(JSON.stringify(await final.saveState())).not.toContain(
          'private-held-stage',
        );
      } else {
        const complete = await turn.wait();
        expect(complete.finalOutput).toBe('ordinary after held');
        expect(complete.applicationToolOutputs).toEqual([
          expect.objectContaining({
            callId: 'held-staged',
            applicationData: { ticket: 'private-held-stage' },
          }),
        ]);
      }
      expect(execute).not.toHaveBeenCalled();
      model.assertExhausted();
    } finally {
      release.resolve();
    }
  },
);
