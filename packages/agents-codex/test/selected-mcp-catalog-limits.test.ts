import { expect, it } from 'vitest';
import { selectMcpTools } from '../src';
import {
  BorrowedPeer,
  borrowedDeclaration,
} from './native/fixtures/borrowed-mcp';

it.each(['name', 'utf8', 'aggregate', 'count'] as const)(
  'rejects an excessive discovered %s catalog before filtering',
  async (kind) => {
    const names =
      kind === 'name'
        ? ['x'.repeat(4097)]
        : kind === 'utf8'
          ? ['😀'.repeat(1025)]
          : kind === 'aggregate'
            ? Array.from(
                { length: 257 },
                (_, index) => String(index).padStart(4, '0') + 'x'.repeat(4092),
              )
            : Array.from({ length: 16385 }, (_, index) => `tool_${index}`);
    const expected =
      kind === 'aggregate'
        ? '1048576-byte'
        : kind === 'count'
          ? '16384-tool'
          : '4096-byte';
    const server = new BorrowedPeer();
    server.declarations = names.map((name) => ({
      ...borrowedDeclaration(),
      name,
    }));
    server.toolFilter = { allowedToolNames: ['unrelated'] };

    await expect(
      selectMcpTools({ name: 'records', server }, { context: undefined }),
    ).rejects.toThrow(expected);
    expect(server.listTools).toHaveBeenCalledTimes(1);
    expect(server.callTool).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
  },
);

it('accepts boundary-sized ASCII and Unicode names with native projections', async () => {
  const names = ['x'.repeat(4096), '😀'.repeat(1024)];
  const server = new BorrowedPeer();
  server.declarations = names.map((name) => ({
    ...borrowedDeclaration(),
    name,
  }));
  const tools = await selectMcpTools(
    { name: 'records', server },
    { context: undefined, toolNames: names },
  );
  expect(tools).toHaveLength(2);
  expect(new Set(tools.map((tool) => tool.name)).size).toBe(2);
  for (const tool of tools)
    expect(tool.namespace!.length + tool.name.length + 2).toBeLessThanOrEqual(
      128,
    );
  expect(server.close).not.toHaveBeenCalled();
});
