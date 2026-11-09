import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, NativeProvider } from '@openai/agents';
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
  'joins the external CLI subprocess when the native turn is cancelled',
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
    expect(() => process.kill(pid, 0)).toThrow();
    expect(server.requests).toHaveLength(1);
  },
);
