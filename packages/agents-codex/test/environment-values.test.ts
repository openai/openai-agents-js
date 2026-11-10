import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { Environment } from '@openai/agents';

it.each([false, true])(
  'captures private environment values with local=%s',
  (local) => {
    const values = JSON.parse(
      '{"TOKEN":"private-environment-value","EMPTY":"","__proto__":"ordinary-value"}',
    ) as Record<string, string>;
    const environment = local
      ? Environment.local({ cwd: process.cwd(), env: values })
      : new Environment({
          url: 'wss://executor.invalid',
          cwd: '/workspace',
          env: values,
        });
    values.TOKEN = 'changed-after-capture';
    expect(environment.env?.TOKEN).toBe('private-environment-value');
    expect(environment.env?.EMPTY).toBe('');
    expect(environment.env?.__proto__).toBe('ordinary-value');
    expect(Object.hasOwn(environment.env!, '__proto__')).toBe(true);
    expect(Object.isFrozen(environment.env)).toBe(true);
    expect(inspect(environment)).not.toContain('private-environment-value');
    expect(JSON.stringify(environment)).not.toContain(
      'private-environment-value',
    );
  },
);

it.each([
  [],
  null,
  { '': 'value' },
  { 'BAD=NAME': 'value' },
  { 'BAD\0NAME': 'value' },
  { CODEX_SDK_BWRAP_SEARCH_PATH: 'private-environment-value' },
  { CARGO_BIN_EXE_bwrap: 'private-environment-value' },
  { CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE: 'private-environment-value' },
  { CODEX_SANDBOX_COMMAND_ENV_JSON: 'private-environment-value' },
  { CODEX_THREAD_ID: 'private-environment-value' },
  { CODEX_SESSION_ID: 'private-environment-value' },
  { CODEX_VERSION: 'private-environment-value' },
  { CODEX_PERMISSION_PROFILE: 'private-environment-value' },
  { CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: 'private-environment-value' },
  { CODEX_PLUGIN_METRICS_OUTPUT: 'private-environment-value' },
  { codex_thread_id: 'private-environment-value' },
  { CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'private-environment-value' },
  { NODE_REPL_AUTH_TOKEN: 'private-environment-value' },
  { CODEX_GUARDIAN_DECISIONS_API_KEY: 'private-environment-value' },
  { OPENAI_FEDERATION_RULE_ID: 'private-environment-value' },
  { OPENAI_IDENTITY_TOKEN_FILE: 'private-environment-value' },
  { OPENAI_WORKLOAD_IDENTITY_CONTEXT: 'private-environment-value' },
  { openai_federation_rule_id: 'private-environment-value' },
  { Node_Repl_Auth_Token: 'private-environment-value' },
  { codex_sdk_bwrap_search_path: 'private-environment-value' },
  { CODEX_SANDBOX_COMMAND_ENV_JSON_0: 'private-environment-value' },
  { codex_sandbox_command_env_json_orphan: 'private-environment-value' },
  { CODEX_SANDBOX_COMMAND_ENV_JSON_é: 'private-environment-value' },
  { NAME: 'bad\0private-environment-value' },
  { NAME: 1 },
  { 'BAD\ud800': 'value' },
  { NAME: 'bad\ud800private-environment-value' },
])('rejects invalid environment values without echoing them: %s', (env) => {
  let caught: unknown;
  try {
    new Environment({
      url: 'wss://executor.invalid',
      cwd: '/workspace',
      env: env as unknown as Record<string, string>,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toMatch(/environment/i);
  expect(String(caught)).not.toContain('private-environment-value');
});
