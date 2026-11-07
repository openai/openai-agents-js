import type { NativeEventBatch } from '../fixtures/native-event-batches';
import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  type ExecutionItem,
  type ModelRequestDispatching,
  type ModelResponseLinked,
  type SessionState,
} from '@openai/agents';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const records: T[] = [];
  for await (const item of source) records.push(item);
  return records;
}

it('binds the exact ordered UTF-8 instruction files to sampled requests', async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), 'agents-instruction-sources-'),
  );
  try {
    const cwd = await realpath(workspace);
    const first = join(cwd, 'first.md');
    const second = join(cwd, 'second.md');
    const files = ['First instruction.\r\n', '\ufeffSecond instruction.'];
    await Promise.all(
      [first, second].map((path, index) => writeFile(path, files[index]!)),
    );
    const server = new ModelServer([
      [message('done')],
      [message('done again')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-instruction-provider',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Answer.',
    });
    const instructionFiles = [second, first];
    const opening = agent.session({ instructionFiles });
    instructionFiles.reverse();
    agent.instructions = 'Changed after opening.';
    await using session = await opening;
    const turn = await session.submit('Work.');
    expect((await turn.wait()).finalOutput).toBe('done');
    const [recorded] = await collect(session.turns());
    const expected = ['Answer.', files[1], files[0]].join('\n\n');
    expect(JSON.stringify(server.requests[0]?.input)).toContain(
      JSON.stringify(expected).slice(1, -1),
    );
    expect(recorded?.receipt).toMatchObject({
      threadId: session.id,
      turnId: turn.turnId,
      developerInstructionsSha256: createHash('sha256')
        .update(expected)
        .digest('hex'),
      instructionFiles: [second, first].map((path, index) => ({
        path,
        source: 'application_file',
        sha256: createHash('sha256')
          .update(files[1 - index]!)
          .digest('hex'),
      })),
      executors: [],
    });
    agent.instructions = 'Answer.';
    const result = await agent.run('Work again.', {
      instructionFiles: [second, first],
    });
    expect(result.finalOutput).toBe('done again');
    expect(JSON.stringify(server.requests[1]?.input)).toContain(
      JSON.stringify(expected).slice(1, -1),
    );
    server.assertExhausted();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 20_000);

it('records sampled instructions, build identity and matching live and retained command evidence', async () => {
  const executor = await startPublicExecutor();
  const workspace = await mkdtemp(
    join(tmpdir(), 'agents-instruction-receipt-'),
  );
  try {
    const source = join(await realpath(workspace), 'explicit.md');
    const instructions = 'Use the fixture command.\r\n';
    await writeFile(source, instructions);
    const rules = join(executor.cwd, '.claude', 'rules');
    await mkdir(rules, { recursive: true });
    const guidance = 'Use the RECEIPT-GUIDANCE marker when asked.\n';
    await writeFile(join(rules, 'general.md'), guidance);
    const command = "printf '%s' 'receipt output'";
    const server = new ModelServer([
      [
        call(
          'exec_command',
          { cmd: command, login: false },
          { callId: 'command-receipt' },
        ),
      ],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-receipt-provider',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Answer.',
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command'],
      approval: () => true,
    });
    let checkpoint: SessionState;
    let turnId: string | null;
    {
      await using session = await agent.session({
        environment,
        instructionFiles: [source],
        projectGuidance: true,
      });
      const turn = await session.submit('Run the fixture command.');
      const dispatches: ModelRequestDispatching[] = [];
      const links: ModelResponseLinked[] = [];
      const completions = (async () => {
        const items: ExecutionItem[] = [];
        for await (const event of turn.events({
          includeExecutionDetails: true,
        })) {
          if (event.type === 'model_request_dispatching')
            dispatches.push(event);
          if (event.type === 'model_response_linked') links.push(event);
          if (event.type === 'execution_item_completed') {
            if (!('command' in event.item))
              throw new Error('Expected command details');
            items.push(event.item);
          }
          if (event.type === 'turn_finished') break;
        }
        return items;
      })();
      expect((await turn.wait()).finalOutput).toBe('done');
      turnId = turn.turnId;
      const [recorded] = await collect(session.turns());
      const sampled = JSON.stringify(server.requests.at(-1)?.input);
      expect(sampled).toContain('Use the fixture command.');
      expect(sampled).toContain('RECEIPT-GUIDANCE');
      expect(recorded?.receipt).toMatchObject({
        threadId: session.id,
        turnId,
        model: 'gpt-5',
        codexRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
        codexSourceTree: expect.stringMatching(/^[0-9a-f]{40}$/),
        instructionRevision: expect.any(String),
        developerInstructionsSha256: createHash('sha256')
          .update(`Answer.\n\n${instructions}`)
          .digest('hex'),
        instructionFiles: [
          {
            source: 'application_file',
            path: source,
            sha256: createHash('sha256').update(instructions).digest('hex'),
          },
          {
            source: 'project_guidance',
            path: expect.stringContaining('/general.md'),
            sha256: createHash('sha256').update(guidance).digest('hex'),
          },
        ],
        executors: [
          expect.objectContaining({
            transport: 'remote',
            cwd: expect.any(String),
          }),
        ],
      });
      expect(recorded?.receipt?.executors?.[0]).not.toHaveProperty(
        'permission_profile',
      );
      const live = await completions;
      expect(dispatches).toHaveLength(2);
      expect(links).toHaveLength(2);
      expect(new Set(dispatches.map((event) => event.requestId)).size).toBe(2);
      for (const event of [...dispatches, ...links]) {
        expect(event.threadId).toBe(session.id);
        expect(event.turnId).toBe(turnId);
        expect(event.submissionId).toBe(turn.submissionId);
      }
      expect(new Set(links.map((event) => event.requestId))).toEqual(
        new Set(dispatches.map((event) => event.requestId)),
      );
      expect(
        new Set(links.map((event) => event.responseObservationId)),
      ).toEqual(new Set(recorded?.responses?.map((response) => response.id)));

      const retained = (await collect(session.items())).filter(
        (item) => item.type === 'command_execution',
      );
      expect(live).toEqual(retained);
      expect(live).toEqual([
        expect.objectContaining({
          threadId: session.id,
          turnId,
          callId: 'command-receipt',
          argv: expect.arrayContaining([command]),
          cwd: expect.any(String),
          exitCode: expect.any(Number),
        }),
      ]);
      const completion = live[0];
      expect(completion?.type).toBe('command_execution');
      if (completion?.type === 'command_execution') {
        // Hosts that cannot launch a nested sandbox still retain its failed
        // command. Compare the terminal output to what the provider received.
        expect(completion.status).toBe(
          completion.exitCode === 0 ? 'completed' : 'failed',
        );
        expect(completion.output?.trim()).toBeTruthy();
        expect(JSON.stringify(server.requests.at(-1)?.input)).toContain(
          JSON.stringify(completion.output?.trim()).slice(1, -1),
        );
      }
      checkpoint = await session.saveState();
    }
    {
      await using resumed = await agent.session({
        state: checkpoint,
        instructionFiles: [source],
      });
      const [turn] = await collect(resumed.turns());
      expect(turn?.id).toBe(turnId);
      expect(turn?.receipt).toMatchObject({
        executors: null,
        developerInstructionsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(
        (await collect(resumed.items())).some(
          (item) => item.type === 'command_execution',
        ),
      ).toBe(true);
    }
    server.assertExhausted();
  } finally {
    await executor.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);

it('signals a gap when a native execution completion arrives after the turn stream ends', async () => {
  const native = await binding();
  const next = native.NativeThread.prototype._next_session_events;
  const release = Promise.withResolvers<void>();
  let delayed: NativeEventBatch | undefined;
  let terminalDelivered = false;
  // Reorder one genuine native item. A background exec watcher can publish
  // its completion after the model turn's terminal event.
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    if (terminalDelivered && delayed !== undefined) {
      await release.promise;
      const completion = delayed;
      delayed = undefined;
      return completion;
    }
    for (;;) {
      const raw = await next.call(this);
      const { msg } = JSON.parse(firstNativeBatchWire(raw));
      if (
        msg.type === 'item_completed' &&
        msg.item?.type === 'CommandExecution' &&
        msg.item.id === 'late-command'
      ) {
        delayed = raw;
        continue;
      }
      if (msg.type === 'task_complete' || msg.type === 'turn_complete')
        terminalDelivered = true;
      return raw;
    }
  });
  const executor = await startPublicExecutor();
  try {
    const server = new ModelServer([
      [
        call(
          'exec_command',
          { cmd: 'printf late', login: false },
          { callId: 'late-command' },
        ),
      ],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-late-execution-provider',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Run the fixture command.',
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        approval: () => true,
      }),
    });
    try {
      const turn = await session.submit('Run it.');
      const records = await collect(turn.events());
      expect(records.at(-1)).toMatchObject({ type: 'turn_finished' });
      expect(delayed).toBeDefined();
      const events = session.events({ after: records.at(-1)!.sequence });
      const nextEvent = events.next();
      release.resolve();
      expect(await nextEvent).toMatchObject({
        done: false,
        value: { type: 'gap' },
      });
      await events.return?.();
      expect(await collect(session.items())).toContainEqual(
        expect.objectContaining({
          type: 'command_execution',
          callId: 'late-command',
          turnId: turn.turnId,
          threadId: session.id,
        }),
      );
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  } finally {
    await executor.close();
  }
}, 30_000);
