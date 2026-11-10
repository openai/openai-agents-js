import { NativeSessionVoiceWorkflow } from '../../src/voice';
import { afterEach, expect, it, vi } from 'vitest';
import { FunctionAdmission } from '../../src/runtime/function-admission';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  isFunctionApprovalRequest,
  parseSessionState,
  manualTool,
  type Session,
  ToolOutput,
  tool,
  type FunctionApprovalRequest,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-function-approval',
    supportsWebsockets: false,
  });
}

async function nextApproval(session: {
  interactions(): AsyncIterable<unknown>;
}): Promise<FunctionApprovalRequest> {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw new Error('The native turn ended before its approval arrived');
}

it.each([true, false])(
  'gates callback effects and consumes the exact decision (approve=%s)',
  async (approve) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: ({ value }) => {
        effects.push(value);
        return 'accepted-' + value;
      },
    });
    const server = new ModelServer([
      [call('risky', { value: 'A' }, { callId: 'approval-A' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use the tool.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    });
    await using session = await agent.session();
    await using foreign = await agent.session();
    const turn = await session.submit('begin');
    const request = await nextApproval(session);
    expect(request.callId).toBe('approval-A');
    expect(request.turnId).toBe(turn.turnId);
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(1);
    const reply = approve
      ? request.approve()
      : request.reject('explicit denial');
    await expect(foreign.respond(reply)).rejects.toThrow();
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toEqual(approve ? ['A'] : []);
    server.assertExhausted();
  },
);

it('runs a false predicate automatically without an interaction handler', async () => {
  const calls: string[] = [];
  const safe = tool({
    name: 'safe',
    parameters: z.object({ value: z.string() }),
    needsApproval: async (context) => {
      calls.push('policy:' + context.effectiveArguments.value);
      return false;
    },
    execute: ({ value }) => {
      calls.push('body:' + value);
      return value;
    },
  });
  const server = new ModelServer([
    [call('safe', { value: 'A' }, { callId: 'safe-A' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const result = await new Agent({
    instructions: 'Use the tool.',
    model: 'gpt-5',
    provider,
    tools: [safe],
  }).run('begin');
  expect(result.finalOutput).toBe('done');
  expect(calls).toEqual(['policy:A', 'body:A']);
  server.assertExhausted();
});

it('exports a required one-shot approval before callback effects', async () => {
  const effects: string[] = [];
  const risky = tool({
    name: 'risky',
    parameters: z.object({ value: z.string() }),
    needsApproval: true,
    execute: ({ value }) => {
      effects.push(value);
      return value;
    },
  });
  const server = new ModelServer([
    [call('risky', { value: 'A' }, { callId: 'one-shot-approval' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use the tool.',
    model: 'gpt-5',
    provider,
    tools: [risky],
  });
  const interrupted = await agent.run('begin').catch((error: unknown) => error);
  expect(interrupted).toBeInstanceOf(InteractionRequired);
  if (!(interrupted instanceof InteractionRequired) || !interrupted.state)
    throw new Error('Required approval did not export its native continuation');
  expect(effects).toEqual([]);
  await using restored = await agent.session({ state: interrupted.state });
  const request = await nextApproval(restored);
  expect(request.callId).toBe('one-shot-approval');
  await restored.respond(request.approve());
  expect((await restored.restoredTurn!.wait()).finalOutput).toBe('done');
  expect(effects).toEqual(['A']);
  server.assertExhausted();
});

it.each([false, true])(
  'rechecks input policies and exposes effective arguments (before approval=%s)',
  async (runBeforeApproval) => {
    const calls: string[] = [];
    const increment = tool({
      name: 'increment',
      parameters: z.object({ value: z.number() }),
      runBeforeApproval,
      needsApproval: (context) => {
        calls.push('policy:' + context.effectiveArguments.value);
        return true;
      },
      before: (context) => {
        const value = context.effectiveArguments.value as number;
        calls.push('before:' + value);
        return { action: 'replaceArguments', arguments: { value: value + 1 } };
      },
      execute: ({ value }, context) => {
        expect(context.originalArguments).toEqual({ value: 1 });
        calls.push('body:' + value);
        return String(value);
      },
    });
    const server = new ModelServer([
      [call('increment', { value: 1 }, { callId: 'increment-A' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use the tool.',
      model: 'gpt-5',
      provider,
      tools: [increment],
    }).session();
    const turn = await session.submit('begin');
    const request = await nextApproval(session);
    expect(request.arguments).toEqual({ value: 1 });
    expect(request.effectiveArguments).toEqual({
      value: runBeforeApproval ? 2 : 1,
    });
    (request.effectiveArguments as { value: number }).value = 99;
    expect(request.effectiveArguments).toEqual({
      value: runBeforeApproval ? 2 : 1,
    });
    expect(calls.some((entry) => entry.startsWith('body:'))).toBe(false);
    await session.respond(request.approve());
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(calls).toEqual(
      runBeforeApproval
        ? ['before:1', 'policy:2', 'before:2', 'body:3']
        : ['policy:1', 'before:1', 'body:2'],
    );
    server.assertExhausted();
  },
);

it.each([true, false])(
  'scopes remembered decisions to one Session and binding (approve=%s)',
  async (approve) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    const server = new ModelServer([
      [call('risky', { value: '0' }, { callId: 'cached-0' })],
      [message('done')],
      [call('risky', { value: '1' }, { callId: 'cached-1' })],
      [message('done')],
      [call('risky', { value: 'new' }, { callId: 'new-session' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use the tool.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    });
    {
      await using session = await agent.session();
      for (let i = 0; i < 2; i++) {
        const turn = await session.submit('begin');
        if (i === 0) {
          const request = await nextApproval(session);
          await session.respond(
            approve
              ? request.approve({ always: true })
              : request.reject(undefined, { always: true }),
          );
        }
        expect((await turn.wait()).finalOutput).toBe('done');
        expect(await session.pendingInteractions()).toEqual([]);
      }
    }
    await using fresh = await agent.session();
    const turn = await fresh.submit('begin');
    const request = await nextApproval(fresh);
    await fresh.respond(request.reject());
    await turn.wait();
    expect(effects).toEqual(approve ? ['0', '1'] : []);
    server.assertExhausted();
  },
);

it('denies input before approval without running its predicate, body or output policy', async () => {
  const calls: string[] = [];
  const risky = tool({
    name: 'risky',
    parameters: z.object({ value: z.string() }),
    runBeforeApproval: true,
    needsApproval: () => {
      calls.push('policy');
      return true;
    },
    before: () => {
      calls.push('before');
      return { action: 'deny', reason: 'input denied' };
    },
    execute: ({ value }) => {
      calls.push('body');
      return value;
    },
    after: (output) => {
      calls.push('after');
      return output;
    },
  });
  const server = new ModelServer([
    [call('risky', { value: 'A' }, { callId: 'denied-input' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the tool.',
    model: 'gpt-5',
    provider,
    tools: [risky],
  }).session();
  expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
    'done',
  );
  expect(calls).toEqual(['before']);
  server.assertExhausted();
});

it('joins physical callback cleanup after approving and cancelling a native call', async () => {
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hold = tool({
    name: 'hold',
    parameters: z.object({}),
    needsApproval: true,
    execute: async (_, context) => {
      entered.resolve();
      try {
        await new Promise<void>((_, reject) =>
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          ),
        );
      } finally {
        cleaning.resolve();
        await release.promise;
      }
      return 'unreachable';
    },
  });
  const server = new ModelServer([
    [call('hold', {}, { callId: 'held-approval' })],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the tool.',
    model: 'gpt-5',
    provider,
    tools: [hold],
  }).session();
  const turn = await session.submit('begin');
  const request = await nextApproval(session);
  await session.respond(request.approve());
  await entered.promise;
  let finished = false;
  const cancellation = turn.cancel().then(() => {
    finished = true;
  });
  try {
    await cleaning.promise;
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
  await cancellation;
  await expect(turn.wait()).rejects.toThrow();
  expect(() => request.approve()).toThrow();
});

it.each([
  { approve: true, guarded: false },
  { approve: false, guarded: false },
  { approve: true, guarded: true },
  { approve: false, guarded: true },
])(
  'restores required approval and accepted siblings in a fresh process (approve=$approve, guarded=$guarded)',
  async ({ approve, guarded }) => {
    const { mkdtemp, writeFile, readFile, rm } =
      await import('node:fs/promises');
    const { appendFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const directory = await mkdtemp(join(tmpdir(), 'native-approval-'));
    const effectsPath = join(directory, 'effects.txt');
    await writeFile(effectsPath, '');
    const risky = tool({
      name: 'risky',
      description: 'Synthetic effect',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      runBeforeApproval: guarded,
      before: guarded
        ? (context) => ({
            action: 'replaceArguments',
            arguments: {
              value: String(context.effectiveArguments.value) + '-pre',
            },
          })
        : undefined,
      execute: ({ value }) => {
        appendFileSync(effectsPath, 'risky\n');
        return 'accepted-' + value;
      },
    });
    const accepted = tool({
      name: 'accepted',
      description: 'Accepted sibling',
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        appendFileSync(effectsPath, 'accepted\n');
        return 'sibling-' + value;
      },
    });
    const server = new ModelServer([
      [
        call('accepted', { value: 'A' }, { callId: 'accepted-sibling' }),
        call('risky', { value: 'B' }, { callId: 'pending-approval' }),
      ],
      [message('resumed')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use both tools.',
      model: 'gpt-5',
      provider,
      tools: [accepted, risky],
    });
    try {
      let turnId: string;
      {
        await using source = await agent.session();
        const turn = await source.submit('begin');
        turnId = turn.turnId;
        const old = await nextApproval(source);
        const saved = await source.suspend();
        expect(await readFile(effectsPath, 'utf8')).toBe('accepted\n');
        expect(() => old.approve()).toThrow();
        await writeFile(join(directory, 'state.json'), JSON.stringify(saved));
      }
      const config = await server.config();
      const baseUrl = (
        config['model_providers.fixture'] as { base_url: string }
      ).base_url;
      const fixture = new URL(
        './fixtures/managed-approval-restore.ts',
        import.meta.url,
      );
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fixture.pathname,
          join(directory, 'state.json'),
          effectsPath,
          baseUrl,
          approve ? 'approve' : 'reject',
          turnId,
          guarded ? 'guarded' : 'plain',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (value) => {
        stdout += value;
      });
      child.stderr.on('data', (value) => {
        stderr += value;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', resolve);
      });
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).effects).toEqual(
        approve ? ['accepted', 'risky'] : ['accepted'],
      );
      expect(server.requests).toHaveLength(2);
      const outputs = server.requests[1].input as {
        type: string;
        call_id?: string;
        output?: unknown;
      }[];
      expect(
        JSON.stringify(
          outputs.find(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'accepted-sibling',
          )?.output,
        ),
      ).toContain('sibling-A');
      expect(
        JSON.stringify(
          outputs.find(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'pending-approval',
          )?.output,
        ),
      ).toContain(
        approve
          ? guarded
            ? 'accepted-B-pre-post'
            : 'accepted-B'
          : 'restored rejection',
      );
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

it('does not apply remembered approval to another admitted Agent callback with the same schema', async () => {
  const effects: string[] = [];
  const declaration = (label: string) =>
    tool({
      name: 'risky',
      description: 'Same declaration schema',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: ({ value }) => {
        effects.push(label);
        return value;
      },
    });
  const first = declaration('old'),
    second = declaration('new');
  const server = new ModelServer([
    [call('risky', { value: 'A' }, { callId: 'old-binding' })],
    [message('done')],
    [call('risky', { value: 'B' }, { callId: 'new-binding' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const options = { instructions: 'Use the tool.', model: 'gpt-5', provider };
  const other = new Agent({ ...options, name: 'other', tools: [second] });
  await using session = await new Agent({
    ...options,
    tools: [first],
    handoffs: [other],
  }).session();
  const old = await session.submit('first');
  await session.respond(
    (await nextApproval(session)).approve({ always: true }),
  );
  await old.wait();
  await session.update({ agent: other });
  const current = await session.submit('second');
  const request = await nextApproval(session);
  expect(effects).toEqual(['old']);
  await session.respond(request.approve());
  await current.wait();
  expect(effects).toEqual(['old', 'new']);
  server.assertExhausted();
});

it('preserves a terminal callback without an extra model step', async () => {
  const finish = tool({
    name: 'finish',
    parameters: z.object({ value: z.string() }),
    needsApproval: true,
    finishTurn: true,
    execute: ({ value }) => 'finished-' + value,
  });
  const server = new ModelServer([
    [call('finish', { value: 'A' }, { callId: 'terminal-approval' })],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the tool.',
    model: 'gpt-5',
    provider,
    tools: [finish],
  }).session();
  const turn = await session.submit('begin');
  await session.respond((await nextApproval(session)).approve());
  expect((await turn.wait()).finalOutput).toBe('finished-A');
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

it.each([false, true])(
  'preserves raw input for schema transforms (replacement=%s)',
  async (replaceInput) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({
        value: z.string().transform((value) => value + '!'),
      }),
      needsApproval: true,
      runBeforeApproval: replaceInput,
      before: replaceInput
        ? () => ({
            action: 'replaceArguments',
            arguments: { value: 'replacement' },
          })
        : undefined,
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    const server = new ModelServer([
      [call('risky', { value: 'original' }, { callId: 'transform' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    }).session();
    const turn = await session.submit('begin');
    const request = await nextApproval(session);
    const expected = replaceInput ? 'replacement!' : 'original!';
    expect(request.effectiveArguments).toEqual({ value: expected });
    await session.respond(request.approve());
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toEqual([expected]);
    server.assertExhausted();
  },
);

it.each(['approved', 'automatic', 'rejected'])(
  'balances managed call observations (%s)',
  async (mode) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: mode === 'automatic' ? () => false : true,
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    const server = new ModelServer([
      [call('risky', { value: 'A' }, { callId: 'observed-approval' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    }).session();
    const turn = await session.submit('begin');
    if (mode !== 'automatic') {
      const request = await nextApproval(session);
      expect(effects).toEqual([]);
      await session.respond(
        mode === 'approved' ? request.approve() : request.reject('denied'),
      );
    }
    expect((await turn.wait()).finalOutput).toBe('done');
    const facts: string[] = [];
    for await (const event of turn.events())
      if (
        (event.type === 'tool_started' || event.type === 'tool_finished') &&
        event.callId === 'observed-approval'
      )
        facts.push(event.type);
    expect(facts).toEqual(['tool_started', 'tool_finished']);
    expect(effects).toEqual(mode === 'rejected' ? [] : ['A']);
    server.assertExhausted();
  },
);

it.each([false, true])(
  'admits managed approvals through a voice workflow tool ceiling (explicit=%s)',
  async (explicit) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    const server = new ModelServer([
      [call('risky', { value: 'A' }, { callId: 'voice-workflow' })],
      [message('spoken output')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    }).session();
    const workflow = new NativeSessionVoiceWorkflow(
      session,
      explicit ? [risky] : undefined,
    );
    const output = (async () => {
      const words: string[] = [];
      for await (const text of workflow.run('begin')) words.push(text);
      return words;
    })();
    const request = await Promise.race([
      nextApproval(session),
      output.then(() => {
        throw new Error('Voice completed before its required approval');
      }),
    ]);
    expect(effects).toEqual([]);
    await session.respond(request.approve());
    expect(await output).toEqual(['spoken output']);
    expect(effects).toEqual(['A']);
    server.assertExhausted();
  },
);

it.each(['predicate', 'before'])(
  'rejects callback self-close during managed preparation (%s)',
  async (phase) => {
    const prevented: string[] = [];
    const checkClose = async () => {
      await Promise.resolve();
      await expect(async () => session.close()).rejects.toThrow(
        /callback|own session/,
      );
      prevented.push(phase);
    };
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => {
        if (phase === 'predicate') await checkClose();
        return false;
      },
      runBeforeApproval: phase === 'before',
      before:
        phase === 'before'
          ? async () => {
              await checkClose();
              return { action: 'allow' as const };
            }
          : undefined,
      execute: ({ value }) => value,
    });
    const server = new ModelServer([
      [call('risky', { value: 'A' }, { callId: 'self-close' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    }).session({ maxFunctionConcurrency: 1 });
    expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
      'done',
    );
    expect(prevented).toEqual(phase === 'before' ? [phase, phase] : [phase]);
    server.assertExhausted();
  },
);

it.each([1, 2])(
  'shares function admission before managed validators/hooks and releases before approval (limit=%s)',
  async (limit) => {
    const validated: number[] = [],
      guards: number[] = [],
      policies: number[] = [],
      effects: number[] = [];
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      allPrepared = Promise.withResolvers<void>(),
      queued = Promise.withResolvers<void>();
    let attempts = 0;
    const acquire = FunctionAdmission.prototype.acquire;
    const admissionSpy = vi
      .spyOn(FunctionAdmission.prototype, 'acquire')
      .mockImplementation(function (
        this: FunctionAdmission,
        signal: AbortSignal,
      ) {
        const pending = acquire.call(this, signal);
        if (++attempts === 3) queued.resolve();
        return pending;
      });
    const risky = tool({
      name: 'risky',
      parameters: z.object({
        value: z.number().transform((value) => {
          validated.push(value);
          return value;
        }),
      }),
      needsApproval: (context) => {
        policies.push(Number(context.effectiveArguments.value));
        if (policies.length === 3) allPrepared.resolve();
        return true;
      },
      runBeforeApproval: true,
      before: async (context) => {
        guards.push(Number(context.originalArguments.value));
        if (guards.length === limit) entered.resolve();
        await release.promise;
        return { action: 'allow' as const };
      },
      execute: ({ value }) => {
        effects.push(value);
        return String(value);
      },
    });
    const server = new ModelServer([
      [
        ...Array.from({ length: 3 }, (_, i) =>
          call('risky', { value: i }, { callId: 'admission-' + i }),
        ),
      ],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    }).session({ maxFunctionConcurrency: limit });
    try {
      const turn = await session.submit('begin');
      await entered.promise;
      await queued.promise;
      expect(guards).toHaveLength(limit);
      expect(new Set(validated)).toEqual(new Set(guards));
      expect(policies).toEqual([]);
      release.resolve();
      await allPrepared.promise;
      expect([...policies].sort()).toEqual([0, 1, 2]);
      expect(effects).toEqual([]);
      let decided = 0;
      for await (const request of session.interactions()) {
        if (!isFunctionApprovalRequest(request)) continue;
        await session.respond(request.approve());
        if (++decided === 3) break;
      }
      expect((await turn.wait()).finalOutput).toBe('done');
      expect(effects.sort()).toEqual([0, 1, 2]);
      server.assertExhausted();
    } finally {
      release.resolve();
      admissionSpy.mockRestore();
    }
  },
);

it.each(['date', 'function'] as const)(
  'preserves opaque schema transforms through managed approval (%s)',
  async (kind) => {
    for (const required of [false, true]) {
      const raw = '2026-11-01T12:00:00.000Z';
      const effects: string[] = [];
      const risky = tool({
        name: 'risky',
        parameters: z.object({
          value: z
            .string()
            .transform((value) =>
              kind === 'date' ? new Date(value) : () => value,
            ),
        }),
        needsApproval: required ? true : () => false,
        execute: ({ value }) => {
          const output =
            typeof value === 'function' ? value() : value.toISOString();
          effects.push(output);
          return output;
        },
      });
      const server = new ModelServer([
        [call('risky', { value: raw }, { callId: 'opaque-input' })],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Use risky.',
        model: 'gpt-5',
        provider,
        tools: [risky],
      }).session();
      const turn = await session.submit('begin');
      const completion = turn.wait();
      void completion.catch(() => {});
      if (required) {
        const request = await Promise.race([
          nextApproval(session),
          completion.then(() => {
            throw new Error('Approval missing');
          }),
        ]);
        const value = (
          request.effectiveArguments as { value: Date | (() => string) }
        ).value;
        if (typeof value === 'function') expect(value()).toBe(raw);
        else {
          expect(value.toISOString()).toBe(raw);
          value.setUTCFullYear(2000);
          expect(
            (request.effectiveArguments as { value: Date }).value.toISOString(),
          ).toBe(raw);
        }
        await session.respond(request.approve());
      }
      expect((await completion).finalOutput).toBe('done');
      expect(effects).toEqual([raw]);
      server.assertExhausted();
    }
  },
);

it.each([
  { restore: false, sibling: false },
  { restore: true, sibling: false },
  { restore: false, sibling: true },
  { restore: true, sibling: true },
])(
  'finishes an approved terminal function without another sample (restored=$restore, sibling=$sibling)',
  async ({ restore, sibling }) => {
    const effects: string[] = [];
    const acceptedEffects: string[] = [];
    const accepted = tool({
      name: 'accepted',
      parameters: z.object({}),
      execute: () => {
        acceptedEffects.push('accepted');
        return 'sibling result';
      },
    });
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      finishTurn: true,
      execute: ({ value }) => {
        effects.push(value);
        return 'terminal result';
      },
    });
    const server = new ModelServer([
      [
        ...(sibling
          ? [call('accepted', {}, { callId: 'accepted-sibling' })]
          : []),
        call('risky', { value: 'A' }, { callId: 'terminal-approval' }),
      ],
      [message('unexpected model continuation')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [accepted, risky],
    });
    let result;
    if (restore) {
      let saved;
      {
        await using source = await agent.session();
        await source.submit('begin');
        await nextApproval(source);
        saved = await source.suspend();
      }
      await using session = await agent.session({ state: saved });
      const request = await nextApproval(session);
      await session.respond(request.approve());
      result = await session.restoredTurn!.wait();
    } else {
      await using session = await agent.session();
      const turn = await session.submit('begin');
      const request = await nextApproval(session);
      await session.respond(request.approve());
      result = await turn.wait();
    }
    expect(result.finalOutput).toBe('terminal result');
    expect(result.toolCall?.callId).toBe('terminal-approval');
    expect(effects).toEqual(['A']);
    expect(acceptedEffects).toEqual(sibling ? ['accepted'] : []);
    expect(server.requests).toHaveLength(1);
  },
);

it('keeps portable JSON separate from mutating managed transforms', async () => {
  const originals: number[] = [],
    effects: number[] = [];
  const risky = tool({
    name: 'risky',
    parameters: z.object({
      payload: z.unknown().transform((input) => {
        const value = input as { value: number };
        value.value++;
        return value;
      }),
    }),
    needsApproval: (context) => {
      originals.push(
        (context.originalArguments.payload as { value: number }).value,
      );
      return false;
    },
    execute: ({ payload }, context) => {
      originals.push(
        (context.originalArguments.payload as { value: number }).value,
      );
      effects.push(payload.value);
      return String(payload.value);
    },
  });
  const server = new ModelServer([
    [call('risky', { payload: { value: 1 } }, { callId: 'mutating-input' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use risky.',
    model: 'gpt-5',
    provider,
    tools: [risky],
  }).session();
  expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
    'done',
  );
  expect(originals).toEqual([1, 1]);
  expect(effects).toEqual([2]);
  server.assertExhausted();
});

it('rejects a foreign response observation before restoring approval effects', async () => {
  const effects: string[] = [];
  const risky = tool({
    name: 'risky',
    parameters: z.object({}),
    needsApproval: true,
    finishTurn: true,
    execute: () => {
      effects.push('effect');
      return 'terminal result';
    },
  });
  const server = new ModelServer([
    [call('risky', {}, { callId: 'foreign-observation' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use risky.',
    model: 'gpt-5',
    provider,
    tools: [risky],
  });
  let saved;
  {
    await using source = await agent.session();
    await source.submit('begin');
    await nextApproval(source);
    saved = await source.suspend();
  }
  const forged = JSON.parse(JSON.stringify(saved)) as {
    history: { type: string; payload: { thread_id?: string } }[];
  };
  const observation = forged.history.find(
    (item) => item.type === 'response_observation_record',
  );
  expect(observation).toBeDefined();
  observation!.payload.thread_id = '00000000-0000-4000-8000-000000000001';
  const outcome = await agent
    .session({ state: parseSessionState(JSON.stringify(forged)) })
    .then(
      async (session) => {
        await session.close();
        return undefined;
      },
      (error: unknown) => error,
    );
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toMatch(/foreign.*observation/i);
  expect(effects).toEqual([]);
  expect(server.requests).toHaveLength(1);
});

it.each([false, true])(
  'settles a pending manual sibling before approved terminal completion (restored=%s)',
  async (restored) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({}),
      needsApproval: true,
      finishTurn: true,
      execute: () => {
        effects.push('effect');
        return 'terminal result';
      },
    });
    const review = manualTool({
      name: 'review',
      description: 'Review.',
      parameters: z.object({}),
      result: z.string(),
    });
    async function nextManual(session: Session) {
      for await (const event of session.interactions()) {
        const request = review.match(event);
        if (request) return request;
      }
      throw new Error('Missing pending manual sibling');
    }
    const server = new ModelServer([
      [
        call('risky', {}, { callId: 'approved-terminal' }),
        call('review', {}, { callId: 'manual-sibling' }),
      ],
      [message('unexpected model continuation')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use both.',
      model: 'gpt-5',
      provider,
      tools: [risky, review],
    });
    let state;
    if (restored) {
      await using source = await agent.session();
      await source.submit('begin');
      await nextApproval(source);
      await nextManual(source);
      state = await source.suspend();
    }
    await using session = await agent.session({ state });
    const turn = restored
      ? session.restoredTurn!
      : await session.submit('begin');
    const approval = await nextApproval(session);
    const manual = await nextManual(session);
    let settled = false;
    const completion = turn.wait().finally(() => {
      settled = true;
    });
    await session.respond(approval.approve());
    expect(settled).toBe(false);
    await session.respond(manual.reply('accepted manual sibling'));
    const result = await completion;
    expect(result.finalOutput).toBe('terminal result');
    expect(result.toolCall?.callId).toBe('approved-terminal');
    expect(effects).toEqual(['effect']);
    expect(server.requests).toHaveLength(1);
  },
);

it.each([false, true])(
  'retains a completed search sibling for approved terminal completion (restored=%s)',
  async (restored) => {
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({}),
      needsApproval: true,
      finishTurn: true,
      execute: () => {
        effects.push('effect');
        return 'terminal result';
      },
    });
    const spare = tool({
      name: 'spare',
      parameters: z.object({}),
      deferLoading: true,
      execute: () => 'unused',
    });
    const server = new ModelServer([
      [
        {
          type: 'tool_search_call',
          call_id: 'search-sibling',
          execution: 'client',
          arguments: { query: 'spare', limit: 5 },
        },
        call('risky', {}, { callId: 'approved-terminal' }),
      ],
      [message('unexpected model continuation')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use both.',
      model: 'gpt-5.5',
      programmaticToolCalling: false,
      provider,
      tools: [risky, spare],
    });
    let state;
    if (restored) {
      await using source = await agent.session();
      await source.submit('begin');
      await nextApproval(source);
      state = await source.suspend();
      expect(JSON.stringify(state)).toContain('tool_search_output');
    }
    await using session = await agent.session({ state });
    const turn = restored
      ? session.restoredTurn!
      : await session.submit('begin');
    const approval = await nextApproval(session);
    const completion = turn.wait();
    await session.respond(approval.approve());
    const result = await completion;
    expect(result.finalOutput).toBe('terminal result');
    expect(result.toolCall?.callId).toBe('approved-terminal');
    expect(effects).toEqual(['effect']);
    expect(server.requests).toHaveLength(1);
  },
);

it.each([
  { automatic: false, rich: false },
  { automatic: true, rich: false },
  { automatic: false, rich: true },
  { automatic: true, rich: true },
])(
  'preserves non-JSON callback result validators (automatic=$automatic, rich=$rich)',
  async ({ automatic, rich }) => {
    const returned = rich
      ? new ToolOutput([{ type: 'inputText', text: 'validated result' }], true)
      : 'validated result';
    const validated: unknown[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({}),
      needsApproval: automatic ? () => false : true,
      result: z
        .union([z.string(), z.instanceof(ToolOutput)])
        .refine((value) => {
          validated.push(value);
          return true;
        }),
      execute: () => returned,
    });
    const server = new ModelServer([
      [call('risky', {}, { callId: 'rich-result' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use risky.',
      model: 'gpt-5',
      provider,
      tools: [risky],
    }).session();
    const turn = await session.submit('begin');
    if (!automatic)
      await session.respond((await nextApproval(session)).approve());
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(validated).toHaveLength(1);
    expect(validated[0]).toBe(returned);
    expect(JSON.stringify(server.requests[1])).toContain('validated result');
  },
);

it('rejects computer history substituted for a managed function approval', async () => {
  const effects: string[] = [];
  const risky = tool({
    name: 'risky',
    parameters: z.object({}),
    needsApproval: true,
    finishTurn: true,
    execute: () => {
      effects.push('effect');
      return 'terminal result';
    },
  });
  const server = new ModelServer([
    [call('risky', {}, { callId: 'foreign-observation' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use risky.',
    model: 'gpt-5',
    provider,
    tools: [risky],
  });
  let saved;
  {
    await using source = await agent.session();
    await source.submit('begin');
    await nextApproval(source);
    saved = await source.suspend();
  }
  const forged = JSON.parse(JSON.stringify(saved)) as {
    history: { type: string; payload: Record<string, unknown> }[];
  };
  const original = forged.history.find(
    (item) =>
      item.type === 'response_item' &&
      item.payload.call_id === 'foreign-observation',
  );
  expect(original).toBeDefined();
  original!.payload = {
    type: 'computer_call',
    call_id: 'foreign-observation',
    actions: [{ type: 'wait' }],
    pending_safety_checks: [],
  };
  const outcome = await agent
    .session({ state: parseSessionState(JSON.stringify(forged)) })
    .then(
      async (session) => {
        await session.close();
        return undefined;
      },
      (error: unknown) => error,
    );
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toMatch(
    /Recovered tool outcomes lack a retained completed response/,
  );
  expect(effects).toEqual([]);
  expect(server.requests).toHaveLength(1);
});
