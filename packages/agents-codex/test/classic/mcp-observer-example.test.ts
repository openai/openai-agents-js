import { expect, it } from 'vitest';
import { observeLocalMcpCall } from '../../../../examples/codex/mcp-observers';

it('runs the complete callable MCP observer example without a model or native runtime', async () => {
  expect(await observeLocalMcpCall()).toEqual([
    'start',
    'client',
    'end',
    'returned',
    'closed',
  ]);
});
