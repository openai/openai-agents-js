import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  stopExecutorTurn,
  tool,
  type EnvironmentOptions,
  type ExecutorContext,
  type Tool,
  type ToolContext,
  type Session,
} from '../../src';
import { TurnAborted } from '../../src/runtime/session';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Executor stop deadline: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() =>
  bounded(ModelServer.closeAll(), 'provider fixture cleanup', 5_000),
);

const cell = (input: string, callId = 'executor-stop-cell'): JsonObject => ({
  type: 'custom_tool_call',
  name: 'exec',
  call_id: callId,
  input,
});
const patch = (file: string, content: string) =>
  `*** Begin Patch\n*** Add File: ${file}\n+${content}\n*** End Patch`;
const patchCall = (file: string, content: string): JsonObject => ({
  type: 'custom_tool_call',
  name: 'apply_patch',
  call_id: 'patch-call',
  input: patch(file, content),
});
const starts = (requests: JsonObject[]) =>
  requests.filter((request) => request.method === 'process/start');
async function contents(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
function stopped(
  result: { ok: true; value: unknown } | { ok: false; error: unknown },
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected an executor owner stop');
  expect(result.error).toBeInstanceOf(NativeError);
  expect(String(result.error)).toContain('Turn stopped by executor policy');
  return result.error as Error;
}

async function open(
  responses: ConstructorParameters<typeof ModelServer>[0],
  policy: Partial<EnvironmentOptions> = {},
  options: {
    code?: boolean;
    children?: boolean;
    tools?: Tool[];
    usage?: JsonObject;
  } = {},
) {
  const executor = await startPublicExecutor();
  let provider: NativeProvider | undefined;
  let session: Session | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const [label, closeResource] of [
      ['Session cleanup', () => session?.close() ?? Promise.resolve()],
      ['provider cleanup', () => provider?.close() ?? Promise.resolve()],
      ['executor cleanup', () => executor.close()],
    ] as const) {
      try {
        await bounded(closeResource(), label, 5_000);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Executor stop fixture cleanup failed',
      );
  };
  try {
    const model = new ModelServer(responses, options.usage);
    const config = await model.config();
    provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-executor-stop',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use only the scripted selected tools.',
      provider,
      model: 'gpt-5.5',
      programmaticToolCalling: options.code ?? false,
      tools: [
        ...(options.tools ?? []),
        ...(options.children ? [new NativeAgents()] : []),
      ],
    });
    session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        approval: () => true,
        ...policy,
      }),
    });
    return { executor, model, session, [Symbol.asyncDispose]: close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Executor fixture setup and cleanup failed',
      );
    }
    throw error;
  }
}

function cleanupProbe() {
  const entered = Promise.withResolvers<ToolContext>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleaned = false;
  const gate = tool({
    name: 'executor_cleanup_probe',
    description: 'Hold real callback cleanup after cancellation.',
    parameters: z.strictObject({}),
    async execute(_args, info) {
      let abort: (() => void) | undefined;
      try {
        entered.resolve(info);
        return await new Promise<never>((_resolve, reject) => {
          abort = () => reject(info.signal.reason);
          info.signal.addEventListener('abort', abort, { once: true });
          if (info.signal.aborted) abort();
        });
      } finally {
        if (abort) info.signal.removeEventListener('abort', abort);
        cleaning.resolve();
        await release.promise;
        cleaned = true;
      }
    },
  });
  return {
    gate,
    entered,
    cleaning,
    release,
    get cleaned() {
      return cleaned;
    },
  };
}

it.each(['command approval', 'patch transform'] as const)(
  'stops the root from %s before effects, redacts the reason, and permits a later root',
  async (source) => {
    const secret = 'executor-root-private-reason';
    let calls = 0;
    const selected =
      source === 'command approval'
        ? call(
            'exec_command',
            { cmd: 'printf denied > root-denied.txt' },
            { callId: 'root-call' },
          )
        : patchCall('root-denied.txt', 'denied');
    const later =
      source === 'command approval'
        ? call(
            'exec_command',
            { cmd: 'printf allowed > root-allowed.txt' },
            { callId: 'later-call' },
          )
        : patchCall('root-allowed.txt', 'allowed');
    const policy: Partial<EnvironmentOptions> =
      source === 'command approval'
        ? { approval: () => (calls++ === 0 ? stopExecutorTurn(secret) : true) }
        : {
            transformArguments: (_info, value) =>
              calls++ === 0 ? stopExecutorTurn(secret) : value,
          };
    await using f = await open(
      [[selected], [later], [message('later root done')]],
      policy,
    );
    const replies: string[] = [];
    const addon = await binding();
    const resolveReply =
      addon.NativeThread.prototype._resolve_native_interception;
    const spy = vi
      .spyOn(addon.NativeThread.prototype, '_resolve_native_interception')
      .mockImplementation(function (this: NativeThread, nonce, reply) {
        replies.push(reply);
        return resolveReply.call(this, nonce, reply);
      });
    try {
      const turn = await bounded(
        f.session.submit('Stop the selected effect.'),
        'submit root',
      );
      const events = observe(
        bounded(Array.fromAsync(turn.events()), 'root observations'),
      );
      const error = stopped(await bounded(observe(turn.wait()), 'root stop'));
      expect(error.cause).toBeUndefined();
      expect(f.model.requests).toHaveLength(1);
      expect(starts(f.executor.requests)).toHaveLength(0);
      expect(
        await contents(join(f.executor.cwd, 'root-denied.txt')),
      ).toBeNull();
      const items = await bounded(
        Array.fromAsync(f.session.items()),
        'root history',
      );
      const observations = await events;
      if (!observations.ok) throw observations.error;
      expect(
        JSON.stringify({
          events: observations.value,
          items,
          wire: replies,
          executor: f.executor.requests,
          provider: f.model.requests,
          error: String(error),
          stack: error.stack,
        }),
      ).not.toContain(secret);
      const next = await bounded(
        f.session.submit('Allow the next root.'),
        'submit later root',
      );
      expect((await bounded(next.wait(), 'later root')).finalOutput).toBe(
        'later root done',
      );
      if (source === 'command approval')
        expect(starts(f.executor.requests)).toHaveLength(1);
      expect(
        (await contents(join(f.executor.cwd, 'root-allowed.txt')))?.trim(),
      ).toBe('allowed');
      expect(
        await contents(join(f.executor.cwd, 'root-denied.txt')),
      ).toBeNull();
      expect(calls).toBe(2);
      f.model.assertExhausted();
    } finally {
      spy.mockRestore();
    }
  },
  45_000,
);

it.each(['command false', 'patch stop'] as const)(
  'prevents generated catch-and-continue for %s and joins physical callback cleanup',
  async (source) => {
    const probe = cleanupProbe();
    const first =
      source === 'command false'
        ? 'tools.exec_command({cmd:"printf denied > code-denied.txt"})'
        : `tools.apply_patch(${JSON.stringify(patch('code-denied.txt', 'denied'))})`;
    const input = `const cleanup = tools.executor_cleanup_probe({}).catch(() => {});
try { await ${first}; } catch { text('caught executor denial'); }
await tools.exec_command({cmd:'printf escaped > code-continuation.txt'});
await cleanup; text('forbidden continuation');`;
    const seen: ExecutorContext[] = [];
    const policy: Partial<EnvironmentOptions> =
      source === 'command false'
        ? {
            async approval(info, value) {
              if (
                info.toolName === 'exec_command' &&
                JSON.stringify(value).includes('code-denied.txt')
              ) {
                await probe.entered.promise;
                seen.push(info);
                return false;
              }
              return true;
            },
          }
        : {
            async transformArguments(info, value) {
              if (info.toolName === 'apply_patch') {
                await probe.entered.promise;
                seen.push(info);
                return stopExecutorTurn('private-generated-patch-reason');
              }
              return value;
            },
          };
    try {
      await using f = await open([[cell(input)]], policy, {
        code: true,
        tools: [probe.gate],
      });
      try {
        const turn = await bounded(
          f.session.submit('Run the guarded cell.'),
          'submit code',
        );
        let settled = false;
        const result = observe(turn.wait()).finally(() => {
          settled = true;
        });
        await bounded(probe.cleaning.promise, 'physical cleanup entry');
        // Hold real cleanup across an observation window, not only one microtask.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(seen).toHaveLength(1);
        expect(seen[0]?.submission).toBe(turn);
        expect(seen[0]?.call).toMatchObject({
          route: 'code',
          cellId: expect.any(String),
          nestedCallId: expect.any(String),
        });
        expect(settled).toBe(false);
        expect(probe.cleaned).toBe(false);
        expect(
          await contents(join(f.executor.cwd, 'code-denied.txt')),
        ).toBeNull();
        expect(
          await contents(join(f.executor.cwd, 'code-continuation.txt')),
        ).toBeNull();
        probe.release.resolve();
        stopped(await bounded(result, 'joined code stop'));
        expect(probe.cleaned).toBe(true);
        expect(starts(f.executor.requests)).toHaveLength(0);
        expect(f.model.requests).toHaveLength(1);
        expect(
          await contents(join(f.executor.cwd, 'code-continuation.txt')),
        ).toBeNull();
        f.model.assertExhausted();
      } finally {
        probe.release.resolve();
      }
    } finally {
      probe.release.resolve();
    }
  },
  45_000,
);

it('denies generated stdin against a real live process after a positive write, without continuation', async () => {
  let processId: number | undefined;
  let denied: ExecutorContext | undefined;
  await using f = await open(
    [
      [
        call(
          'exec_command',
          {
            cmd: 'read -r first; printf "%s" "$first" > stdin-positive.txt; read -r second; printf "%s" "$second" > stdin-denied.txt',
            tty: true,
            yield_time_ms: 1000,
          },
          { callId: 'live-process' },
        ),
      ],
      () => {
        expect(processId).toBeTypeOf('number');
        return [
          call(
            'write_stdin',
            {
              session_id: processId!,
              chars: 'positive\n',
              yield_time_ms: 1000,
            },
            { callId: 'positive-stdin' },
          ),
        ];
      },
      () => [
        cell(`try { await tools.write_stdin(${JSON.stringify({ session_id: processId, chars: 'denied\n', yield_time_ms: 1000 })}); } catch { text('caught stdin denial'); }
await tools.exec_command({cmd:'printf escaped > stdin-continuation.txt'});`),
      ],
    ],
    {
      approval(info, value) {
        if (
          info.toolName === 'write_stdin' &&
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.chars === 'denied\n'
        ) {
          denied = info;
          return false;
        }
        return true;
      },
      transformResult(info, value) {
        if (info.toolName === 'exec_command') {
          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value)
          )
            throw new Error('Missing real process result');
          expect(value.session_id).toBeTypeOf('number');
          processId = value.session_id as number;
        }
        return value;
      },
    },
    { code: true },
  );
  const turn = await bounded(
    f.session.submit('Start, write once, then deny stdin from code.'),
    'submit stdin',
  );
  stopped(await bounded(observe(turn.wait()), 'stdin owner stop'));
  expect(denied?.call?.route).toBe('code');
  expect(denied?.submission).toBe(turn);
  expect(await contents(join(f.executor.cwd, 'stdin-positive.txt'))).toBe(
    'positive',
  );
  expect(await contents(join(f.executor.cwd, 'stdin-denied.txt'))).toBeNull();
  expect(
    await contents(join(f.executor.cwd, 'stdin-continuation.txt')),
  ).toBeNull();
  expect(
    f.executor.requests.filter((request) => request.method === 'process/write'),
  ).toHaveLength(1);
  expect(starts(f.executor.requests)).toHaveLength(1);
  expect(f.model.requests).toHaveLength(3);
  f.model.assertExhausted();
}, 45_000);

it('stops the exact generated child while its parent and sibling remain usable', async () => {
  let rootId: string | undefined;
  let stoppedId: string | undefined;
  const counts = new Map<string, number>();
  const approvals: ExecutorContext[] = [];
  const releaseParent = Promise.withResolvers<void>();
  const respond = async (request: JsonObject): Promise<JsonObject[]> => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId) {
      if (count > 1) {
        const outputs = Array.isArray(request.input) ? request.input : [];
        const output = outputs.find(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            item.type === 'function_call_output' &&
            item.call_id === `spawn-${count - 1}`,
        );
        expect(
          output,
          'Previous spawn must succeed before child admission',
        ).toMatchObject({
          output: expect.stringContaining('"task_name"'),
        });
      }
      if (count === 3) await releaseParent.promise;
      return count < 3
        ? [
            call(
              'spawn_agent',
              {
                task_name: `executor_child_${count}`,
                message: 'Run the selected command.',
              },
              { namespace: 'collaboration', callId: `spawn-${count}` },
            ),
          ]
        : [message('parent done')];
    }
    return count === 1
      ? [
          cell(
            `text(await tools.exec_command({cmd:${JSON.stringify(`printf child > child-${id}.txt`)}}));`,
            `child-cell-${id}`,
          ),
        ]
      : [message('sibling done')];
  };
  await using f = await open(
    Array.from({ length: 6 }, () => respond),
    {
      approval(info) {
        expect(info.call?.childId).toBeTypeOf('string');
        approvals.push(info);
        stoppedId ??= info.call!.childId!;
        return info.call!.childId === stoppedId
          ? stopExecutorTurn('private-child-reason')
          : true;
      },
    },
    { children: true, code: true },
  );
  try {
    const parent = await bounded(
      f.session.submit('Start two executor children.'),
      'submit children',
    );
    let parentFinished = false;
    const parentResult = observe(parent.wait()).finally(() => {
      parentFinished = true;
    });
    await Promise.race([
      vi.waitFor(() => expect(approvals).toHaveLength(2), {
        timeout: 10_000,
      }),
      parentResult.then((result) => {
        if (!result.ok) throw result.error;
        throw new Error('Parent finished before both child approvals');
      }),
    ]);
    const children = await bounded(
      Array.fromAsync(f.session.subagents()),
      'list children',
    );
    expect(children).toHaveLength(2);
    const selected = children.find((child) => child.id === stoppedId);
    const sibling = children.find((child) => child.id !== stoppedId);
    expect(selected?.turn).toBeDefined();
    expect(sibling?.turn).toBeDefined();
    stopped(await bounded(observe(selected!.turn!.wait()), 'child stop'));
    expect(
      approvals.find((info) => info.call?.childId === stoppedId)?.submission,
    ).toBe(selected!.turn);
    expect(
      approvals.find((info) => info.call?.childId === stoppedId)?.call?.route,
    ).toBe('code');
    expect(
      (await bounded(sibling!.turn!.wait(), 'sibling completion')).finalOutput,
    ).toBe('sibling done');
    expect(counts.get(stoppedId!)).toBe(1);
    expect(starts(f.executor.requests)).toHaveLength(1);
    expect(
      await contents(join(f.executor.cwd, `child-${stoppedId}.txt`)),
    ).toBeNull();
    expect(
      await contents(join(f.executor.cwd, `child-${sibling!.id}.txt`)),
    ).toBe('child');
    expect(
      JSON.stringify(
        await bounded(
          Array.fromAsync(selected!.turn!.events()),
          'child observations',
        ),
      ),
    ).not.toContain('private-child-reason');
    expect(parentFinished).toBe(false);
    releaseParent.resolve();
    const completedParent = await bounded(parentResult, 'parent completion');
    if (!completedParent.ok) throw completedParent.error;
    expect(completedParent.value.finalOutput).toBe('parent done');
    f.model.assertExhausted();
  } finally {
    releaseParent.resolve();
  }
}, 45_000);

it('rejects a cancelled late decision before a successor can dispatch once', async () => {
  const probe = cleanupProbe();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  probe.release.resolve();
  try {
    await using f = await open(
      [
        [
          cell(`const probe = tools.executor_cleanup_probe({}).catch(() => {});
await tools.exec_command({cmd:'printf stale > stale-denied.txt'}); await probe;`),
        ],
        [
          call(
            'exec_command',
            { cmd: 'printf successor > successor.txt' },
            { callId: 'successor-call' },
          ),
        ],
        [message('successor done')],
      ],
      {
        async approval() {
          if (calls++ === 0) {
            await probe.entered.promise;
            entered.resolve();
            await release.promise;
            return stopExecutorTurn('late-private-reason');
          }
          return true;
        },
      },
      { code: true, tools: [probe.gate] },
    );
    try {
      const old = await bounded(
        f.session.submit('Cancel before policy returns.'),
        'submit stale',
      );
      const result = observe(old.wait());
      await bounded(entered.promise, 'late policy entry');
      const cancelling = observe(old.cancel());
      await bounded(probe.cleaning.promise, 'observed original cancellation');
      expect((await probe.entered.promise).signal.aborted).toBe(true);
      release.resolve();
      const cancelled = await bounded(cancelling, 'cancel cleanup');
      if (!cancelled.ok) throw cancelled.error;
      const original = await bounded(result, 'original cancellation result');
      expect(original.ok).toBe(false);
      if (original.ok)
        throw new Error('Cancelled owner completed successfully');
      expect(original.error).toBeInstanceOf(TurnAborted);
      expect(f.model.requests).toHaveLength(1);
      expect(starts(f.executor.requests)).toHaveLength(0);
      const next = await bounded(
        f.session.submit('Use a fresh owner.'),
        'submit successor',
      );
      expect(
        (await bounded(next.wait(), 'successor completion')).finalOutput,
      ).toBe('successor done');
      expect(
        await contents(join(f.executor.cwd, 'stale-denied.txt')),
      ).toBeNull();
      expect(await contents(join(f.executor.cwd, 'successor.txt'))).toBe(
        'successor',
      );
      expect(starts(f.executor.requests)).toHaveLength(1);
      expect(calls).toBe(2);
      f.model.assertExhausted();
    } finally {
      release.resolve();
    }
  } finally {
    release.resolve();
    probe.release.resolve();
  }
}, 45_000);

it.each([
  ['cancel', 'ordinary sampling'],
  ['close', 'ordinary sampling'],
  ['cancel', 'automatic compaction'],
  ['close', 'automatic compaction'],
] as const)(
  'fences a direct result before native %s settles with %s',
  async (operation, continuation) => {
    const transformEntered = Promise.withResolvers<void>();
    const releaseTransform = Promise.withResolvers<void>();
    const settleEntered = Promise.withResolvers<void>();
    const releaseSettle = Promise.withResolvers<void>();
    const { NativeThread: Thread } = await binding();
    const requestStop = Thread.prototype._request_graph_stop;
    const closeSelectedEnvironment =
      Thread.prototype._close_selected_environment;
    const stop =
      operation === 'close'
        ? vi
            .spyOn(Thread.prototype, '_close_selected_environment')
            .mockImplementation(async function (this: NativeThread) {
              settleEntered.resolve();
              await releaseSettle.promise;
              return closeSelectedEnvironment.call(this);
            })
        : vi
            .spyOn(Thread.prototype, '_request_graph_stop')
            .mockImplementation(function (this: NativeThread, scope, mode) {
              const receipt = requestStop.call(this, scope, mode);
              const settle = receipt.settle.bind(receipt);
              vi.spyOn(receipt, 'settle').mockImplementation(async () => {
                settleEntered.resolve();
                await releaseSettle.promise;
                await settle();
              });
              return receipt;
            });
    try {
      await using f = await open(
        [
          [
            call(
              'exec_command',
              { cmd: 'printf direct-result' },
              { callId: 'held-direct-result' },
            ),
          ],
          [message('fresh root complete')],
        ],
        {
          async transformResult(context, value) {
            expect(context.callId).toBe('held-direct-result');
            expect(context.call?.route).toBe('direct');
            transformEntered.resolve();
            await releaseTransform.promise;
            return value;
          },
        },
        {
          usage:
            continuation === 'automatic compaction'
              ? {
                  input_tokens: 260_000,
                  output_tokens: 1_000,
                  total_tokens: 261_000,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                }
              : undefined,
        },
      );
      const followup = Promise.withResolvers<void>();
      f.model.onRecord = (phase) => {
        if (phase === 'MODEL_REQUEST' && f.model.requests.length > 1)
          followup.resolve();
      };
      const turn = await f.session.submit('Run the command.');
      const result = observe(turn.wait());
      let cancelling: ReturnType<typeof observe<void>> | undefined;
      let cancelled: Awaited<typeof cancelling>;
      try {
        await bounded(
          transformEntered.promise,
          'direct result transform entry',
        );
        cancelling = observe(
          operation === 'cancel' ? turn.cancel() : f.session.close(),
        );
        await bounded(settleEntered.promise, 'reserved native stop');
        releaseTransform.resolve();
        // The real native reservation is in place, but Core has not received
        // the interrupt. The denied callback reply can now reach the model loop.
        const sent = await Promise.race([
          followup.promise.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 1500),
          ),
        ]);
        expect(sent).toBe(false);
        expect(f.model.requests).toHaveLength(1);
      } finally {
        releaseTransform.resolve();
        releaseSettle.resolve();
        if (cancelling)
          cancelled = await bounded(cancelling, 'native cancellation');
      }
      if (cancelled && !cancelled.ok) throw cancelled.error;
      const interrupted = await bounded(result, 'original turn result');
      expect(interrupted.ok).toBe(false);
      if (interrupted.ok)
        throw new Error('Cancelled turn completed successfully');
      expect(interrupted.error).toBeInstanceOf(TurnAborted);
      if (operation === 'cancel' && continuation === 'ordinary sampling') {
        const next = await f.session.submit('Run a fresh turn.');
        expect(
          (await bounded(next.wait(), 'successor result')).finalOutput,
        ).toBe('fresh root complete');
        expect(f.model.requests).toHaveLength(2);
        f.model.assertExhausted();
      } else {
        expect(f.model.requests).toHaveLength(1);
      }
      expect(starts(f.executor.requests)).toHaveLength(1);
    } finally {
      stop.mockRestore();
    }
  },
  45_000,
);

it('validates raw action replacement data without granting stop authority', async () => {
  const replacement = {
    cmd: 'printf data > raw-action.txt',
    action: 'stop',
    nested: { action: 'stop' },
  };
  await using f = await open(
    [
      [
        call(
          'exec_command',
          { cmd: 'printf original > raw-original.txt' },
          { callId: 'raw-call' },
        ),
      ],
    ],
    {
      approval: () => true,
      transformArguments: () => replacement,
    },
  );
  const addon = await binding();
  const replies: JsonObject[] = [];
  const resolveReply =
    addon.NativeThread.prototype._resolve_native_interception;
  const spy = vi
    .spyOn(addon.NativeThread.prototype, '_resolve_native_interception')
    .mockImplementation(function (this: NativeThread, nonce, reply) {
      replies.push(JSON.parse(reply) as JsonObject);
      return resolveReply.call(this, nonce, reply);
    });
  try {
    const turn = await bounded(
      f.session.submit('Replace with raw argument data.'),
      'submit raw data',
    );
    const result = await bounded(observe(turn.wait()), 'raw data refusal');
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error('Invalid replacement unexpectedly completed');
    expect(result.error).toBeInstanceOf(NativeError);
    expect(String(result.error)).toContain(
      'Native executor rejected invalid arguments before dispatch',
    );
    expect(String(result.error)).not.toContain(
      'Turn stopped by executor policy',
    );
    expect(replies).toContainEqual({ action: 'replace', value: replacement });
    expect(starts(f.executor.requests)).toHaveLength(0);
    expect(await contents(join(f.executor.cwd, 'raw-action.txt'))).toBeNull();
    expect(await contents(join(f.executor.cwd, 'raw-original.txt'))).toBeNull();
    expect(f.model.requests).toHaveLength(1);
    f.model.assertExhausted();
  } finally {
    spy.mockRestore();
  }
}, 45_000);

it('keeps public completion pending until the real native stop finish is released', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let approvals = 0;
  await using f = await open(
    [
      [
        cell(`try { await tools.exec_command({cmd:'printf denied > finish-denied.txt'}); } catch { text('caught'); }
await tools.exec_command({cmd:'printf escaped > finish-continuation.txt'});`),
      ],
      [
        call(
          'exec_command',
          { cmd: 'printf successor > finish-successor.txt' },
          { callId: 'finish-successor' },
        ),
      ],
      [message('finish successor done')],
    ],
    {
      approval: () =>
        approvals++ === 0 ? stopExecutorTurn('private-finish-reason') : true,
    },
    { code: true },
  );
  const addon = await binding();
  const finish = addon._NativePolicyStop.prototype.finish;
  const spy = vi
    .spyOn(addon._NativePolicyStop.prototype, 'finish')
    .mockImplementation(async function (
      this: NonNullable<
        ReturnType<NativeThread['_hold_native_interception_for_stop']>
      >,
    ) {
      // Preserve real native fencing, cancellation and cell retirement.
      await finish.call(this);
      entered.resolve();
      await release.promise;
    });
  let cleanup: Promise<unknown> | undefined;
  try {
    const turn = await bounded(
      f.session.submit('Stop and join the native receipt.'),
      'submit held finish',
    );
    let settled = false;
    const result = observe(turn.wait()).finally(() => {
      settled = true;
    });
    cleanup = result;
    await bounded(
      Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error('Public turn settled before the native finish gate');
        }),
      ]),
      'real native finish gate',
    );
    expect(settled).toBe(false);
    expect(starts(f.executor.requests)).toHaveLength(0);
    expect(
      await contents(join(f.executor.cwd, 'finish-denied.txt')),
    ).toBeNull();
    expect(
      await contents(join(f.executor.cwd, 'finish-continuation.txt')),
    ).toBeNull();
    expect(f.model.requests).toHaveLength(1);
    release.resolve();
    stopped(await bounded(result, 'released native finish'));
    expect(settled).toBe(true);
    const next = await bounded(
      f.session.submit('Run a fresh owner after retirement.'),
      'submit finish successor',
    );
    expect((await bounded(next.wait(), 'finish successor')).finalOutput).toBe(
      'finish successor done',
    );
    expect(await contents(join(f.executor.cwd, 'finish-successor.txt'))).toBe(
      'successor',
    );
    expect(
      await contents(join(f.executor.cwd, 'finish-denied.txt')),
    ).toBeNull();
    expect(
      await contents(join(f.executor.cwd, 'finish-continuation.txt')),
    ).toBeNull();
    expect(starts(f.executor.requests)).toHaveLength(1);
    f.model.assertExhausted();
  } finally {
    release.resolve();
    try {
      if (cleanup) await bounded(cleanup, 'held finish cleanup');
    } finally {
      spy.mockRestore();
    }
  }
}, 45_000);

// This is an accepted-steering schedule, not an assertion about an unobservable
// Core queue. Turn.steer acknowledges admission. ModelServer cannot freeze that
// queue at InterruptIfNoPendingInput's check, nor force a real held-stop refusal.
// Exact pending-mailbox/refusal coverage still needs an owned native fixture gate;
// neither an unconditional null mock nor a successful acknowledgement proves it.
it('keeps accepted steering before stop fail-closed and preserves a later owner', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeFinished = Promise.withResolvers<void>();
  let approvals = 0;
  await using f = await open(
    [
      [
        cell(`try { await tools.exec_command({cmd:'printf denied > steering-denied.txt'}); } catch { text('caught'); }
await tools.exec_command({cmd:'printf escaped > steering-continuation.txt'});`),
      ],
      [
        call(
          'exec_command',
          { cmd: 'printf successor > steering-successor.txt' },
          { callId: 'steering-successor' },
        ),
      ],
      [message('steering successor done')],
    ],
    {
      async approval() {
        if (approvals++ === 0) {
          entered.resolve();
          await release.promise;
          return stopExecutorTurn('private-steering-reason');
        }
        return true;
      },
    },
    { code: true },
  );
  const addon = await binding();
  const hold = addon.NativeThread.prototype._hold_native_interception_for_stop;
  const finish = addon._NativePolicyStop.prototype.finish;
  const claims: boolean[] = [];
  let finishResult: { ok: true } | { ok: false; error: unknown } | undefined;
  const holdSpy = vi
    .spyOn(addon.NativeThread.prototype, '_hold_native_interception_for_stop')
    .mockImplementation(function (this: NativeThread, nonce) {
      const receipt = hold.call(this, nonce);
      claims.push(receipt !== null);
      return receipt;
    });
  const finishSpy = vi
    .spyOn(addon._NativePolicyStop.prototype, 'finish')
    .mockImplementation(async function (
      this: NonNullable<
        ReturnType<NativeThread['_hold_native_interception_for_stop']>
      >,
    ) {
      try {
        await finish.call(this);
        finishResult = { ok: true };
      } catch (error) {
        finishResult = { ok: false, error };
        throw error;
      } finally {
        nativeFinished.resolve();
      }
    });
  try {
    const turn = await bounded(
      f.session.submit('Hold approval, accept steering, then stop.'),
      'submit steering',
    );
    const result = observe(turn.wait());
    try {
      await bounded(entered.promise, 'held executor approval');
      await bounded(
        turn.steer('accepted executor-stop steering input'),
        'accepted steering',
      );
      expect(f.model.requests).toHaveLength(1);
      release.resolve();
      const outcome = await bounded(result, 'steered stop outcome');
      expect(outcome.ok).toBe(false);
      if (outcome.ok)
        throw new Error(
          'Steered denied executor owner reported successful completion',
        );
      expect(outcome.error).toBeInstanceOf(Error);
      if (claims.includes(true)) {
        await bounded(nativeFinished.promise, 'steered native finish');
        if (finishResult?.ok) stopped(outcome);
        else {
          // A rejected native finish cannot masquerade as a joined policy stop.
          expect(finishResult?.ok).toBe(false);
          expect((outcome.error as Error).message).not.toBe(
            'Turn stopped by executor policy',
          );
        }
      } else {
        // No accepted receipt means there is no successful native stop to report.
        expect((outcome.error as Error).message).not.toBe(
          'Turn stopped by executor policy',
        );
        expect(finishResult).toBeUndefined();
      }
      expect(starts(f.executor.requests)).toHaveLength(0);
      expect(
        await contents(join(f.executor.cwd, 'steering-denied.txt')),
      ).toBeNull();
      expect(
        await contents(join(f.executor.cwd, 'steering-continuation.txt')),
      ).toBeNull();
      expect(f.model.requests).toHaveLength(1);
      const next = await bounded(
        f.session.submit('Use the successor after steering and stop.'),
        'submit steering successor',
      );
      expect(
        (await bounded(next.wait(), 'steering successor')).finalOutput,
      ).toBe('steering successor done');
      // Accepted steering survives the stopped task exactly once in the next
      // request's real history.
      expect(
        JSON.stringify(f.model.requests[1]?.input)?.split(
          'accepted executor-stop steering input',
        ),
      ).toHaveLength(2);
      expect(
        await contents(join(f.executor.cwd, 'steering-successor.txt')),
      ).toBe('successor');
      expect(
        await contents(join(f.executor.cwd, 'steering-continuation.txt')),
      ).toBeNull();
      expect(starts(f.executor.requests)).toHaveLength(1);
      f.model.assertExhausted();
    } finally {
      release.resolve();
      await bounded(result, 'steering result cleanup');
    }
  } finally {
    release.resolve();
    finishSpy.mockRestore();
    holdSpy.mockRestore();
  }
}, 45_000);
