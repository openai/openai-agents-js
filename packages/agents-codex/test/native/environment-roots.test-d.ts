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

import type { LocalStorageMount } from '@openai/agents';
const storageMount: LocalStorageMount = {
  source: '/data',
  destination: '/data',
  strategy: 'local_bind',
};
Environment.local({ cwd: '/workspace', mounts: [storageMount] });
Environment.local({ cwd: '/workspace', writePolicy: 'strict' });
Environment.local({
  cwd: '/workspace',
  // @ts-expect-error Local environments require strict writes.
  writePolicy: 'legacy',
});
new Environment({
  url: 'wss://executor.invalid',
  cwd: '/workspace',
  writePolicy: 'legacy',
});
new Environment({
  // @ts-expect-error Mounts belong only to local environments.
  url: 'wss://executor.invalid',
  cwd: '/workspace',
  mounts: [storageMount],
});
const implicitMount: LocalStorageMount = { source: '/data' };
Environment.local({ cwd: '/workspace', mounts: [implicitMount] });
const writableMount: LocalStorageMount = {
  source: '/data',
  // @ts-expect-error Writable local mounts are unsupported.
  readOnly: false,
};
void writableMount;
void implicitMount;
const credentialMount: LocalStorageMount = {
  ...storageMount,
  // @ts-expect-error Provider credentials are not local storage configuration.
  token: 'synthetic',
};
void credentialMount;

const localReads = Environment.local({
  cwd: '/workspace',
  readOnlyRoots: directories,
});
expectTypeOf(localReads.readOnlyRoots).toEqualTypeOf<
  readonly string[] | undefined
>();
// @ts-expect-error The captured grants are readonly.
localReads.readOnlyRoots?.push('/new');
new Environment({
  // @ts-expect-error Read-only roots belong only to local environments.
  url: 'wss://executor.invalid',
  cwd: '/workspace',
  readOnlyRoots: directories,
});
