import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  type ExecutorContext,
} from '@openai/agents';
import type { JsonObject, JsonValue } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Strict command effects require a real filesystem sandbox, which Codex cannot nest.
it.skipIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
    process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1',
)(
  'ordinary approved commands retain writable-workspace and protected-path policy',
  async () => {
    const executor = await startPublicExecutor();
    try {
      await mkdir(join(executor.cwd, '.codex'), { recursive: true });
      const protectedPath = join(executor.cwd, '.codex', 'retained');
      await writeFile(protectedPath, 'retained\n');
      const commands = [
        "printf 'proof\\n' > workspace-proof && printf allowed-workspace",
        "printf 'changed\\n' > .codex/retained && printf unexpected-protected-write",
      ];
      const ids = ['ordinary-workspace-command', 'protected-workspace-command'];
      const model = new ModelServer([
        ...commands.map((cmd, index) => [
          call(
            'exec_command',
            { cmd, workdir: executor.cwd },
            { callId: ids[index]! },
          ),
        ]),
        [message('finished')],
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-approved-workspace',
        supportsWebsockets: false,
      });
      const context = { tenant: 'synthetic-workspace' };
      const approvals: Array<{
        info: ExecutorContext<typeof context>;
        args: JsonValue;
      }> = [];
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        approval(info: ExecutorContext<typeof context>, args) {
          approvals.push({ info, args });
          return true;
        },
      });
      const agent = new Agent<typeof context>({
        instructions: 'Run the two ordinary selected commands.',
        model: 'gpt-5',
        provider,
      });
      await using session = await agent.session({ context, environment });
      const turn = await session.submit(
        'Run the commands under the workspace policy.',
      );
      const result = await turn.wait({ until: 'interaction' });
      if ('requests' in result)
        throw new Error('Ordinary commands requested an escalated approval');
      expect(result.finalOutput).toBe('finished');
      expect(await session.pendingInteractions()).toEqual([]);
      expect(approvals).toHaveLength(2);
      approvals.forEach(({ info, args }, index) => {
        expect(info.submission).toBe(turn);
        expect(info.session).toBe(session);
        expect(info.agent).toBe(agent);
        expect(info.context).toBe(context);
        expect(info.toolName).toBe('exec_command');
        expect(args).toMatchObject({
          cmd: commands[index],
          workdir: executor.cwd,
        });
        expect(args).not.toHaveProperty('sandbox_permissions');
      });
      for (let index = 0; index < ids.length; index++) {
        const outputs = (
          model.requests[index + 1]!.input as JsonObject[]
        ).filter(
          (item) =>
            item.type === 'function_call_output' && item.call_id === ids[index],
        );
        expect(outputs).toHaveLength(1);
        const output = String(outputs[0]!.output);
        if (index === 0) expect(output).toContain('allowed-workspace');
        else {
          expect(output).toMatch(/denied|permission|read-only|not writable/i);
          expect(output).not.toMatch(/^unexpected-protected-write$/m);
        }
      }
      expect(
        await readFile(join(executor.cwd, 'workspace-proof'), 'utf8'),
      ).toBe('proof\n');
      expect(await readFile(protectedPath, 'utf8')).toBe('retained\n');
      model.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);
