import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';
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
  'forwards structured native CLI text and local images through the real subprocess',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-codex-input-'));
    roots.push(root);
    const cli = join(root, 'codex');
    const record = join(root, 'record.json');
    const image = '  authorized diagram.png  ';
    await writeFile(join(root, image), 'synthetic image');
    const resolveImage = vi.fn(async (_reference: string) => image);
    const options = {
      codexOptions: { codexPathOverride: cli },
      defaultThreadOptions: { workingDirectory: root },
      resolveImage,
    };
    const declaration = nativeCodexTool(options);
    options.resolveImage = async () => {
      throw new Error('Mutated resolver');
    };
    await writeFile(
      cli,
      `#!${process.execPath}\nlet input=''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv, input})); for (const event of [{type:'thread.started',thread_id:'structured-cli'},{type:'item.completed',item:{id:'item',type:'agent_message',text:'CLI completed'}},{type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}]) console.log(JSON.stringify(event)); });\n`,
    );
    await chmod(cli, 0o700);
    const server = new ModelServer([
      [
        call(
          'codex',
          {
            prompt: [
              { type: 'text', text: '  First\n' },
              { type: 'local_image', path: ' asset:diagram ' },
              { type: 'text', text: '\nSecond  ' },
            ],
            threadId: null,
          },
          { callId: 'structured-cli' },
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
    await using session = await new Agent({
      model: 'gpt-5',
      instructions: 'Use codex.',
      provider,
      tools: [declaration],
    }).session();
    expect(
      (await (await session.submit('Inspect the diagram')).wait()).finalOutput,
    ).toBe('done');
    const captured = JSON.parse(await readFile(record, 'utf8'));
    expect(captured.args[captured.args.indexOf('--image') + 1]).toBe(image);
    expect(resolveImage).toHaveBeenCalledExactlyOnceWith(' asset:diagram ');
    expect(captured.input).toBe('  First\n\n\n\nSecond  ');
  },
);

it.skipIf(process.platform === 'win32').each([
  { denied: false, resume: false },
  { denied: true, resume: false },
  { denied: false, resume: true },
  { denied: true, resume: true },
])(
  'rejects unauthorized native CLI images before starting or resuming: %j',
  async ({ denied, resume }) => {
    const { cli, calls } = await recordingCli();
    const client = new Codex({ codexPathOverride: cli });
    const start = vi.spyOn(client, 'startThread');
    const resumeThread = vi.spyOn(client, 'resumeThread');
    const declaration = nativeCodexTool({
      codex: client,
      ...(resume ? { threadId: 'trusted-existing' } : {}),
      ...(denied ? { resolveImage: async () => null } : {}),
    });
    const server = new ModelServer([
      [
        call(
          'codex',
          {
            prompt: [{ type: 'local_image', path: '/private/ungranted.png' }],
            threadId: null,
          },
          { callId: 'ungranted' },
        ),
      ],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      model: 'gpt-5',
      instructions: 'Use codex.',
      provider,
      tools: [declaration],
    }).session();
    await expect(
      (await session.submit('Inspect image')).wait(),
    ).rejects.toThrow(/resolveImage|not authorized/);
    expect(start).not.toHaveBeenCalled();
    expect(resumeThread).not.toHaveBeenCalled();
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.skipIf(process.platform === 'win32')(
  'rechecks cancellation after awaited native image resolution',
  async () => {
    const { cli, calls } = await recordingCli();
    const controller = new AbortController();
    const reason = new Error('image resolution cancelled');
    const client = new Codex({ codexPathOverride: cli });
    const start = vi.spyOn(client, 'startThread');
    const declaration = nativeCodexTool({
      codex: client,
      resolveImage: async () => {
        controller.abort(reason);
        await Promise.resolve();
        return '/authorized/asset.png';
      },
    });
    const context = {
      context: undefined,
      submission: { sessionId: 'image-owner' },
      threadId: 'image-owner',
      turnId: 'turn',
      callId: 'image',
      signal: controller.signal,
    } as ToolCallContext;
    registerToolSessionOwner(context, {});
    await expect(
      invokeFunctionTool(
        declaration,
        { prompt: [{ type: 'local_image', path: 'asset' }], threadId: null },
        context,
        () => {},
      ),
    ).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.skipIf(process.platform === 'win32').each([false, true])(
  'fences a late image resolver after an actual native callback timeout (persistSession=%s)',
  async (persistSession) => {
    const { cli, calls } = await recordingCli();
    const client = new Codex({ codexPathOverride: cli });
    const start = vi.spyOn(client, 'startThread');
    const resumed = vi.spyOn(client, 'resumeThread');
    const release = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    let resolved = false;
    const delegation = nativeCodexTool({
      codex: client,
      persistSession,
      resolveImage: async () => {
        await release.promise;
        expect(nativeSignal?.aborted).toBe(true);
        resolved = true;
        return '/authorized/staged.png';
      },
    });
    const server = new ModelServer([
      [call('delegate_image', {}, { callId: 'late-image' })],
      [message('timed out')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      model: 'gpt-5',
      instructions: 'Delegate the image.',
      provider,
      tools: [
        tool({
          name: 'delegate_image',
          parameters: z.object({}),
          callbackTimeout: 0.02,
          timeoutBehavior: 'error_as_result',
          execute: async (_, context) => {
            nativeSignal = context.signal;
            return invokeFunctionTool(
              delegation,
              {
                prompt: [{ type: 'local_image', path: 'asset' }],
                threadId: null,
              },
              context,
              () => {},
            );
          },
        }),
      ],
    });
    const running = agent.run('Inspect image');
    const outcome = running.catch(() => {});
    try {
      await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true), {
        timeout: 2000,
      });
      release.resolve();
      expect((await running).finalOutput).toBe('timed out');
    } finally {
      release.resolve();
      await outcome;
    }
    expect(resolved).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
    server.assertExhausted();
  },
);

it.skipIf(process.platform === 'win32')(
  'preserves captured native CLI environment, thread options and output schema',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-codex-options-'));
    roots.push(root);
    const cli = join(root, 'codex');
    const record = join(root, 'record.json');
    await writeFile(
      cli,
      `#!${process.execPath}\nconst fs=require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { const path=process.argv[process.argv.indexOf('--output-schema')+1]; fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv,path,schema:JSON.parse(fs.readFileSync(path,'utf8')),visible:process.env.CLI_ONLY,private:process.env.CLI_NOT_INHERITED})); for (const event of [{type:'thread.started',thread_id:'options-cli'},{type:'item.completed',item:{id:'item',type:'agent_message',text:'CLI completed'}},{type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}]) console.log(JSON.stringify(event)); });\n`,
    );
    await chmod(cli, 0o700);
    const schema = {
      type: 'object',
      properties: { value: { type: 'string' } },
    };
    const environment = { CLI_ONLY: 'configured' };
    const declaration = nativeCodexTool({
      codexOptions: { codexPathOverride: cli, env: environment },
      defaultThreadOptions: {
        workingDirectory: root,
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
      },
      defaultTurnOptions: { outputSchema: schema },
    });
    schema.properties.value.type = 'number';
    environment.CLI_ONLY = 'mutated';
    const server = new ModelServer([
      [
        call(
          'codex',
          { prompt: 'Run', threadId: null },
          { callId: 'options-cli' },
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
    const previous = process.env.CLI_NOT_INHERITED;
    process.env.CLI_NOT_INHERITED = 'synthetic-private';
    try {
      await using session = await new Agent({
        model: 'gpt-5',
        instructions: 'Use codex.',
        provider,
        tools: [declaration],
      }).session();
      expect((await (await session.submit('Run')).wait()).finalOutput).toBe(
        'done',
      );
    } finally {
      if (previous === undefined) delete process.env.CLI_NOT_INHERITED;
      else process.env.CLI_NOT_INHERITED = previous;
    }
    const captured = JSON.parse(await readFile(record, 'utf8'));
    expect(captured.visible).toBe('configured');
    expect(captured.private).toBeUndefined();
    expect(captured.schema.properties.value.type).toBe('string');
    expect(captured.args[captured.args.indexOf('--cd') + 1]).toBe(root);
    expect(captured.args[captured.args.indexOf('--sandbox') + 1]).toBe(
      'read-only',
    );
    expect(captured.args).toContain('--skip-git-repo-check');
    await expect(readFile(captured.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

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

async function recordingCli(complete = true) {
  const root = await mkdtemp(join(tmpdir(), 'native-codex-isolation-'));
  roots.push(root);
  const cli = join(root, 'codex');
  const callsPath = join(root, 'calls.jsonl');
  await writeFile(
    cli,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv) + '\\n');\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-owned-thread'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{id:'item',type:'agent_message',text:'CLI completed'}}));\n${complete ? "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));" : ''}\n`,
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

it.skipIf(process.platform === 'win32').each([false, true])(
  'binds model-supplied CLI thread IDs to the invoking Session (persistSession=%s)',
  async (persistSession) => {
    const { cli, calls } = await recordingCli();
    const server = new ModelServer([
      [call('codex', { prompt: 'Start', threadId: null }, { callId: 'start' })],
      [message('started')],
      [
        call(
          'codex',
          { prompt: 'Continue', threadId: 'synthetic-owned-thread' },
          { callId: 'continue' },
        ),
      ],
      [message('continued')],
      [
        call(
          'codex',
          { prompt: 'Read another user', threadId: 'synthetic-owned-thread' },
          { callId: 'foreign' },
        ),
      ],
      [message('unexpected foreign continuation')],
    ]);
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
          persistSession,
        }),
      ],
    });
    await using first = await agent.session();
    expect((await (await first.submit('Start')).wait()).finalOutput).toBe(
      'started',
    );
    expect((await (await first.submit('Continue')).wait()).finalOutput).toBe(
      'continued',
    );
    await using second = await agent.session();
    await expect((await second.submit('Foreign')).wait()).rejects.toThrow(
      'not authorized for this Session',
    );
    const argv = await calls();
    expect(argv).toHaveLength(2);
    expect(argv[0]).not.toContain('resume');
    expect(argv[1]).toContain('resume');
    expect(argv[1]).toContain('synthetic-owned-thread');
    expect(server.requests).toHaveLength(5);
  },
);

it.skipIf(process.platform === 'win32').each([false, true])(
  'captures application-authorized thread IDs while preserving native persistence (persistSession=%s)',
  async (persistSession) => {
    const { cli, calls } = await recordingCli();
    const server = new ModelServer(
      [
        null,
        'synthetic-owned-thread',
        null,
        'application-approved-thread',
      ].flatMap((threadId, index) => [
        [
          call(
            'codex',
            { prompt: 'Task', threadId },
            { callId: `trusted-${index}` },
          ),
        ],
        [message('done')],
      ]),
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const options = {
      codex: new Codex({ codexPathOverride: cli }),
      persistSession,
      threadId: 'application-approved-thread',
    };
    const tool = nativeCodexTool(options);
    options.threadId = 'later-configuration-mutation';
    const agent = new Agent({
      instructions: 'Use codex.',
      model: 'gpt-5',
      provider,
      tools: [tool],
    });
    await using first = await agent.session();
    for (const prompt of ['Initial', 'Select returned thread', 'Continue']) {
      expect((await (await first.submit(prompt)).wait()).finalOutput).toBe(
        'done',
      );
    }
    await using second = await agent.session();
    expect(
      (await (await second.submit('Authorized shared thread')).wait())
        .finalOutput,
    ).toBe('done');
    const argv = await calls();
    expect(argv).toHaveLength(4);
    const expectedIds = [
      'application-approved-thread',
      'synthetic-owned-thread',
      persistSession ? 'synthetic-owned-thread' : 'application-approved-thread',
      'application-approved-thread',
    ];
    for (const [index, expectedId] of expectedIds.entries()) {
      expect(argv[index]).toContain('resume');
      expect(argv[index]).toContain(expectedId);
      expect(argv[index]).not.toContain('later-configuration-mutation');
    }
    server.assertExhausted();
  },
);

it.skipIf(process.platform === 'win32').each([false, true])(
  'rejects incomplete CLI streams without authorizing their thread IDs (persistSession=%s)',
  async (persistSession) => {
    const { cli, calls } = await recordingCli(false);
    const server = new ModelServer([
      [
        call(
          'codex',
          { prompt: 'Incomplete', threadId: null },
          { callId: 'incomplete' },
        ),
      ],
      [
        call(
          'codex',
          { prompt: 'Resume', threadId: 'synthetic-owned-thread' },
          { callId: 'resume-incomplete' },
        ),
      ],
    ]);
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
          persistSession,
        }),
      ],
    });
    await using session = await agent.session();
    await expect((await session.submit('Incomplete')).wait()).rejects.toThrow(
      'before successful completion',
    );
    await expect(
      (await session.submit('Resume incomplete')).wait(),
    ).rejects.toThrow('not authorized for this Session');
    expect(await calls()).toHaveLength(1);
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

it.skipIf(process.platform === 'win32')(
  'stops buffered observer callbacks after the configured signal aborts',
  async () => {
    const { cli } = await recordingCli();
    const configured = new AbortController();
    const reason = new Error('configured observer cancellation');
    const observed: string[] = [];
    const tool = nativeCodexTool({
      codex: new Codex({ codexPathOverride: cli }),
      defaultTurnOptions: { signal: configured.signal },
      onEvent(event) {
        observed.push(event.type);
        configured.abort(reason);
      },
    });
    const context: ToolCallContext = {
      context: undefined,
      submission: { sessionId: 'configured-observer' },
      threadId: 'configured-observer',
      turnId: 'turn',
      callId: 'call',
      signal: new AbortController().signal,
    } as ToolCallContext;
    registerToolSessionOwner(context, {});
    await expect(
      invokeFunctionTool(
        tool,
        { prompt: 'Run', threadId: null },
        context,
        () => {},
      ),
    ).rejects.toBe(reason);
    expect(observed).toEqual(['thread.started']);
  },
);
