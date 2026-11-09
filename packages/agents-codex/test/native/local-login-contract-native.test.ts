import { afterEach, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment, NativeProvider } from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

// This probe requires a real Linux sandbox. It must fail, rather than skip,
// if Local cannot launch on the capable CI runner.
it.runIf(process.platform === 'linux')(
  'executes omitted-login Local commands in a real non-login Bash shell',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-local-nonlogin-'));
    try {
      const command = [
        'set -eu',
        'test -n "$BASH_VERSION"',
        'if shopt -q login_shell; then printf "UNEXPECTED_LOGIN_SHELL\\n"; exit 71; fi',
        'printf "NATIVE_LOGIN_SHELL=false\\n"',
        'printf "effect-once\\n" >> omitted-login-effect',
      ].join('; ');
      const server = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: command, shell: '/bin/bash', yield_time_ms: 1000 },
            { callId: 'omitted-login' },
          ),
        ],
        [message('non-login confirmed')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-nonlogin',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Run the exact supplied command once.',
        model: 'gpt-5.5',
        provider,
      }).session({
        environment: Environment.local({
          cwd: directory,
          tools: ['exec_command'],
          approval: () => true,
        }),
      });
      expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
        'non-login confirmed',
      );
      expect(
        await readFile(join(directory, 'omitted-login-effect'), 'utf8'),
      ).toBe('effect-once\n');
      expect(server.requests).toHaveLength(2);
      const output = (
        server.requests[1]!.input as Array<Record<string, unknown>>
      ).find(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'omitted-login',
      );
      expect(output).toBeDefined();
      expect(JSON.stringify(output!.output)).toContain(
        'NATIVE_LOGIN_SHELL=false',
      );
      expect(JSON.stringify(output!.output)).not.toContain(
        'UNEXPECTED_LOGIN_SHELL',
      );
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it.runIf(process.platform === 'linux').each([false, true])(
  'rejects explicit Local login=%s before command dispatch',
  async (login) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'agents-local-login-reject-'),
    );
    try {
      const server = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: 'printf forbidden > forbidden-login-effect', login },
            { callId: 'explicit-login' },
          ),
        ],
        [message('healthy')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-login-reject',
        supportsWebsockets: false,
      });
      const approvals: Array<{
        callId: string | null;
        argumentsValue: unknown;
      }> = [];
      await using session = await new Agent({
        instructions: 'Check local execution admission.',
        model: 'gpt-5.5',
        provider,
      }).session({
        environment: Environment.local({
          cwd: directory,
          tools: ['exec_command'],
          approval: (context, argumentsValue) => {
            approvals.push({ callId: context.callId, argumentsValue });
            return true;
          },
        }),
      });
      expect(approvals).toEqual([]);
      await expect((await session.submit('Run.')).wait()).rejects.toThrow(
        /Native executor rejected invalid arguments before dispatch/,
      );
      const offered = (
        server.requests[0]!.tools as Array<Record<string, unknown>>
      ).find((value) => value.name === 'exec_command')!;
      const schema = offered.parameters as {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      };
      expect(Object.hasOwn(schema.properties, 'login')).toBe(false);
      expect(schema.additionalProperties).toBe(false);
      expect(approvals).toEqual([
        {
          callId: 'explicit-login',
          argumentsValue: {
            cmd: 'printf forbidden > forbidden-login-effect',
            login,
          },
        },
      ]);
      await expect(
        access(join(directory, 'forbidden-login-effect')),
      ).rejects.toThrow();
      expect(
        (await (await session.submit('Continue.')).wait()).finalOutput,
      ).toBe('healthy');
      expect(server.requests).toHaveLength(2);
      expect(approvals).toHaveLength(1);
      await expect(
        access(join(directory, 'forbidden-login-effect')),
      ).rejects.toThrow();
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
