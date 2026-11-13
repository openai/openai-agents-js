import { expect, it } from 'vitest';
import {
  Environment,
  dockerStdioEnvironment,
  environmentConfig,
  projectEnvironment,
} from '../src/runtime/environment';
const command = {
  program: '/usr/bin/docker',
  args: [
    '--host',
    'unix:///synthetic.sock',
    'exec',
    'owned-resource',
    '/tools/server',
  ],
  env: { PATH: '/usr/bin:/bin' },
};
const source = () =>
  dockerStdioEnvironment(
    {
      url: 'docker://owned-resource',
      cwd: '/workspace',
      tools: ['project_glob', 'project_grep'],
    },
    command,
  );
it('has been retaining Docker launcher authority before constructor validation of a narrowed projection', () => {
  const owner = source();
  const projected = projectEnvironment(owner, {
    url: owner.url,
    cwd: '/workspace/subdir',
    tools: ['project_grep'],
    writableRoots: [],
  });
  expect(environmentConfig(projected)).toMatchObject({
    stdio_command: command,
    cwd: 'file:///workspace/subdir',
  });
  expect(projected.tools).toEqual(['project_grep']);
  expect(
    () => new Environment({ url: owner.url, cwd: '/workspace', tools: [] }),
  ).toThrow();
});
it('has been rejecting a Docker projection onto a different resource', () => {
  expect(() =>
    projectEnvironment(source(), {
      url: 'docker://another-resource',
      cwd: '/workspace',
      tools: [],
    }),
  ).toThrow('transport authority');
});
it('has been rejecting an unbranded remote declaration as Docker projection authority', () => {
  const ordinary = new Environment({
    url: 'wss://synthetic.invalid',
    cwd: '/workspace',
    tools: [],
  });
  expect(() =>
    projectEnvironment(ordinary, {
      url: 'docker://owned-resource',
      cwd: '/workspace',
      tools: [],
    }),
  ).toThrow();
});
