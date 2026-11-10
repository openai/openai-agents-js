import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, NativeProvider } from '@openai/agents';
import {
  invokeFunctionTool,
  registerToolSessionOwner,
  type ToolCallContext,
} from '../../src/runtime/tools';
import { Codex } from '@openai/codex-sdk';
import { nativeCodexTool } from '../../../agents-extensions/src/experimental/codex';
import { ModelServer, call, message } from './fixtures/model-server';

const roots: string[] = [];
afterEach(async () => {
  ModelServer.closeAll();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.skipIf(process.platform === 'win32')(
  'delegates a native function call to a real synthetic CLI and returns its usage',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-codex-cli-'));
    roots.push(root);
    const cli = join(root, 'codex');
    const events = [
      { type: 'thread.started', thread_id: 'synthetic-thread' },
      {
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'CLI completed' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 },
      },
    ];
    const callsPath = join(root, 'calls.jsonl');
    await writeFile(
      cli,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv) + '\\n');\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,
    );
    await chmod(cli, 0o700);
    const observed: string[] = [];
    const server = new ModelServer([
      [
        call(
          'codex',
          { prompt: 'Do the task', threadId: null },
          { callId: 'cli-1' },
        ),
      ],
      [
        call(
          'codex',
          { prompt: 'Continue the task', threadId: null },
          { callId: 'cli-2' },
        ),
      ],
      [message('done')],
    ]);
    const config = await server.config();
    const selected = config['model_providers.fixture'] as { base_url: string };
    await using provider = new NativeProvider({
      baseUrl: selected.base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use codex.',
      model: 'gpt-5',
      provider,
      tools: [
        nativeCodexTool({
          codex: new Codex({ codexPathOverride: cli }),
          persistSession: true,
          onEvent: (event) => {
            observed.push(event.type);
          },
        }),
      ],
    });
    await using session = await agent.session();
    expect(
      (await (await session.submit('Do the task')).wait()).finalOutput,
    ).toBe('done');
    expect(JSON.stringify(server.requests[1])).toContain('CLI completed');
    expect(JSON.stringify(server.requests[1])).toContain('cached_input_tokens');
    expect(observed).toEqual([
      'thread.started',
      'item.completed',
      'turn.completed',
      'thread.started',
      'item.completed',
      'turn.completed',
    ]);
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('resume');
    expect(calls[1]).toContain('synthetic-thread');
  },
);

it.skipIf(process.platform === 'win32')(
  'joins CLI cancellation and terminates the external subprocess',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-codex-cancel-'));
    roots.push(root);
    const cli = join(root, 'codex');
    const pidPath = join(root, 'pid');
    await writeFile(
      cli,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nconsole.log(JSON.stringify({type: 'thread.started', thread_id: 'blocking'}));\nsetTimeout(() => {}, 30000);\n`,
    );
    await chmod(cli, 0o700);
    const started = Promise.withResolvers<void>();
    const server = new ModelServer([
      [
        call(
          'codex',
          { prompt: 'Wait', threadId: null },
          { callId: 'cli-blocking' },
        ),
      ],
    ]);
    const config = await server.config();
    const selected = config['model_providers.fixture'] as { base_url: string };
    await using provider = new NativeProvider({
      baseUrl: selected.base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use codex.',
      model: 'gpt-5',
      provider,
      tools: [
        nativeCodexTool({
          codex: new Codex({ codexPathOverride: cli }),
          onEvent: () => {
            started.resolve();
          },
        }),
      ],
    });
    await using session = await agent.session();
    const turn = await session.submit('Wait');
    const settled = turn.wait().catch(() => {});
    await started.promise;
    await turn.cancel();
    await settled;
    const pid = Number(await readFile(pidPath, 'utf8'));
    // The SDK joins its stream; OS process exit can follow by an event-loop turn.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 2_000,
      interval: 10,
    });
    expect(server.requests).toHaveLength(1);
  },
);

async function recordingCli() {
  const root = await mkdtemp(join(tmpdir(), 'native-codex-isolation-'));
  roots.push(root);
  const cli = join(root, 'codex');
  const callsPath = join(root, 'calls.jsonl');
  await writeFile(
    cli,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv) + '\\n');\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-owned-thread'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{id:'item',type:'agent_message',text:'CLI completed'}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));\n`,
  );
  await chmod(cli, 0o700);
  const calls = async () =>
    (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  return { cli, callsPath, calls };
}

it.skipIf(process.platform === 'win32')(
  'isolates persistent CLI conversation state across native Sessions while reusing it within a Session',
  async () => {
    const { cli, calls } = await recordingCli();
    const server = new ModelServer(
      Array.from({ length: 3 }, (_, index) => [
        [
          call(
            'codex',
            { prompt: 'Task', threadId: null },
            { callId: `isolated-${index}` },
          ),
        ],
        [message('done')],
      ]).flat(),
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use codex.',
      model: 'gpt-5',
      provider,
      tools: [
        nativeCodexTool({
          codex: new Codex({ codexPathOverride: cli }),
          persistSession: true,
        }),
      ],
    });
    await using first = await agent.session();
    expect((await (await first.submit('First')).wait()).finalOutput).toBe(
      'done',
    );
    expect((await (await first.submit('Continue')).wait()).finalOutput).toBe(
      'done',
    );
    await using second = await agent.session();
    expect(
      (await (await second.submit('Independent task')).wait()).finalOutput,
    ).toBe('done');
    const argv = await calls();
    expect(argv).toHaveLength(3);
    expect(argv[0]).not.toContain('resume');
    expect(argv[1]).toContain('resume');
    expect(argv[2]).not.toContain('resume');
    server.assertExhausted();
  },
);

// Controlled callback admission tests the queued invocation independently of a
// running sibling's joined cancellation. Every entered invocation uses a real CLI.
it.skipIf(process.platform === 'win32')(
  'cancels a queued CLI invocation without starting it or releasing its successors early',
  async () => {
    const { cli, calls } = await recordingCli();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let starts = 0;
    const tool = nativeCodexTool({
      codex: new Codex({ codexPathOverride: cli }),
      persistSession: true,
      onEvent: async (event) => {
        if (event.type === 'thread.started' && ++starts === 1) {
          entered.resolve();
          await finish.promise;
        }
      },
    });
    const owner = {};
    const context = (signal: AbortSignal, callId: string) => {
      const issued = {
        context: undefined,
        submission: { sessionId: 'owned-native-session' },
        threadId: 'owned-native-session',
        turnId: 'turn',
        callId,
        signal,
      } as ToolCallContext;
      registerToolSessionOwner(issued, owner);
      return issued;
    };
    const first = invokeFunctionTool(
      tool,
      { prompt: 'First', threadId: null },
      context(new AbortController().signal, 'first'),
      () => {},
    );
    await entered.promise;
    const abort = new AbortController();
    const second = invokeFunctionTool(
      tool,
      { prompt: 'Cancelled', threadId: null },
      context(abort.signal, 'second'),
      () => {},
    );
    const cancelled = expect(second).rejects.toBe('queued cancellation');
    const third = invokeFunctionTool(
      tool,
      { prompt: 'Third', threadId: null },
      context(new AbortController().signal, 'third'),
      () => {},
    );
    abort.abort('queued cancellation');
    await cancelled;
    expect(await calls()).toHaveLength(1);
    finish.resolve();
    await Promise.all([first, third]);
    const argv = await calls();
    expect(argv).toHaveLength(2);
    expect(argv[1]).toContain('resume');
  },
);

it.each(['--last', ' --last', '-x'])(
  'rejects option-shaped thread ID %s before CLI execution',
  async (threadId) => {
    const { cli, callsPath } = await recordingCli();
    const tool = nativeCodexTool({
      codex: new Codex({ codexPathOverride: cli }),
    });
    await expect(
      invokeFunctionTool(
        tool,
        { prompt: 'Task', threadId },
        {
          context: undefined,
          submission: { sessionId: 'session' },
          threadId: 'session',
          turnId: 'turn',
          callId: 'call',
          signal: new AbortController().signal,
        } as ToolCallContext,
        () => {},
      ),
    ).rejects.toThrow('not a CLI option');
    await expect(readFile(callsPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it.skipIf(process.platform === 'win32').each(['throw', 'reject'])(
  'isolates observer %s from successful native calls and persistent CLI thread reuse',
  async (mode) => {
    const { cli, calls } = await recordingCli();
    const server = new ModelServer(
      Array.from({ length: 2 }, (_, index) => [
        [
          call(
            'codex',
            { prompt: 'Task', threadId: null },
            { callId: `observer-${index}` },
          ),
        ],
        [message('done')],
      ]).flat(),
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    let observed = 0;
    const agent = new Agent({
      instructions: 'Use codex.',
      model: 'gpt-5',
      provider,
      tools: [
        nativeCodexTool({
          codex: new Codex({ codexPathOverride: cli }),
          persistSession: true,
          onEvent() {
            observed++;
            if (mode === 'throw') throw new Error('observer failed');
            return Promise.reject(new Error('observer failed'));
          },
        }),
      ],
    });
    await using session = await agent.session();
    expect((await (await session.submit('First')).wait()).finalOutput).toBe(
      'done',
    );
    expect((await (await session.submit('Continue')).wait()).finalOutput).toBe(
      'done',
    );
    const argv = await calls();
    expect(argv).toHaveLength(2);
    expect(argv[0]).not.toContain('resume');
    expect(argv[1]).toContain('resume');
    expect(observed).toBe(6);
    expect(JSON.stringify(server.requests)).toContain('CLI completed');
    server.assertExhausted();
  },
);

it.each([
  ['engineer', 'codex_engineer'],
  ['my helper', 'codex_my_helper'],
  [' codex_existing ', 'codex_existing'],
])(
  'normalizes the native Codex tool name %s through the shared resolver',
  (name, expected) => {
    expect(nativeCodexTool({ name }).name).toBe(expected);
  },
);

it('rejects an empty native Codex tool name', () => {
  expect(() => nativeCodexTool({ name: '   ' })).toThrow('non-empty');
});

it.skipIf(process.platform === 'win32')(
  'settles configured-signal cancellation while a persistent CLI invocation is queued',
  async () => {
    const { cli, calls } = await recordingCli();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const configured = new AbortController();
    const reason = new Error('configured queued cancellation');
    let observed = false;
    let firstSettled = false;
    const tool = nativeCodexTool({
      codex: new Codex({ codexPathOverride: cli }),
      persistSession: true,
      defaultTurnOptions: { signal: configured.signal },
      onEvent: async (event) => {
        if (event.type === 'thread.started' && !observed) {
          observed = true;
          entered.resolve();
          await finish.promise;
        }
      },
    });
    const owner = {};
    const context = (callId: string) => {
      const issued = {
        context: undefined,
        submission: { sessionId: 'configured-session' },
        threadId: 'configured-session',
        turnId: 'turn',
        callId,
        signal: new AbortController().signal,
      } as ToolCallContext;
      registerToolSessionOwner(issued, owner);
      return issued;
    };
    const first = invokeFunctionTool(
      tool,
      { prompt: 'First', threadId: null },
      context('first'),
      () => {},
    );
    const firstOutcome = first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await entered.promise;
    const second = invokeFunctionTool(
      tool,
      { prompt: 'Queued', threadId: null },
      context('queued'),
      () => {},
    );
    let secondError: unknown;
    const secondOutcome = second.catch((error: unknown) => {
      secondError = error;
    });
    configured.abort(reason);
    try {
      await vi.waitFor(() => expect(secondError).toBe(reason));
      expect(firstSettled).toBe(false);
      expect(await calls()).toHaveLength(1);
      const third = invokeFunctionTool(
        tool,
        { prompt: 'Later', threadId: null },
        context('later'),
        () => {},
      );
      await expect(third).rejects.toBe(reason);
      expect(await calls()).toHaveLength(1);
    } finally {
      finish.resolve();
      await Promise.all([firstOutcome, secondOutcome]);
    }
    expect(await calls()).toHaveLength(1);
  },
);
