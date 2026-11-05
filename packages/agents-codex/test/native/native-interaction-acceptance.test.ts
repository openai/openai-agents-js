import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeProvider,
  Runner,
} from '@openai/agents';
import { TurnAborted } from '../../src/runtime/session';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

const native = describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

async function executorFixture(
  route: 'exec' | 'patch',
  mode: 'approval' | 'workspace' | 'protected' = 'approval',
) {
  const executor = await startPublicExecutor();
  let provider: NativeProvider | undefined;
  try {
    const target = join(
      executor.cwd,
      ...(mode === 'approval'
        ? ['..', 'unanswered-proof']
        : mode === 'workspace'
          ? ['workspace-proof']
          : ['.git', 'protected-proof']),
    );
    if (mode === 'protected') {
      await mkdir(join(executor.cwd, '.git'));
      await writeFile(join(executor.cwd, '.git', 'retained'), 'retained');
    }
    const model = new ModelServer([
      [
        route === 'exec'
          ? call(
              'exec_command',
              {
                cmd: `printf proof > '${target.replaceAll("'", "'\\''")}'`,
                sandbox_permissions: 'require_escalated',
                justification: 'One fixture-owned write',
              },
              { callId: 'unanswered-action' },
            )
          : {
              type: 'custom_tool_call',
              name: 'apply_patch',
              call_id: 'unanswered-action',
              input: `*** Begin Patch\n*** Add File: ${target}\n+proof\n*** End Patch`,
            },
      ],
      ...(mode === 'approval' ? [] : [[message('finished')]]),
    ]);
    const config = await model.config();
    provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-interaction',
      supportsWebsockets: false,
    });
    const openedProvider = provider;
    const agent = new Agent({
      instructions: 'Perform the requested native operation.',
      model: route === 'patch' ? 'gpt-5.5' : 'gpt-5',
      provider,
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
      ...(mode === 'protected'
        ? { capabilityDirectories: [join(executor.cwd, '.git')] }
        : {}),
    });
    return {
      agent,
      environment,
      executor,
      model,
      target,
      async [Symbol.asyncDispose]() {
        try {
          await openedProvider.close();
        } finally {
          await executor.close();
        }
      },
    };
  } catch (error) {
    try {
      await provider?.close();
    } finally {
      await executor.close();
    }
    throw error;
  }
}

native('unattended native interactions', () => {
  for (const entrypoint of ['Agent.run', 'Runner.run'] as const) {
    for (const route of ['exec', 'patch'] as const) {
      it(`${entrypoint}: missing ${route} approval handler fails without a file effect`, async () => {
        await using fixture = await executorFixture(route);
        const options = { environment: fixture.environment };
        const result =
          entrypoint === 'Agent.run'
            ? fixture.agent.run('Write the proof.', options)
            : Runner.run(fixture.agent, 'Write the proof.', options);
        await expect(result).rejects.toBeInstanceOf(InteractionRequired);
        await expect(result).rejects.toThrow(
          'The turn requires an application response',
        );
        await expect(access(fixture.target)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(
          fixture.executor.requests.filter(
            (request) => request.method === 'process/start',
          ),
        ).toHaveLength(0);
        fixture.model.assertExhausted();
      }, 30_000);
    }
  }

  it('an application deadline cancels its unanswered file approval and rejects a late allow', async () => {
    await using fixture = await executorFixture('patch');
    await using session = await fixture.agent.session({
      environment: fixture.environment,
    });
    const turn = await session.submit('Write the proof.');
    const pending = await turn.wait({
      until: 'interaction',
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !('requests' in pending) ||
      pending.requests.length !== 1 ||
      pending.requests[0]?.type !== 'approval_request'
    )
      throw new Error('Expected one real file approval');
    const request = pending.requests[0];
    expect(request.turnId).toBe(turn.turnId);
    expect(request.sessionId).toBe(session.id);
    expect(request.description).toContain(fixture.target);
    const late = request.reply('allow_once');
    expect(await session.pendingInteractions()).toEqual([request]);
    await expect(access(fixture.target)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const terminal = turn.wait();
    const rejected = expect(terminal).rejects.toBeInstanceOf(TurnAborted);
    const stopped = Promise.withResolvers<void>();
    const order: string[] = [];
    const timer = setTimeout(() => {
      order.push('cancellation requested');
      void turn.cancel({ mode: 'force' }).then(() => {
        order.push('cancellation joined');
        stopped.resolve();
      }, stopped.reject);
    }, 20);
    try {
      await stopped.promise;
      await rejected;
      expect(order).toEqual(['cancellation requested', 'cancellation joined']);
      expect(await session.pendingInteractions()).toEqual([]);
      const events = await Array.fromAsync(turn.events());
      expect(events.at(-1)).toMatchObject({
        type: 'turn_finished',
        status: 'cancelled',
        submissionId: turn.submissionId,
        turnId: turn.turnId,
      });
      await expect(session.respond(late)).rejects.toThrow('expired');
      expect(() => request.reply('allow_once')).toThrow('expired');
      await expect(access(fixture.target)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      fixture.model.assertExhausted();
    } finally {
      clearTimeout(timer);
    }
  }, 30_000);

  it('writes its assigned remote workspace without requesting approval', async () => {
    await using fixture = await executorFixture('patch', 'workspace');
    let questions = 0;
    const result = await Runner.run(fixture.agent, 'Write the proof.', {
      environment: fixture.environment,
      onNativeQuestion() {
        questions++;
        throw new Error('Workspace write unexpectedly requested approval');
      },
    });
    expect(result.finalOutput).toBe('finished');
    expect(await readFile(fixture.target, 'utf8')).toBe('proof\n');
    expect(questions).toBe(0);
    const outputs = (fixture.model.requests[1]!.input as JsonObject[]).filter(
      (item) =>
        item.type === 'custom_tool_call_output' &&
        item.call_id === 'unanswered-action',
    );
    expect(outputs).toHaveLength(1);
    expect(String(outputs[0]!.output)).toContain('workspace-proof');
    fixture.model.assertExhausted();
  }, 30_000);

  it('capability discovery does not authorize a protected metadata patch', async () => {
    await using fixture = await executorFixture('patch', 'protected');
    await using session = await fixture.agent.session({
      environment: fixture.environment,
    });
    const turn = await session.submit('Write the protected proof.');
    const pending = await turn.wait({
      until: 'interaction',
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !('requests' in pending) ||
      pending.requests.length !== 1 ||
      pending.requests[0]?.type !== 'approval_request'
    )
      throw new Error('Expected the protected file action to require approval');
    const request = pending.requests[0];
    expect(request.sessionId).toBe(session.id);
    expect(request.turnId).toBe(turn.turnId);
    expect(request.description).toContain(fixture.target);
    await expect(access(fixture.target)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await session.pendingInteractions()).toEqual([request]);
    await session.respond(request.reply('deny'));
    expect((await turn.wait()).finalOutput).toBe('finished');
    await expect(access(fixture.target)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await readFile(join(fixture.executor.cwd, '.git', 'retained'), 'utf8'),
    ).toBe('retained');
    fixture.model.assertExhausted();
  }, 30_000);

  it('Runner reports unselected command, file, MCP and permission calls without authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-unselected-'));
    const target = join(directory, 'proof');
    const calls = [
      call(
        'exec_command',
        { cmd: `printf proof > '${target}'` },
        {
          callId: 'unselected-command',
        },
      ),
      {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'unselected-file',
        input: `*** Begin Patch\n*** Add File: ${target}\n+proof\n*** End Patch`,
      },
      call(
        'mcp__unconfigured__write',
        { path: target },
        {
          callId: 'unselected-mcp',
        },
      ),
      call('request_permissions', {}, { callId: 'unselected-permission' }),
    ];
    const model = new ModelServer([
      calls,
      (request) => {
        const outputs = (request.input as JsonObject[]).filter((item) =>
          ['function_call_output', 'custom_tool_call_output'].includes(
            String(item.type),
          ),
        );
        for (const call of calls) {
          const output = outputs.find((item) => item.call_id === call.call_id);
          expect(output).toBeDefined();
          expect(String(output!.output)).toMatch(
            /unsupported|unknown|not (?:found|available)|unrecognized/i,
          );
        }
        return [message('No requested tool is available.')];
      },
    ]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-unselected',
      supportsWebsockets: false,
    });
    let questions = 0;
    try {
      const agent = new Agent({
        instructions: 'Report unsupported tools without executing them.',
        model: 'gpt-5.5',
        provider,
      });
      const result = await Runner.run(agent, 'Probe unsupported calls.', {
        onNativeQuestion() {
          questions++;
          throw new Error('An unselected tool must not issue a grant');
        },
      });
      expect(result.finalOutput).toBe('No requested tool is available.');
      expect(questions).toBe(0);
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      model.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
