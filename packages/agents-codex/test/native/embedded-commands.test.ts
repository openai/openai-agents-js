import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent as ClassicAgent,
  setTracingDisabled,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  modelResponder,
} from '@openai/agents/classic/testing';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  Turn,
  embeddedCommands,
} from '@openai/agents';
import { NativeThread } from '../../native/index.js';
import * as agentRuntime from '../../src/runtime/agent';
import { binding, type JsonObject } from '../../src/runtime/binding';
import { SDKRunner } from '../../src/migration';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

setTracingDisabled(true);

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-embedded-commands',
    supportsWebsockets: false,
  });
}

function toolOutput(request: JsonObject, callId: string): string {
  const item = (request.input as JsonObject[]).find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  );
  expect(item).toBeDefined();
  return String(item!.output);
}

it('discovers the native canonical catalog without creating an engine or acquiring a provider', async () => {
  const native = await binding();
  const create = vi.spyOn(native, 'create_engine');
  const acquire = vi.spyOn(NativeProvider.prototype, '_acquire');
  expect(await embeddedCommands()).toEqual([
    {
      name: 'review',
      description: 'review my current changes and find issues',
      supportsInlineArguments: true,
    },
    {
      name: 'rename',
      description: 'rename the current thread',
      supportsInlineArguments: true,
    },
    {
      name: 'compact',
      description:
        'summarize conversation to prevent hitting the context limit',
      supportsInlineArguments: false,
    },
    {
      name: 'stop-background-terminals',
      description: 'stop all background terminals',
      supportsInlineArguments: false,
    },
  ]);
  expect(create).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
});

it('refuses missing or extra arguments, aliases, TUI commands, unknown names, and closed Sessions before native enqueue', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const execute = vi.spyOn(NativeThread.prototype, '_execute_command');
  const compact = vi.spyOn(NativeThread.prototype, '_compact');
  try {
    for (const text of [
      'rename',
      '/review  ',
      'compact extra',
      '/stop-background-terminals extra',
    ])
      await expect(session.executeCommand(text)).rejects.toBeInstanceOf(
        TypeError,
      );
    for (const text of ['/quit', 'exit', '/clear', '/model', 'unknown'])
      await expect(session.executeCommand(text)).rejects.toThrow(
        'Unsupported embedded command',
      );
    expect(execute).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  } finally {
    await session.close();
  }
  for (const text of [
    'compact',
    'stop-background-terminals',
    'rename closed',
    'review closed',
  ])
    await expect(session.executeCommand(text)).rejects.toBeInstanceOf(
      NativeError,
    );
  expect(execute).not.toHaveBeenCalled();
  expect(compact).not.toHaveBeenCalled();
  server.assertExhausted();
});

it('returns the normalized native rename receipt and preserves usable conversation history', async () => {
  const server = new ModelServer([
    [message('remembered')],
    (request) => {
      expect(JSON.stringify(request.input)).toContain('remembered');
      return [message('continued')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Remember.',
    provider,
  }).session();
  const original = await session.submit('Remember this conversation.');
  await original.wait();
  const before = await Array.fromAsync(session.items());
  const execute = vi.spyOn(NativeThread.prototype, '_execute_command');
  expect(
    await session.executeCommand('/rename   Synthetic command thread  '),
  ).toEqual({
    command: 'rename',
    sessionId: session.id,
    name: 'Synthetic command thread',
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await execute.mock.results[0].value)).toMatchObject({
    session_id: session.id,
    name: 'Synthetic command thread',
  });
  expect(await Array.fromAsync(session.items())).toEqual(before);
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'continued',
  );
  expect((await original.wait()).finalOutput).toBe('remembered');
  server.assertExhausted();
});

it('returns the actual native compact Turn and retains the original result', async () => {
  const server = new ModelServer([
    [message('Original answer')],
    [message('Summary: original answer')],
    (request) => {
      expect(JSON.stringify(request.input)).toContain(
        'Summary: original answer',
      );
      return [message('Continued answer')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Remember.',
    provider,
  }).session();
  const original = await session.submit('Remember the answer.');
  const result = await original.wait();
  const compact = vi.spyOn(NativeThread.prototype, '_compact');
  const command = await session.executeCommand('/compact');
  if (command.command !== 'compact') throw new Error('Missing compact receipt');
  expect(command.turn).toBeInstanceOf(Turn);
  expect(command.turn.sessionId).toBe(session.id);
  expect(command.turn.turnId).toBe(
    JSON.parse(await compact.mock.results[0].value).turn_id,
  );
  expect(command.turn.turnId).not.toBe(original.turnId);
  await command.turn.wait();
  expect(await original.wait()).toBe(result);
  expect(await session.wait()).toBe(result);
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Continued answer',
  );
  server.assertExhausted();
});

const reviewOutput = {
  findings: [],
  overall_correctness: 'patch is correct',
  overall_explanation: 'Synthetic review found no issues.',
  overall_confidence_score: 0.9,
};

it('runs native review after a selector-backed typed root without parsing or repairing review output as Agent output', async () => {
  const parse = vi.fn(() => true);
  const beforeStep = vi.fn(() => []);
  const releaseReview = Promise.withResolvers<void>();
  let reviewEntered = false;
  const server = new ModelServer([
    [message('{"answer":"original"}')],
    async (request) => {
      expect(JSON.stringify(request)).toContain('Inspect the synthetic patch.');
      reviewEntered = true;
      await releaseReview.promise;
      return [message(JSON.stringify(reviewOutput))];
    },
    [message('{"answer":"after-review"}')],
  ]);
  const executor = await startPublicExecutor();
  try {
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      outputType: z.object({ answer: z.string() }).refine(parse),
      tools: [new NativeAgents()],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    const root = await session.submit('Answer first.', { beforeStep });
    expect((await root.wait()).finalOutput).toEqual({ answer: 'original' });
    const parsed = parse.mock.calls.length;
    const selected = beforeStep.mock.calls.length;
    const execute = vi.spyOn(NativeThread.prototype, '_execute_command');
    const command = await session.executeCommand(
      'review Inspect the synthetic patch.',
    );
    if (command.command !== 'review') throw new Error('Missing review receipt');
    expect(command.turn.turnId).toBe(
      JSON.parse(await execute.mock.results[0].value).turn_id,
    );
    expect(command.turn.turnId).not.toBe(root.turnId);
    await vi.waitFor(() => expect(reviewEntered).toBe(true));
    const defaultWait = session.wait();
    defaultWait.catch(() => {});
    await expect(session.submit('Do not steer review.')).rejects.toThrow(
      'settled',
    );
    releaseReview.resolve();
    await expect(defaultWait).rejects.toThrow('Use the returned Turn');
    expect((await command.turn.wait()).finalOutput).toEqual(reviewOutput);
    expect(parse).toHaveBeenCalledTimes(parsed);
    expect(beforeStep).toHaveBeenCalledTimes(selected);
    expect(await Array.fromAsync(session.turns())).toContainEqual(
      expect.objectContaining({ id: command.turn.turnId, status: 'completed' }),
    );
    expect((await root.wait()).finalOutput).toEqual({ answer: 'original' });
    await expect(session.wait()).rejects.toThrow('Use the returned Turn');
    const ordinary = await session.submit('Answer normally after review.');
    const result = await ordinary.wait();
    expect(result.finalOutput).toEqual({ answer: 'after-review' });
    expect(await session.wait()).toBe(result);
    server.assertExhausted();
  } finally {
    releaseReview.resolve();
    await executor.close();
  }
}, 30_000);

it.each(['cancel', 'error'] as const)(
  'keeps native review %s owned by its returned Turn',
  async (outcome) => {
    const release = Promise.withResolvers<void>();
    let entered = false;
    const server = new ModelServer([
      outcome === 'error'
        ? { status: 400, body: 'Synthetic review failure' }
        : async () => {
            entered = true;
            await release.promise;
            return [message(JSON.stringify(reviewOutput))];
          },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Review.',
      provider,
    }).session();
    try {
      const command = await session.executeCommand(
        '/review Inspect this synthetic change.',
      );
      if (command.command !== 'review')
        throw new Error('Missing review receipt');
      const completion = command.turn.wait();
      completion.catch(() => {});
      if (outcome === 'cancel') {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
        // Native HTTP admission now stays in Rust. Its exact receipt/retirement
        // checks live in the Rust Review fixture; this real provider gate keeps
        // cancellation and public event ownership on the returned Review Turn.
        const stopping = command.turn.cancel({ mode: 'force' });
        release.resolve();
        await stopping;
      }
      await expect(completion).rejects.toBeInstanceOf(NativeError);
      expect(await Array.fromAsync(command.turn.events())).toContainEqual(
        expect.objectContaining({
          type: 'turn_finished',
          sessionId: session.id,
          submissionId: command.turn.submissionId,
          turnId: command.turn.turnId,
          status: outcome === 'cancel' ? 'cancelled' : 'failed',
        }),
      );
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  },
  30_000,
);

it('refuses selected-Model review before native enqueue while the original migration run remains usable', async () => {
  const open = agentRuntime.openSession;
  const execute = vi.spyOn(NativeThread.prototype, '_execute_command');
  let checked = false;
  vi.spyOn(agentRuntime, 'openSession').mockImplementation(async (...args) => {
    const session = await open(...args);
    try {
      expect(model.calls).toHaveLength(0);
      await expect(
        session.executeCommand('review Inspect this change.'),
      ).rejects.toThrow('selected Model');
      expect(model.calls).toHaveLength(0);
      checked = true;
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  });
  const model = new ScriptedModel([
    modelResponder(() => [assistantMessage('Original model answer')]),
  ]);
  const agent = new ClassicAgent({ name: 'Selected Model', model });
  expect(
    (await SDKRunner.run(agent, 'Answer.', { context: undefined })).finalOutput,
  ).toBe('Original model answer');
  expect(checked).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  expect(model.calls).toHaveLength(1);
});

it('keeps rename and stop available during a Turn while refusing idle-only commands', async () => {
  const release = Promise.withResolvers<void>();
  let entered = false;
  const server = new ModelServer([
    [message('First answer')],
    async () => {
      entered = true;
      await release.promise;
      return [message('Foreground answer')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  await (await session.submit('Start.')).wait();
  const original = await session.submit('Wait for the answer.');
  const completion = original.wait();
  completion.catch(() => {});
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    const execute = vi.spyOn(NativeThread.prototype, '_execute_command');
    const compact = vi.spyOn(NativeThread.prototype, '_compact');
    await expect(session.executeCommand('compact')).rejects.toThrow();
    await expect(
      session.executeCommand('review Inspect this change.'),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(await session.executeCommand('rename Active conversation')).toEqual({
      command: 'rename',
      sessionId: session.id,
      name: 'Active conversation',
    });
    const stopped = await session.executeCommand('stop-background-terminals');
    expect(stopped).toEqual({
      command: 'stop-background-terminals',
      sessionId: session.id,
      operationId: expect.any(String),
    });
    let settled = false;
    void completion
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    const result = await completion;
    expect(result.finalOutput).toBe('Foreground answer');
    expect(await original.wait()).toBe(result);
    expect(await session.wait()).toBe(result);
    server.assertExhausted();
  } finally {
    release.resolve();
  }
});

// Strict terminal execution needs a native sandbox outside the outer Codex sandbox.
it.skipIf(
  process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1',
)('stops an actual background terminal while a held foreground Turn survives', async ({
  task,
}) => {
  const executor = await startPublicExecutor({
    captureProcessDiagnostics: true,
  });
  const release = Promise.withResolvers<void>();
  let held = false;
  let afterStopOutput = '';
  let preStopRequestBoundary: number | null = null;
  let beforeDisposalDiagnosticCount: number | null = null;
  const lockSnapshots: unknown[] = [];
  const snapshotLock = (phase: string) => {
    const result = execFileSync(
      'python3',
      [
        '-c',
        `
import os, json
path = os.path.join(__import__('sys').argv[1], 'stop-terminal.lock')
s = os.stat(path)
locks = []
for line in open('/proc/locks'):
    fields = line.split()
    if len(fields) < 6: continue
    parts = fields[5].split(':')
    if len(parts) == 3 and (int(parts[0],16),int(parts[1],16),int(parts[2])) == (os.major(s.st_dev),os.minor(s.st_dev),s.st_ino):
        locks.append(line.strip())
holders = []
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try:
        if os.stat('/proc/'+pid).st_uid != os.getuid(): continue
        for fd in os.listdir('/proc/'+pid+'/fd'):
            try: f = os.stat('/proc/'+pid+'/fd/'+fd)
            except OSError: continue
            if (f.st_dev,f.st_ino) != (s.st_dev,s.st_ino): continue
            raw = open('/proc/'+pid+'/stat').read()
            fields = raw[raw.rfind(')')+2:].split()
            holders.append(dict(pid=int(pid),fd=fd,comm=raw[raw.find('(')+1:raw.rfind(')')],state=fields[0],ppid=fields[1],pgid=fields[2],sid=fields[3],startTime=fields[19]))
    except OSError: pass
print(json.dumps(dict(locks=locks,holders=holders)))
`,
        executor.cwd,
      ],
      { encoding: 'utf8' },
    );
    lockSnapshots.push({
      phase,
      requestCount: executor.requests.length,
      processDiagnosticCount: executor.processDiagnostics.length,
      ...JSON.parse(result),
    });
  };
  const server = new ModelServer([
    [
      call(
        'exec_command',
        {
          cmd: "flock -n stop-terminal.lock -c 'printf ready > stop-terminal.ready; read -r line'",
          workdir: executor.cwd,
          tty: true,
          yield_time_ms: 1000,
        },
        { callId: 'background-terminal' },
      ),
    ],
    (request) => {
      expect(toolOutput(request, 'background-terminal')).toMatch(
        /Process running with session ID \d+/,
      );
      return [message('terminal started')];
    },
    [
      call(
        'exec_command',
        {
          cmd: "flock -n stop-terminal.lock -c 'printf acquired'",
          workdir: executor.cwd,
          yield_time_ms: 1000,
        },
        { callId: 'locked-before-stop' },
      ),
    ],
    (request) => {
      expect(toolOutput(request, 'locked-before-stop')).toContain(
        'Process exited with code 1',
      );
      return [message('lock is held')];
    },
    async () => {
      held = true;
      await release.promise;
      return [message('foreground survived')];
    },
    [
      call(
        'exec_command',
        {
          cmd: "for attempt in {1..100}; do flock -n stop-terminal.lock -c 'printf acquired' && exit 0; sleep 0.05; done; exit 1",
          workdir: executor.cwd,
          yield_time_ms: 10_000,
        },
        { callId: 'unlocked-after-stop' },
      ),
    ],
    (request) => {
      afterStopOutput = toolOutput(request, 'unlocked-after-stop');
      return [message('terminal released its lock')];
    },
  ]);
  try {
    await using provider = await providerFor(server);
    const agent = new Agent({ instructions: 'Use the terminal.', provider });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin'],
    });
    await using session = await agent.session({ environment });
    await using observer = await agent.session({ environment });
    try {
      await (await session.submit('Start a background terminal.')).wait();
      const requestIndex = executor.requests.findIndex(
        (row) =>
          row.method === 'process/start' &&
          JSON.stringify((row.params as JsonObject).argv).includes(
            'stop-terminal.ready',
          ),
      );
      expect(requestIndex).toBeGreaterThanOrEqual(0);
      const backgroundRequest = executor.processDiagnostics.find(
        (row) =>
          row.direction === 'request' &&
          row.requestSequence === requestIndex + 1,
      );
      expect(backgroundRequest).toBeDefined();
      const background = executor.processDiagnostics.find(
        (row) =>
          row.direction === 'response' &&
          row.method === 'process/start' &&
          row.connection === backgroundRequest!.connection &&
          row.id === backgroundRequest!.id,
      );
      expect(background?.processId).toEqual(expect.any(String));
      expect(background!.processId).toBe(backgroundRequest!.processId);
      expect(
        await readFile(join(executor.cwd, 'stop-terminal.ready'), 'utf8'),
      ).toBe('ready');
      expect(
        (await (await observer.submit('Check the lock.')).wait()).finalOutput,
      ).toBe('lock is held');
      const foreground = await session.submit(
        'Wait for the foreground answer.',
      );
      const completion = foreground.wait();
      completion.catch(() => {});
      let settled = false;
      void completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 });
      const execute = vi.spyOn(NativeThread.prototype, '_execute_command');
      const compact = vi.spyOn(NativeThread.prototype, '_compact');
      await expect(session.executeCommand('compact')).rejects.toThrow();
      await expect(
        session.executeCommand('review Inspect this change.'),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(compact).not.toHaveBeenCalled();
      snapshotLock('before-stop');
      const requestBoundary = executor.requests.length;
      preStopRequestBoundary = requestBoundary;
      const stopped = await session.executeCommand(
        '/stop-background-terminals',
      );
      if (stopped.command !== 'stop-background-terminals')
        throw new Error('Missing stop receipt');
      expect(stopped).toEqual({
        command: 'stop-background-terminals',
        sessionId: session.id,
        operationId: expect.any(String),
      });
      expect(stopped.operationId).toBe(
        JSON.parse(await execute.mock.results[0].value).operation_id,
      );
      expect(stopped.operationId).not.toBe(foreground.turnId);
      await vi.waitFor(
        () =>
          expect(
            executor.processDiagnostics.some(
              (row) =>
                row.direction === 'response' &&
                row.method === 'process/terminate' &&
                row.connection === background!.connection &&
                row.processId === background!.processId &&
                Number(row.requestSequence) > requestBoundary,
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
      expect(
        (
          await (
            await observer.submit('Check that the terminal released its lock.')
          ).wait()
        ).finalOutput,
      ).toBe('terminal released its lock');
      snapshotLock('after-lock-probe');
      expect(afterStopOutput).toContain('acquired');
      expect(afterStopOutput).toContain('Process exited with code 0');
      expect(settled).toBe(false);
      release.resolve();
      expect((await completion).finalOutput).toBe('foreground survived');
      server.assertExhausted();
    } finally {
      try {
        snapshotLock('before-session-disposal');
      } catch (error) {
        lockSnapshots.push({ error: String(error) });
      }
      beforeDisposalDiagnosticCount = executor.processDiagnostics.length;
      release.resolve();
    }
  } finally {
    Object.assign(task.meta, {
      stopProcessDiagnostics: {
        preStopRequestBoundary,
        beforeDisposalDiagnosticCount,
        process: executor.processDiagnostics,
        lockSnapshots,
      },
    });
    release.resolve();
    await executor.close();
  }
}, 30_000);
