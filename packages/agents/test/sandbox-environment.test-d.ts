import { expectTypeOf } from 'vitest';
import {
  Manifest,
  sandboxEnvironment,
  renderStorageLayout,
  type SandboxEnvironmentOptions,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Environment, type EnvironmentSource } from '@openai/agents';
const source = sandboxEnvironment({
  client: new UnixLocalSandboxClient(),
  manifest: new Manifest(),
  connect: async () =>
    Environment.lease(
      new Environment({ url: 'wss://executor.invalid', cwd: '/workspace' }),
      () => {},
    ),
});
expectTypeOf(source).toExtend<EnvironmentSource>();
expectTypeOf(renderStorageLayout(new Manifest())).toEqualTypeOf<string>();
expectTypeOf<SandboxEnvironmentOptions>().toHaveProperty('connect');
