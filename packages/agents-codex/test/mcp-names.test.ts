import { expect, it } from 'vitest';
import { projectMcpToolNames } from '../src/runtime/mcp-names';
import { projectMcpToolNames as compatibilityProjection } from '../src/runtime/mcp';
import vectors from './native/fixtures/mcp-projection.json';

const servers = [...new Set(vectors.map((row) => row.server))].map((name) => ({
  name,
  tools: vectors.filter((row) => row.server === name).map((row) => row.raw),
}));

it.each(vectors)('preserves the Core vector $server / $raw', (row) => {
  for (const catalog of [servers, [...servers].reverse()]) {
    expect(
      projectMcpToolNames(catalog).get(JSON.stringify([row.server, row.raw])),
    ).toEqual({ namespace: row.namespace, name: row.name });
  }
});

it.each([
  [true, 'team-a', 'mcp__team_a', 'lookup_tool'],
  [false, 'team-a', 'team-a', 'lookup-tool'],
  [true, 'mcp__docs', 'mcp__docs', 'lookup_tool'],
  [false, 'mcp__docs', 'mcp__docs', 'lookup-tool'],
] as const)('preserves prefix=%s for %s', (prefix, server, namespace, name) => {
  expect(
    projectMcpToolNames([{ name: server, tools: ['lookup-tool'] }], prefix).get(
      JSON.stringify([server, 'lookup-tool']),
    ),
  ).toEqual({ namespace, name });
});

it('retains the same function through the MCP compatibility export', () => {
  expect(compatibilityProjection).toBe(projectMcpToolNames);
});

it.each(['', 'nul\0name', '\ud800', '\udc00'])(
  'rejects invalid raw identity %j',
  (raw) => {
    expect(() => projectMcpToolNames([{ name: 'docs', tools: [raw] }])).toThrow(
      'MCP raw identities require nonempty valid Unicode without NUL',
    );
  },
);

it('rejects duplicate raw tool names', () => {
  expect(() =>
    projectMcpToolNames([{ name: 'docs', tools: ['lookup', 'lookup'] }]),
  ).toThrow('MCP raw tool names must be unique');
});
