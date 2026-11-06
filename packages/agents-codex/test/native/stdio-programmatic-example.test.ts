import {
  runSales,
  scriptedSales,
  type Sales,
} from '../../../../examples/codex/stdio-programmatic/programmatic-tools';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  customToolCall,
  httpError,
  text,
  toolCall,
  withScriptedResponses,
} from '@openai/agents/testing';
import { catalogAgent } from '../../../../examples/codex/stdio-programmatic/local-mcp';

it.each([
  {
    selected: 'lookpu',
    failStart: false,
    diagnosis: /did not confirm every selected tool ready/,
  },
  {
    selected: 'lookup',
    failStart: true,
    diagnosis: /MCP publication was not confirmed/,
  },
])(
  'closes its owned catalog peer after setup rejection: $selected/$failStart',
  async (options) => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-catalog-recipe-'));
    const audit = join(directory, 'audit.jsonl');
    try {
      await withScriptedResponses([], async (peer) => {
        const agent = catalogAgent(peer.provider, { ...options, audit });
        await expect(
          (async () => {
            await using session = await agent.session();
            await (await session.submit('Read PAPER.')).wait();
          })(),
        ).rejects.toThrow(options.diagnosis);
        expect(peer.requests).toHaveLength(0);
      });
      await vi.waitFor(
        async () => {
          const rows = (await readFile(audit, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; pid: number });
          expect(rows.some((row) => row.event === 'start')).toBe(true);
          expect(rows.some((row) => row.event === 'lookup')).toBe(false);
          for (const row of rows.filter((entry) => entry.event === 'start')) {
            expect(() => process.kill(row.pid, 0)).toThrow(
              expect.objectContaining({ code: 'ESRCH' }),
            );
          }
        },
        { timeout: 8000 },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it.each([false, true])(
  'runs real catalog lookup and joins peer exit (model failure: %s)',
  async (failModel) => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-catalog-live-'));
    const audit = join(directory, 'audit.jsonl');
    try {
      await withScriptedResponses(
        [
          [
            toolCall(
              'lookup',
              { sku: 'PAPER' },
              { callId: 'lookup', namespace: 'mcp__catalog' },
            ),
          ],
          failModel ? httpError(400) : [text('It costs 5 dollars.')],
        ],
        async (peer) => {
          await using session = await catalogAgent(peer.provider, {
            audit,
          }).session();
          const result = (await session.submit('Price of PAPER?')).wait();
          if (failModel) await expect(result).rejects.toThrow();
          else expect((await result).finalOutput).toBe('It costs 5 dollars.');
          expect(peer.toolOutput('lookup')).toContain('PAPER: 5 dollars');
          const rows = (await readFile(audit, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; pid: number });
          expect(rows.filter((row) => row.event === 'lookup')).toHaveLength(1);
          const starts = rows.filter((row) => row.event === 'start');
          expect(starts.length).toBeGreaterThan(0);
          for (const start of starts)
            expect(() => process.kill(start.pid, 0)).not.toThrow();
          expect(
            JSON.stringify(await Array.fromAsync(session.items())),
          ).toContain('PAPER: 5 dollars');
        },
      );
      await vi.waitFor(
        async () => {
          const rows = (await readFile(audit, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; pid: number });
          for (const start of rows.filter((row) => row.event === 'start')) {
            expect(() => process.kill(start.pid, 0)).toThrow(
              expect.objectContaining({ code: 'ESRCH' }),
            );
          }
        },
        { timeout: 8000 },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it('runs real V8 aggregation with application calls and history readback', async () => {
  const result = await scriptedSales();
  expect(result.finalOutput).toBe('Paper sales total 50 dollars.');
  expect(result.context.regions).toEqual(['north', 'south']);
  expect(result.context.calls).toHaveLength(2);
  for (const call of result.context.calls) {
    expect(call.tool.name).toBe('regional_sales');
    expect(call.route).toBe('code');
    expect(call.cellId).toEqual(expect.any(String));
    expect(call.nestedCallId).toEqual(expect.any(String));
  }
  expect(
    new Set(result.context.calls.map((call) => call.nestedCallId)).size,
  ).toBe(2);
  expect(JSON.stringify(result.items)).toContain('50');
}, 30_000);

it('rejects an unsupported region in V8 without running the application effect', async () => {
  await withScriptedResponses(
    [
      [
        customToolCall(
          'exec',
          'text(await tools.regional_sales({region: "west"}));',
          { callId: 'invalid-region' },
        ),
      ],
    ],
    async (peer) => {
      const context: Sales = { calls: [], regions: [] };
      await expect(runSales(peer.provider, context)).rejects.toThrow(
        /Invalid option/,
      );
      expect(context.regions).toEqual([]);
      expect(context.calls).toEqual([]);
      expect(peer.requests).toHaveLength(1);
    },
  );
}, 30_000);
