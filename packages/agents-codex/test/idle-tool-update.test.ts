import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  captureAdmittedToolUpdate,
  captureTools,
  tool,
  toolDeclarationIdentity,
} from '../src/runtime/tools';
import { manualTool } from '../src/runtime/manual';
import {
  bindHostedMcp,
  HostedMcpBinding,
} from '../src/runtime/hosted-mcp-binding';

const lookup = (name: string, description: string) =>
  tool({
    name,
    description,
    parameters: z.object({}),
    execute: () => description,
  });

it('captures replacements in request order and retains catalog order and omitted owners', () => {
  const first = lookup('first', 'original first');
  const second = lookup('second', 'original second');
  const replacement = lookup('first', 'replacement first');
  const current = captureTools([first, second], 7n);
  const { candidate, replacements } = captureAdmittedToolUpdate(
    [second, replacement],
    current,
    11n,
    [],
    undefined,
    false,
  );
  expect(replacements.tools.map((binding) => binding.name)).toEqual([
    'second',
    'first',
  ]);
  expect(candidate.tools.map((binding) => binding.description)).toEqual([
    'replacement first',
    'original second',
  ]);
  expect(candidate.generation).toBe(11n);
  expect(toolDeclarationIdentity(candidate.tools[0])).toBe(replacement);
  expect(toolDeclarationIdentity(candidate.tools[1])).toBe(second);
  const omitted = captureAdmittedToolUpdate(
    [replacement],
    current,
    12n,
    [],
    undefined,
    false,
  );
  expect(toolDeclarationIdentity(omitted.candidate.tools[1])).toBe(second);
  expect(current.generation).toBe(7n);
  expect(current.tools[0].description).toBe('original first');
});

it('allows recaptured callback owners and rejects same-name callback replacement', () => {
  const callback = lookup('handoff', 'callback');
  const current = captureTools([callback]);
  const accepted = captureAdmittedToolUpdate(
    current.tools,
    current,
    1n,
    [],
    [callback],
    false,
  );
  expect(toolDeclarationIdentity(accepted.candidate.tools[0])).toBe(callback);
  expect(() =>
    captureAdmittedToolUpdate(
      [lookup('handoff', 'other')],
      current,
      1n,
      [],
      [callback],
      false,
    ),
  ).toThrow('A captured handoff callback cannot be replaced');
  expect(toolDeclarationIdentity(current.tools[0])).toBe(callback);
});

it('checks fixed hosted MCP configuration before callback ownership', () => {
  const original = bindHostedMcp(
    { ...lookup('records', 'records'), namespace: 'hosted_mcp' },
    new HostedMcpBinding({
      type: 'mcp',
      server_label: 'records',
      server_url: 'https://original.invalid/mcp',
    }),
  );
  const changed = bindHostedMcp(
    { ...lookup('records', 'changed'), namespace: 'hosted_mcp' },
    new HostedMcpBinding({
      type: 'mcp',
      server_label: 'records',
      server_url: 'https://changed.invalid/mcp',
    }),
  );
  const current = captureTools([original]);
  expect(() =>
    captureAdmittedToolUpdate([changed], current, 1n, [], [original], false),
  ).toThrow('Hosted MCP server configuration is fixed');
});

it('checks replacement capture before manual storage compatibility', () => {
  const manual = manualTool({
    name: 'lookup',
    description: 'Lookup',
    parameters: z.object({}),
    result: z.string(),
  });
  const current = captureTools([manual]);
  expect(() =>
    captureAdmittedToolUpdate(
      [manual, manual],
      current,
      1n,
      [],
      undefined,
      true,
    ),
  ).toThrow('Duplicate tool');
  expect(() =>
    captureAdmittedToolUpdate([manual], current, 1n, [], undefined, true),
  ).toThrow('Custom canonical storage does not support manual tools');
  expect(current.generation).toBe(0n);
  expect(toolDeclarationIdentity(current.tools[0])).toBe(manual);
});
