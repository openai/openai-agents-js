import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  captureHostedTool,
  getClientToolSearchExecutor,
  hostedToolSpecs,
  toolSearch,
  type ToolSearchOptions,
} from '../src/runtime/hosted-tools';
import { splitToolDeclarations } from '../src/runtime/mcp';
import { captureTools, tool } from '../src/runtime/tools';

it('captures the client callback separately from detached provider configuration', () => {
  const execute = () => null;
  const options: ToolSearchOptions = {
    execution: 'client',
    description: 'Select support tools.',
    parameters: {
      type: 'object',
      properties: { department: { type: 'string' } },
    },
    execute,
  };
  const search = toolSearch(options);
  options.description = 'changed';
  options.parameters = {};
  options.execute = () => undefined;
  const captured = captureHostedTool(search);
  expect(captured.kind).toBe('tool_search');
  if (captured.kind !== 'tool_search')
    throw new Error('Expected search declaration');
  expect(getClientToolSearchExecutor(captured)).toBe(execute);
  expect(hostedToolSpecs([captured])).toEqual([
    {
      type: 'tool_search',
      execution: 'client',
      description: 'Select support tools.',
      parameters: {
        type: 'object',
        properties: { department: { type: 'string' } },
      },
    },
  ]);
  expect(JSON.stringify(captured)).not.toContain('execute');
});

it('projects a typed client slot while preserving the single provider declaration', () => {
  const search = toolSearch({ execution: 'client' });
  const declarations = splitToolDeclarations([search]);
  expect(declarations.hostedTools).toHaveLength(1);
  expect(JSON.parse(captureTools(declarations.tools).specsJson)).toEqual([
    {
      type: 'toolSearch',
      declaration: { type: 'tool_search', execution: 'client' },
    },
  ]);
});

it('preserves the collision rejection for ordinary functions', () => {
  const search = toolSearch({ execution: 'client' });
  const collision = tool({
    name: 'tool_search',
    parameters: z.object({}),
    execute: () => 'ordinary',
  });
  expect(() => splitToolDeclarations([search, collision])).toThrow();
});
