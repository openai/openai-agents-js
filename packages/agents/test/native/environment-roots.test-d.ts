import { expectTypeOf } from 'vitest';
import { Environment } from '@openai/agents';

const directories: readonly string[] = ['/remote/catalog'];
const environment = new Environment({
  url: 'wss://executor.invalid/connection',
  cwd: '/workspace',
  capabilityDirectories: directories,
});
expectTypeOf(environment.capabilityDirectories).toEqualTypeOf<
  readonly string[] | undefined
>();
// @ts-expect-error The captured selection is readonly.
environment.capabilityDirectories = [];
// @ts-expect-error Entries cannot be added to the captured selection.
environment.capabilityDirectories?.push('/remote/new');
