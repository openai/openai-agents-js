import type { NativeEventBatch } from '../fixtures/native-event-batches';
import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  NativeRole,
  tool,
  type Observation,
  type Session,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { parseEvent, type NativeEvent } from '../../src/runtime/events';
import { TurnAborted } from '../../src/runtime/session';
import * as telemetry from '../../src/runtime/telemetry';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

type ChildResponse = (
  request: JsonObject,
) => JsonObject[] | Promise<JsonObject[]>;

function childServer(
  responses: readonly ChildResponse[],
  names: readonly string[] = ['child'],
  agentType?: string,
) {
  let rootId: string | undefined;
  let rootRequests = 0;
  let childRequests = 0;
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      if (++rootRequests === 1)
        return names.map((name) =>
          call(
            'spawn_agent',
            {
              task_name: name,
              message: 'Complete the assigned work.',
              ...(agentType ? { agent_type: agentType } : {}),
            },
            { namespace: 'collaboration', callId: `spawn-${name}` },
          ),
        );
      return [message('root finished')];
    }
    const response = responses[childRequests++];
    if (!response) throw new Error('Unexpected child model request');
    return response(request);
  };
  return new ModelServer(
    Array.from({ length: responses.length + 2 }, () => respond),
  );
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-child-events',
    supportsWebsockets: false,
  });
}

async function oneChild(session: Session) {
  const children = await vi.waitUntil(
    async () => {
      const children = await Array.fromAsync(session.subagents());
      // Retry only the observed snapshot with one unpublished child turn.
      if (children.length === 1 && children[0]!.turn === null) return false;
      return children;
    },
    { timeout: 3000 },
  );
  expect(children).toHaveLength(1);
  const child = children[0]!;
  if (!child.turn) throw new Error('Missing real native child turn');
  expect(child.turn.childId).toBe(child.id);
  // Keep the native counter as decimal text, without a Number conversion.
  expect(child.turn.instanceId).toMatch(/^(?:0|[1-9]\d*)$/);
  return { child, turn: child.turn };
}

async function collect(reader: AsyncIterable<Observation>) {
  const events: Observation[] = [];
  for await (const event of reader) events.push(event);
  return events;
}

beforeAll(async () => {
  await telemetry.configure({ traceProcessors: [{ onEvent() {} }] });
});

afterAll(async () => {
  await telemetry.shutdown();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

it.each([
  { role: 'default', inherits: true },
  { role: 'named', inherits: false },
])(
  'attributes files to a child by instruction source (role $role)',
  async ({ role, inherits }) => {
    const instructions = 'Use the child fixture.\r\n';
    const combined = 'Delegate.\n\nUse the child fixture.';
    let childRequest: JsonObject | undefined;
    const server = childServer(
      [
        (request) => {
          childRequest = request;
          return [message('child final')];
        },
      ],
      undefined,
      role,
    );
    const executor = await startPublicExecutor();
    try {
      const instructionFile = join(await realpath(executor.cwd), 'child.md');
      await writeFile(instructionFile, instructions);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [
          new NativeAgents({
            additionalRoles: [
              new NativeRole({
                name: 'named',
                description: 'Supplies explicit developer instructions.',
                instructions: combined,
              }),
            ],
          }),
        ],
      }).session({
        instructionFiles: [instructionFile],
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
        'root finished',
      );
      const { child, turn } = await oneChild(session);
      expect((await turn.wait()).finalOutput).toBe('child final');
      expect(childRequest?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'developer',
            content: expect.arrayContaining([
              { type: 'input_text', text: combined },
            ]),
          }),
        ]),
      );
      const recorded = (
        await Array.fromAsync(session.turns({ subagentId: child.id }))
      ).find((entry) => entry.id === turn.turnId);
      expect(recorded?.receipt).toMatchObject({
        threadId: child.id,
        turnId: turn.turnId,
        developerInstructionsSha256: createHash('sha256')
          .update(combined)
          .digest('hex'),
        instructionFiles: inherits
          ? [
              {
                path: instructionFile,
                source: 'application_file',
                sha256: createHash('sha256').update(instructions).digest('hex'),
              },
            ]
          : [],
      });
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);

describe('passive real-native child Turn events', () => {
  it('drains the real child terminal after its native result settles', async () => {
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_events;
    const childEntered = Promise.withResolvers<void>();
    const releaseModel = Promise.withResolvers<void>();
    const terminalHeld = Promise.withResolvers<NativeEvent>();
    const releaseTerminal = Promise.withResolvers<void>();
    let held = false;
    // Hold only JS delivery of the actual multiplexed child terminal.
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await next.call(this);
      const event = parseEvent(firstNativeBatchWire(raw));
      if (
        !held &&
        event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg?.type)
      ) {
        held = true;
        terminalHeld.resolve(event);
        await releaseTerminal.promise;
      }
      return raw;
    });
    const server = childServer([
      async () => {
        childEntered.resolve();
        await releaseModel.promise;
        return [message('child final')];
      },
    ]);
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('begin');
        await childEntered.promise;
        expect((await root.wait()).finalOutput).toBe('root finished');
        const { child, turn } = await oneChild(session);
        let ended = false;
        const observations = collect(turn.events()).then((events) => {
          ended = true;
          return events;
        });
        releaseModel.resolve();
        const terminal = await terminalHeld.promise;
        expect(terminal.subagent_id).toBe(child.id);
        expect(terminal.subagent_instance_id).toBe(turn.instanceId);
        expect(turn.submissionId).toBe(
          `child:${child.id}:${terminal.subagent_incarnation}:${turn.turnId}`,
        );
        // This is a real result waiter, independent of the delayed JS reader.
        expect((await turn.wait()).finalOutput).toBe('child final');
        expect(ended).toBe(false);
        releaseTerminal.resolve();
        const events = await observations;
        expect(events[0]).toMatchObject({
          type: 'turn_started',
          submissionId: turn.submissionId,
          turnId: turn.turnId,
        });
        expect(events.at(-1)).toMatchObject({
          type: 'turn_finished',
          status: 'completed',
          submissionId: turn.submissionId,
          turnId: turn.turnId,
        });
        expect(await collect(turn.events())).toEqual(events);
        server.assertExhausted();
      } finally {
        releaseModel.resolve();
        releaseTerminal.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);

  it('keeps a newer acknowledged child open while an older start awaits delivery', async () => {
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_events;
    const firstStart = Promise.withResolvers<NativeEvent>();
    const secondStart = Promise.withResolvers<NativeEvent>();
    const releaseFirstStart = Promise.withResolvers<void>();
    const releaseSecondStart = Promise.withResolvers<void>();
    const queued: NativeEventBatch[] = [];
    let starts = 0;
    // Preserve native event order while controlling when Session receives it.
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = queued.shift() ?? (await next.call(this));
      const event = parseEvent(firstNativeBatchWire(raw));
      if (
        event.subagent_id &&
        ['task_started', 'turn_started'].includes(event.msg?.type)
      ) {
        if (++starts === 1) {
          firstStart.resolve(event);
          // Prefetch through the real terminal so the native receipt settles.
          // This tests publication order, not the native reader's capacity.
          for (;;) {
            const pending = await next.call(this);
            queued.push(pending);
            const observed = parseEvent(firstNativeBatchWire(pending));
            if (
              observed.subagent_id === event.subagent_id &&
              ['task_complete', 'turn_complete'].includes(observed.msg?.type)
            ) {
              break;
            }
          }
          await releaseFirstStart.promise;
        } else if (starts === 2) {
          secondStart.resolve(event);
          await releaseSecondStart.promise;
        }
      }
      return raw;
    });
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const server = childServer([
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return [message('first child final')];
      },
      async () => {
        secondEntered.resolve();
        await releaseSecond.promise;
        return [message('second child final')];
      },
    ]);
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      let reader: AsyncIterableIterator<Observation> | undefined;
      try {
        const root = await session.submit('begin');
        await firstEntered.promise;
        const delayed = await firstStart.promise;
        const { child, turn: first } = await oneChild(session);
        expect(delayed.subagent_id).toBe(child.id);
        releaseFirst.resolve();
        expect((await first.wait()).finalOutput).toBe('first child final');
        const second = await child.submit('second child turn');
        await secondEntered.promise;
        expect(second.turnId).not.toBe(first.turnId);
        expect(second.instanceId).toBe(first.instanceId);
        reader = second.events();
        const firstObservation = reader.next();
        releaseFirstStart.resolve();
        await secondStart.promise;
        releaseSecondStart.resolve();
        expect(await firstObservation).toMatchObject({
          done: false,
          value: {
            type: 'turn_started',
            turnId: second.turnId,
            submissionId: second.submissionId,
          },
        });
        const remaining = collect(reader);
        releaseSecond.resolve();
        expect((await remaining).at(-1)).toMatchObject({
          type: 'turn_finished',
          status: 'completed',
          turnId: second.turnId,
          submissionId: second.submissionId,
        });
        expect((await second.wait()).finalOutput).toBe('second child final');
        await root.wait();
        server.assertExhausted();
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        releaseFirstStart.resolve();
        releaseSecondStart.resolve();
        await reader?.return?.();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);

  it('excludes a later turn of the same child from the original handle', async () => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const server = childServer([
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return [message('first child turn')];
      },
      async (request) => {
        expect(JSON.stringify(request.input)).toContain('second child turn');
        secondEntered.resolve();
        await releaseSecond.promise;
        return [message('second child final')];
      },
    ]);
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('begin');
        await firstEntered.promise;
        await root.wait();
        const { child, turn: first } = await oneChild(session);
        releaseFirst.resolve();
        const original = await collect(first.events());
        expect(original.at(-1)).toMatchObject({
          type: 'turn_finished',
          status: 'completed',
        });
        const second = await child.submit('second child turn');
        await secondEntered.promise;
        expect(second.childId).toBe(first.childId);
        expect(second.instanceId).toBe(first.instanceId);
        expect(second.turnId).not.toBe(first.turnId);
        expect(second.submissionId).not.toBe(first.submissionId);
        await expect(child.tryCancel(first)).resolves.toBe(false);
        expect(await collect(first.events())).toEqual(original);
        expect(
          await collect(first.events({ after: original.at(-1)!.sequence })),
        ).toEqual([]);
        releaseSecond.resolve();
        const current = await collect(second.events());
        expect(current.at(-1)).toMatchObject({
          type: 'turn_finished',
          status: 'completed',
          submissionId: second.submissionId,
          turnId: second.turnId,
        });
        expect(
          current.every(
            (event) =>
              'submissionId' in event &&
              event.submissionId === second.submissionId,
          ),
        ).toBe(true);
        expect(await collect(first.events())).toEqual(original);
        server.assertExhausted();
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);

  it('keeps child observations open through entered callback cleanup during Session close', async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const releaseTail = Promise.withResolvers<void>();
    let callbackFinished = false;
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      async execute(_args, context) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
        aborted.resolve();
        await releaseTail.promise;
        callbackFinished = true;
        return 'cleanup joined';
      },
    });
    const server = childServer([
      () => [call('hold', {}, { callId: 'child-held-call' })],
    ]);
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents(), hold],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('begin');
        await entered.promise;
        await root.wait();
        const { turn } = await oneChild(session);
        const seen: Observation[] = [];
        let ended = false;
        const observing = (async () => {
          for await (const event of turn.events()) {
            if (event.type === 'tool_finished')
              expect(callbackFinished).toBe(true);
            seen.push(event);
          }
          ended = true;
        })();
        let closed = false;
        const closing = session.close().then(() => {
          closed = true;
        });
        await aborted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(ended).toBe(false);
        expect(closed).toBe(false);
        expect(callbackFinished).toBe(false);
        expect(seen).toContainEqual(
          expect.objectContaining({
            type: 'tool_started',
            callId: 'child-held-call',
          }),
        );
        expect(seen.some((event) => event.type === 'tool_finished')).toBe(
          false,
        );
        releaseTail.resolve();
        await closing;
        await observing;
        expect(ended).toBe(true);
        expect(seen.filter((event) => event.type === 'tool_finished')).toEqual([
          expect.objectContaining({
            submissionId: turn.submissionId,
            turnId: turn.turnId,
            callId: 'child-held-call',
            status: 'cancelled',
          }),
        ]);
        expect(await collect(turn.events())).toEqual(seen);
        server.assertExhausted();
      } finally {
        releaseTail.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);
});

describe('exact native child cancellation', () => {
  it('cancels the selected child while refusing a sibling Turn and preserving its work', async () => {
    const children = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<void>>
    >();
    const respond: ChildResponse = async (request) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      const release = Promise.withResolvers<void>();
      children.set(id, release);
      await release.promise;
      return [message(`completed ${id}`)];
    };
    const server = childServer([respond, respond], ['alpha', 'beta']);
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        await (await session.submit('Start both children.')).wait();
        await vi.waitFor(() => expect(children.size).toBe(2));
        const expectedChildIds = [...children.keys()].sort();
        const { selected, sibling, selectedTurn, siblingTurn } =
          await vi.waitUntil(
            async () => {
              const captured = await Array.fromAsync(session.subagents());
              expect(captured).toHaveLength(2);
              expect(captured.map((child) => child.id).sort()).toEqual(
                expectedChildIds,
              );
              for (const child of captured) {
                expect(child.status).toBe('active');
                if (child.turn === null) continue;
                expect(child.isLive).toBe(true);
                expect(child.turn.childId).toBe(child.id);
              }
              const selected = captured[0]!;
              const sibling = captured[1]!;
              const selectedTurn = selected.turn;
              const siblingTurn = sibling.turn;
              if (selectedTurn === null || siblingTurn === null) return false;
              return { selected, sibling, selectedTurn, siblingTurn };
            },
            { timeout: 3000 },
          );
        const foreignServer = new ModelServer([[message('foreign complete')]]);
        await using foreignProvider = await providerFor(foreignServer);
        await using foreignSession = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5.5',
          provider: foreignProvider,
        }).session();
        const foreignTurn = await foreignSession.submit('Complete separately.');
        expect((await foreignTurn.wait()).finalOutput).toBe('foreign complete');
        await expect(selected.tryCancel(foreignTurn)).rejects.toThrow(
          'Turn does not belong to this captured child instance',
        );
        foreignServer.assertExhausted();
        await expect(selected.tryCancel(siblingTurn)).rejects.toThrow(
          'Turn does not belong to this captured child instance',
        );
        const attention = selectedTurn.waitForAttention();
        void attention.catch(() => {});
        await expect(selected.tryCancel(selectedTurn)).resolves.toBe(true);
        const error: unknown = await selectedTurn
          .wait()
          .catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(TurnAborted);
        expect((error as NativeError).responseIntegrityReason).toBeNull();
        await expect(attention).resolves.toMatchObject({
          type: 'needs_attention',
          reason: 'interrupted',
          error,
        });
        await expect(selected.tryCancel(selectedTurn)).resolves.toBe(false);
        let siblingFinished = false;
        const surviving = siblingTurn.wait().then((result) => {
          siblingFinished = true;
          return result;
        });
        await Promise.resolve();
        expect(siblingFinished).toBe(false);
        children.get(sibling.id)!.resolve();
        expect((await surviving).finalOutput).toBe(`completed ${sibling.id}`);
        server.assertExhausted();
      } finally {
        for (const child of children.values()) child.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);

  it('preserves queued child input when conditional cancellation returns false', async () => {
    let rootId: string | undefined;
    let childId: string | undefined;
    let action: 'spawn' | 'queue' | 'followup' | undefined = 'spawn';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const followedUp = Promise.withResolvers<void>();
    let childRequests = 0;
    const respond: ChildResponse = async (request) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      if (id === rootId) {
        const selected = action;
        action = undefined;
        if (selected === 'spawn')
          return [
            call(
              'spawn_agent',
              { task_name: 'child', message: 'Complete the assigned work.' },
              { namespace: 'collaboration', callId: 'spawn-child' },
            ),
          ];
        if (selected === 'queue')
          return [
            call(
              'send_message',
              { target: childId!, message: 'PRESERVED_CHILD_INPUT' },
              { namespace: 'collaboration', callId: 'queue-child-input' },
            ),
          ];
        if (selected === 'followup')
          return [
            call(
              'followup_task',
              { target: childId!, message: 'Read the queued input.' },
              { namespace: 'collaboration', callId: 'followup-child' },
            ),
          ];
        return [message('root finished')];
      }
      childId ??= id;
      expect(id).toBe(childId);
      if (++childRequests === 1) {
        entered.resolve();
        await release.promise;
        return [message('first child final')];
      }
      expect(JSON.stringify(request.input)).toContain('PRESERVED_CHILD_INPUT');
      followedUp.resolve();
      return [message('queued input received')];
    };
    const server = new ModelServer(Array.from({ length: 8 }, () => respond));
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        await (await session.submit('Start the child.')).wait();
        await entered.promise;
        const { child, turn } = await oneChild(session);
        action = 'queue';
        await (await session.submit('Queue more child work.')).wait();
        await expect(child.tryCancel(turn)).resolves.toBe(false);
        release.resolve();
        expect((await turn.wait()).finalOutput).toBe('first child final');
        action = 'followup';
        await (await session.submit('Continue the child.')).wait();
        await followedUp.promise;
        const { turn: current } = await oneChild(session);
        expect(current.childId).toBe(turn.childId);
        expect(current.turnId).not.toBe(turn.turnId);
        expect((await current.wait()).finalOutput).toBe(
          'queued input received',
        );
        expect(childRequests).toBe(2);
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);

  it.each([false, true])(
    'joins child cleanup (cells: %s)',
    async (codeMode) => {
      const callbacks = new Map<
        string,
        {
          signal: AbortSignal;
          cellId: string | null;
          aborted: ReturnType<typeof Promise.withResolvers<void>>;
          release: ReturnType<typeof Promise.withResolvers<void>>;
          finished: boolean;
        }
      >();
      const hold = tool({
        name: 'hold',
        parameters: z.object({}),
        async execute(_args, { signal, call }) {
          if (!call?.childId) throw new Error('Missing native child identity');
          const callback = {
            signal,
            cellId: call.cellId,
            aborted: Promise.withResolvers<void>(),
            release: Promise.withResolvers<void>(),
            finished: false,
          };
          callbacks.set(call.childId, callback);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener('abort', () => resolve(), { once: true });
          });
          callback.aborted.resolve();
          await callback.release.promise;
          callback.finished = true;
          return 'cleanup finished';
        },
      });
      const server = childServer(
        [
          ...['alpha', 'beta'].map((name): ChildResponse => () => [
            codeMode
              ? {
                  type: 'custom_tool_call',
                  name: 'exec',
                  call_id: `held-${name}-cell`,
                  input: 'text(await tools.hold({}));',
                }
              : call('hold', {}, { callId: `held-${name}-call` }),
          ]),
        ],
        ['alpha', 'beta'],
      );
      const executor = await startPublicExecutor();
      try {
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'Delegate.',
          model: 'gpt-5.5',
          provider,
          tools: [new NativeAgents(), hold],
          programmaticToolCalling: codeMode,
        }).session({
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          }),
        });
        try {
          await (await session.submit('Start the child.')).wait();
          await vi.waitFor(() => expect(callbacks.size).toBe(2));
          const captured = await Array.fromAsync(session.subagents());
          expect(captured).toHaveLength(2);
          const [child, sibling] = captured;
          if (!child?.turn || !sibling?.turn)
            throw new Error('Missing real native child Turns');
          const turn = child.turn;
          const selectedWork = callbacks.get(child.id)!;
          const siblingWork = callbacks.get(sibling.id)!;
          expect(child).not.toBe(sibling);
          expect(turn).not.toBe(sibling.turn);
          expect(selectedWork).not.toBe(siblingWork);
          expect(selectedWork.signal).not.toBe(siblingWork.signal);
          if (codeMode) {
            expect(selectedWork.cellId).toEqual(expect.any(String));
            expect(siblingWork.cellId).toEqual(expect.any(String));
          }
          let waited = false;
          const waiting = turn.wait().catch((error: unknown) => {
            waited = true;
            return error;
          });
          let cancellationFinished = false;
          const cancelling = child.tryCancel(turn).then((confirmed) => {
            cancellationFinished = true;
            return confirmed;
          });
          await selectedWork.aborted.promise;
          expect(selectedWork.finished).toBe(false);
          expect(siblingWork.signal.aborted).toBe(false);
          expect(waited).toBe(false);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(cancellationFinished).toBe(false);
          selectedWork.release.resolve();
          expect(await cancelling).toBe(true);
          expect(await waiting).toBeInstanceOf(NativeError);
          expect(selectedWork.finished).toBe(true);
          expect(siblingWork.signal.aborted).toBe(false);
          let closed = false;
          const closing = session.close().then(() => {
            closed = true;
          });
          await siblingWork.aborted.promise;
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(closed).toBe(false);
          expect(siblingWork.finished).toBe(false);
          siblingWork.release.resolve();
          await closing;
          expect(siblingWork.finished).toBe(true);
          server.assertExhausted();
        } finally {
          for (const callback of callbacks.values()) callback.release.resolve();
        }
      } finally {
        await executor.close();
      }
    },
    30_000,
  );
});

it('keeps child tracing policy for explicit starts and active steering', async () => {
  try {
    const modes = [false, true].flatMap((disabled) => [
      { disabled, programmaticToolCalling: false, approve: true },
      { disabled, programmaticToolCalling: true, approve: true },
      { disabled, programmaticToolCalling: false, approve: false },
    ]);
    for (const { disabled, programmaticToolCalling, approve } of modes) {
      let rootId: string | undefined;
      let roots = 0;
      let childModels = 0;
      let steps = 0;
      let initialChildTurn: string | undefined;
      let approvals = 0;
      let workflow: Awaited<ReturnType<typeof telemetry.startTrace>>;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const check = () => {
        const span = telemetry.getCurrentSpan()!;
        expect(span).toBeDefined();
        expect(telemetry.getCurrentTrace()).toBe(workflow);
        expect(span.context.disabled).toBe(disabled);
        expect(span.context.includeSensitiveData).toBe(false);
      };
      const respond = (request: JsonObject) => {
        const id = String(
          JSON.parse(
            (request.client_metadata as Record<string, string>)[
              'x-codex-turn-metadata'
            ],
          ).thread_id,
        );
        rootId ??= id;
        if (id === rootId)
          return ++roots === 1
            ? [
                call(
                  'spawn_agent',
                  {
                    task_name: 'policy_child',
                    message: 'Do the scripted work.',
                  },
                  { namespace: 'collaboration', callId: 'spawn-policy' },
                ),
              ]
            : [message('root done')];
        childModels++;
        return childModels === 1
          ? [message('initial child done')]
          : childModels === 2
            ? [
                programmaticToolCalling
                  ? {
                      type: 'custom_tool_call',
                      name: 'exec',
                      call_id: 'traced-command',
                      input:
                        "text(await tools.exec_command({cmd:'printf traced'}));",
                    }
                  : call(
                      'exec_command',
                      { cmd: 'printf traced' },
                      { callId: 'traced-command' },
                    ),
              ]
            : [message('explicit child done')];
      };
      const model = new ModelServer(
        Array.from({ length: approve ? 5 : 4 }, () => respond),
      );
      const executor = await startPublicExecutor();
      try {
        await using provider = await providerFor(model);
        await using session = await new Agent({
          instructions: 'Delegate.',
          model: 'gpt-5.5',
          provider,
          programmaticToolCalling,
          tools: [
            new NativeAgents({
              beforeStep: async (context) => {
                check();
                steps++;
                initialChildTurn ??= context.child.turnId;
                if (
                  context.child.turnId !== initialChildTurn &&
                  context.stepIndex === 0
                ) {
                  entered.resolve();
                  await release.promise;
                  check();
                }
                return undefined;
              },
            }),
          ],
        }).session({
          tracing: { disabled, includeSensitiveData: false },
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
            approval: (context) => {
              check();
              expect(context.call?.route).toBe(
                programmaticToolCalling ? 'code' : 'direct',
              );
              approvals++;
              return approve;
            },
          }),
        });
        await telemetry.withTrace(
          { name: 'original.workflow', includeSensitiveData: true },
          async (original) => {
            workflow = original;
            expect(
              (await (await session.submit('delegate')).wait()).finalOutput,
            ).toBe('root done');
          },
        );
        const { child, turn } = await oneChild(session);
        expect((await turn.wait()).finalOutput).toBe('initial child done');
        await telemetry.withTrace(
          {
            name: 'unrelated.workflow',
            includeSensitiveData: true,
            disabled: false,
          },
          async () => {
            const second = await child.submit('new child turn');
            const finished = second.wait();
            await Promise.race([
              entered.promise,
              finished.then(() => {
                throw new Error(
                  'Child turn completed before the steering gate',
                );
              }),
            ]);
            const steered = await child
              .submit('steer active child')
              .finally(release.resolve);
            expect(steered).toBe(second);
            if (approve) {
              expect((await finished).finalOutput).toBe('explicit child done');
            } else {
              await expect(finished).rejects.toThrow(NativeError);
            }
          },
        );
        expect(approvals).toBe(1);
        expect(childModels).toBe(approve ? 3 : 2);
        if (!approve) {
          expect(
            executor.requests.some((rpc) => rpc.method === 'process/start'),
          ).toBe(false);
        }
        expect(steps).toBeGreaterThanOrEqual(3);
        model.assertExhausted();
      } finally {
        release.resolve();
        await executor.close();
      }
    }
  } finally {
    await telemetry.forceFlush();
  }
}, 60_000);
