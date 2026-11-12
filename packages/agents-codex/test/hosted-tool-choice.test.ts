import { expect, it } from 'vitest';
import {
  captureModelSettings,
  modelOverrides,
  type ModelSettings,
} from '../src/runtime/provider';
import { toolRef } from '../src/runtime/tools';

it('captures and projects explicit hosted choice without granting a named function', () => {
  const controls = modelOverrides(undefined, {
    toolChoice: { type: 'web_search' },
  });
  expect(controls).toEqual({
    tool_choice: 'required',
    request_controls: {
      named_tool_choice: null,
      hosted_tool_choice: { type: 'web_search' },
    },
  });
  expect(
    modelOverrides(undefined, {
      toolChoice: toolRef('web_search', 'application'),
    }),
  ).toEqual({
    tool_choice: 'required',
    request_controls: {
      named_tool_choice: { name: 'web_search', namespace: 'application' },
    },
  });
});

it('copies a hosted MCP selector before awaits and preserves portable declarations', () => {
  const choice = {
    type: 'mcp' as const,
    serverLabel: 'captured-server',
    name: 'lookup',
  };
  const captured = captureModelSettings({ toolChoice: choice });
  choice.serverLabel = 'different-server';
  expect(modelOverrides(undefined, captured)).toEqual(
    modelOverrides(undefined, JSON.parse(JSON.stringify(captured))),
  );
  expect(modelOverrides(undefined, captured)).toEqual({
    tool_choice: 'required',
    request_controls: {
      named_tool_choice: null,
      hosted_tool_choice: {
        type: 'mcp',
        server_label: 'captured-server',
        name: 'lookup',
      },
    },
  });
});

it.each([
  { type: 'function', name: 'web_search' },
  { type: 'web_search', name: 'hidden' },
  { type: 'mcp', serverLabel: ' ' },
  { type: 'unknown' },
])('rejects unsupported selector authority %j', (choice) => {
  expect(() =>
    captureModelSettings({ toolChoice: choice } as unknown as ModelSettings),
  ).toThrow(/hosted/i);
});
