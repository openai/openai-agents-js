import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Handoff, tool } from '../src';
import { captureTools, protocolToolSpecs } from '../src/runtime/tools';
import { projectProfileCatalog } from '../src/runtime/agent-profiles';

it('captures the current public caller declaration outside its schema', () => {
  const declaration = tool({
    name: 'guarded',
    parameters: z.object({}),
    ...{ allowedCallers: ['code'] as const },
    execute: () => 'value',
  });
  expect(JSON.parse(captureTools([declaration]).specsJson)[0]).toMatchObject({
    allowedCallers: ['code'],
  });
});

it('captures detached caller choices while preserving the omitted v1 declaration', () => {
  const routes: ('direct' | 'code')[] = ['code'];
  const declaration = tool({
    name: 'guarded',
    parameters: z.object({}),
    allowedCallers: routes,
    execute: () => 'value',
  });
  routes.push('direct');
  expect(declaration.allowedCallers).toEqual(['code']);
  expect(Object.isFrozen(declaration.allowedCallers)).toBe(true);
  const ordinary = tool({
    name: 'ordinary',
    parameters: z.object({}),
    execute: () => 'value',
  });
  expect(ordinary.allowedCallers).toBeUndefined();
  expect(JSON.parse(captureTools([ordinary]).specsJson)[0]).not.toHaveProperty(
    'allowedCallers',
  );
});

it.each([
  { routes: [] },
  { routes: ['code', 'code'] },
  { routes: ['unknown'] },
])('rejects invalid caller choices $routes', ({ routes }) => {
  expect(() =>
    tool({
      name: 'guarded',
      parameters: z.object({}),
      allowedCallers: routes as ('direct' | 'code')[],
      execute: () => 'value',
    }),
  ).toThrow('allowedCallers');
});

it('rejects a code-only callback handoff before opening a Session', () => {
  const callback = tool({
    name: 'transfer',
    parameters: z.object({}),
    allowedCallers: ['code'],
    execute: () => 'value',
  });
  expect(
    () => new Handoff(new Agent({ instructions: 'Target.' }), callback),
  ).toThrow('must allow direct model calls');
});

it('retains caller authority on an approval-enabled function declaration', () => {
  const declaration = tool({
    name: 'guarded',
    parameters: z.object({}),
    needsApproval: true,
    allowedCallers: ['code'],
    execute: () => 'value',
  });
  expect(JSON.parse(captureTools([declaration]).specsJson)[0]).toMatchObject({
    allowedCallers: ['code'],
  });
});

it('matches portable protocol schemas while retaining current profile caller authority', () => {
  const declaration = tool({
    name: 'guarded',
    parameters: z.object({}),
    allowedCallers: ['code'],
    execute: () => 'value',
  });
  const catalog = captureTools([declaration]);
  const specs = protocolToolSpecs(catalog);
  expect(specs[0]).not.toHaveProperty('allowedCallers');
  expect(projectProfileCatalog(catalog, specs).tools[0]).toMatchObject({
    allowedCallers: ['code'],
  });
  expect(JSON.parse(catalog.specsJson)[0]).toHaveProperty('allowedCallers', [
    'code',
  ]);
});
