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

it('captures public overrides while retaining raw selection and narrowed names', async () => {
  const { HttpMCP, mcpConfig, selectHttpLeaves } =
    await import('../src/runtime/mcp');
  const overrides = { 'source/first': 'lookup', 'source/second': 'lookup' };
  const server = new HttpMCP({
    name: 'docs',
    url: 'https://example.invalid/mcp',
    tools: Object.keys(overrides),
    toolNameOverrides: overrides,
    approvalMode: 'preapproved',
  });
  overrides['source/first'] = 'later_mutation';
  const first = server.tool('source/first');
  const second = server.tool('source/second');
  expect(first.name).not.toBe(second.name);
  expect(first.name).toMatch(/^lookup_[a-f0-9]{12}$/);
  const narrowed = selectHttpLeaves(server, ['source/second']);
  expect(narrowed.tool('source/second')).toEqual(second);
  expect((mcpConfig([narrowed]).docs as { tools: unknown }).tools).toEqual({
    'source/first': { name_override: 'lookup' },
    'source/second': { name_override: 'lookup', approval_mode: 'approve' },
  });
});

it('keeps prototype-like raw names in the ordinary name domain', async () => {
  const { HttpMCP } = await import('../src/runtime/mcp');
  const server = new HttpMCP({
    name: 'docs',
    url: 'https://example.invalid/mcp',
    tools: ['__proto__', 'constructor'],
    toolNameOverrides: JSON.parse('{"__proto__":"public_tool"}'),
  });
  expect(server.tool('__proto__').name).toBe('public_tool');
  expect(server.tool('constructor').name).toBe('constructor');
});
