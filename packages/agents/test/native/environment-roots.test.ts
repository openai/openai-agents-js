import { expect, it } from 'vitest';
import { Environment } from '@openai/agents';
import { environmentConfig } from '../../src/runtime/environment';

const connection = {
  url: 'wss://executor.invalid/connection',
  cwd: '/workspace',
};

it('preserves omitted roots separately from an explicitly empty selection', () => {
  expect(environmentConfig(new Environment(connection))).not.toHaveProperty(
    'capability_directories',
  );
  expect(
    environmentConfig(
      new Environment({ ...connection, capabilityDirectories: undefined }),
    ),
  ).not.toHaveProperty('capability_directories');
  expect(
    environmentConfig(
      new Environment({ ...connection, capabilityDirectories: [] }),
    ),
  ).toHaveProperty('capability_directories', []);
});

it('captures immutable directories before the caller can change the array', () => {
  const directories = ['/remote/selected'];
  const environment = new Environment({
    ...connection,
    capabilityDirectories: directories,
  });
  directories[0] = '/remote/replaced';
  directories.push('/remote/unselected');
  expect(Object.isFrozen(environment.capabilityDirectories)).toBe(true);
  expect(environmentConfig(environment).capability_directories).toEqual([
    'file:///remote/selected',
  ]);
});

it.each([
  ['/remote/skill catalog', 'file:///remote/skill%20catalog'],
  ['C:\\skills\\catalog', 'file:///C:/skills/catalog'],
  ['\\\\server\\share\\catalog', 'file://server/share/catalog'],
  ['file:///remote/catalog', 'file:///remote/catalog'],
])('normalizes the remote directory %s', (path, uri) => {
  const environment = new Environment({
    ...connection,
    capabilityDirectories: [path],
  });
  expect(environmentConfig(environment).capability_directories).toEqual([uri]);
});

it.each([
  '',
  'relative',
  'file:relative',
  'C:relative',
  '\\root-relative',
  'file:///remote/catalog?query',
  'file:///remote/catalog#fragment',
])(
  'rejects a directory without an absolute unambiguous remote path: %s',
  (path) => {
    expect(
      () => new Environment({ ...connection, capabilityDirectories: [path] }),
    ).toThrow();
  },
);

it.each([{ value: null }, { value: '/remote/catalog' }, { value: [1] }])(
  'rejects malformed JavaScript directory input %j',
  ({ value }) => {
    expect(
      () =>
        new Environment({
          ...connection,
          capabilityDirectories: value as never,
        }),
    ).toThrow();
  },
);
