import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  StdioMCP,
  type Session,
  type MCPMetadataContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

let directory: string;
const sessions: Session[] = [];
const providers: NativeProvider[] = [];
beforeEach(async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-metadata');
  directory = await mkdtemp(join(tmpdir(), 'agents-mcp-metadata-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(providers.splice(0).map((p) => p.close()));
  await ModelServer.closeAll();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function setup(
  resolver: (ctx: MCPMetadataContext) => unknown,
  inCode = false,
  policies = false,
  state?: Awaited<ReturnType<Session['saveState']>>,
) {
  const roster = join(directory, 'roster.json'),
    calls = join(directory, 'calls.jsonl'),
    starts = join(directory, 'starts.jsonl');
  await Promise.all([
    writeFile(calls, ''),
    writeFile(starts, ''),
    writeFile(
      roster,
      JSON.stringify({
        tools: [
          {
            name: 'lookup',
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        ],
        result: { content: [{ type: 'text', text: 'record' }] },
      }),
    ),
  ]);
  const order: string[] = [];
  const declaration = new StdioMCP({
    name: 'fixture',
    tools: ['lookup'],
    approvalMode: 'preapproved',
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'mcp-peer.mjs'), roster, calls, starts],
    ...(policies
      ? {
          before: () => {
            order.push('before');
            return {
              action: 'replaceArguments' as const,
              arguments: { key: 'effective' },
            };
          },
          approval: () => {
            order.push('approval');
            return true;
          },
        }
      : {}),
    requestMetadata: async (ctx) => {
      order.push('metadata');
      return (await resolver(ctx)) as never;
    },
  });
  const first = inCode
    ? {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'metadata-call',
        input: 'text(await tools.mcp__fixture__lookup({key:"original"}));',
      }
    : call(
        'lookup',
        { key: 'original' },
        { callId: 'metadata-call', namespace: 'mcp__fixture' },
      );
  const model = new ModelServer([[first], [message('done')]]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  providers.push(provider);
  const agent = new Agent({
    instructions: 'Read the record.',
    model: 'gpt-5',
    provider,
    programmaticToolCalling: inCode,
    tools: [declaration],
  });
  const session = await agent.session(state ? { state } : undefined);
  sessions.push(session);
  return { session, model, order, calls, agent };
}
async function records(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'metadata proof code=%s reserved=%s',
  async (inCode, reserved) => {
    const secret = 'private-metadata-3174';
    const contexts: MCPMetadataContext[] = [];
    const { session, model, order, calls } = await setup(
      (ctx) => {
        contexts.push(ctx);
        expect(ctx.arguments).toEqual({ key: 'effective' });
        return {
          'app/default': 'base',
          [reserved ? 'callId' : 'app/current']: secret,
        };
      },
      inCode,
      true,
    );
    const turn = await session.submit('read');
    if (reserved) {
      await expect(turn.wait()).rejects.toThrow(/Native MCP/);
      expect(model.requests).toHaveLength(2); // Existing JS MCP failure is surfaced at turn end.
    } else expect((await turn.wait()).finalOutput).toBe('done');
    const actual = await records(calls);
    expect(actual).toHaveLength(reserved ? 0 : 1);
    expect(order).toEqual(['before', 'approval', 'metadata']);
    expect(contexts).toHaveLength(1);
    if (!reserved) {
      expect(actual[0].arguments).toEqual({ key: 'effective' });
      expect(actual[0]._meta['app/current']).toBe(secret);
      expect(actual[0]._meta.callId).not.toBe(secret);
    }
    expect(JSON.stringify(model.requests)).not.toContain(secret);
    if (process.env.MCP_METADATA_EVIDENCE)
      await writeFile(
        join(
          process.env.MCP_METADATA_EVIDENCE,
          `code-${inCode}-reserved-${reserved}.json`,
        ),
        JSON.stringify(
          { requests: model.requests, toolCalls: actual, callbackOrder: order },
          null,
          2,
        ),
      );
  },
  20_000,
);

const RESERVED = [
  'callId',
  'x-codex-turn-metadata',
  '_codex_apps',
  'plugin_id',
  'openai/confirmation_policies',
  'threadId',
  'sessionId',
  'windowId',
  'itemId',
  'codex/sandbox-state-meta',
  'codex_bridge_mcp_call_id',
  'openai/entitlementContext',
  'openai/readOnly',
  'traceparent',
  'tracestate',
  'progressToken',
];
it.each([undefined, null, {}, { 'app/value': [null, true, 2, 'ok'] }])(
  'metadata optional JSON value %j',
  async (value) => {
    let seen = 0;
    const { session, model, calls } = await setup(() => {
      seen++;
      return value;
    });
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    const actual = await records(calls);
    expect(actual).toHaveLength(1);
    expect(typeof actual[0]._meta.callId).toBe('string');
    expect(seen).toBe(1);
    expect(model.requests).toHaveLength(2);
  },
);
it.each([
  ...RESERVED,
  'array',
  'nan',
  'infinity',
  'bigint',
  'function',
  'oversized',
  'exception',
])(
  'invalid metadata %s never dispatches',
  async (kind) => {
    const secret = 'private-error-payload-9219';
    const { session, model, calls } = await setup(() => {
      if (kind === 'exception') throw new Error(secret);
      if (kind === 'array') return [];
      if (kind === 'nan') return { 'app/value': NaN };
      if (kind === 'infinity') return { 'app/value': Infinity };
      if (kind === 'bigint') return { 'app/value': 1n };
      if (kind === 'function') return { 'app/value': () => secret };
      if (kind === 'oversized')
        return { 'app/value': 'x'.repeat(1024 * 1024 + 1) };
      return { [kind]: secret };
    });
    const failure = await (
      await session.submit('read')
    )
      .wait()
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
    expect(await records(calls)).toEqual([]);
    // Native reserved/size rejection is reported at turn end; SDK JSON/exception
    // failures already stop their callback owner before another sample.
    expect(model.requests).toHaveLength(
      RESERVED.includes(kind) || kind === 'oversized' ? 2 : 1,
    );
    expect(JSON.stringify(model.requests)).not.toContain(secret);
  },
  20_000,
);
it('restore selects the fresh declaration and never replays accepted metadata/effects', async () => {
  const old = await setup(() => ({ 'app/owner': 'old-private-metadata-9218' }));
  expect((await (await old.session.submit('old')).wait()).finalOutput).toBe(
    'done',
  );
  expect(await records(old.calls)).toHaveLength(1);
  const saved = await old.session.saveState();
  expect(JSON.stringify(saved)).not.toContain('old-private-metadata-9218');
  await old.session.close();
  let seen = 0;
  const fresh = await setup(
    () => {
      seen++;
      return { 'app/owner': 'fresh-private-metadata-9218' };
    },
    false,
    false,
    saved,
  );
  expect(await records(fresh.calls)).toEqual([]);
  expect((await (await fresh.session.submit('fresh')).wait()).finalOutput).toBe(
    'done',
  );
  const actual = await records(fresh.calls);
  expect(actual).toHaveLength(1);
  expect(actual[0]._meta['app/owner']).toBe('fresh-private-metadata-9218');
  expect(seen).toBe(1);
  expect(JSON.stringify(fresh.model.requests)).not.toContain(
    'private-metadata-9218',
  );
}, 20_000);
it.each([false, true])(
  'close joins held metadata code=%s and never publishes its late return',
  async (inCode) => {
    let entered!: () => void, release!: () => void;
    let returned = false;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { session, calls } = await setup(async () => {
      entered();
      await held;
      returned = true;
      return { 'app/owner': 'late' };
    }, inCode);
    const turn = await session.submit('read');
    const observed = turn.wait().catch((error) => error);
    await started;
    let finished = false;
    const closing = session.close().then(() => {
      finished = true;
    });
    // The callback's physical promise is still held; release it after close starts.
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(finished).toBe(false);
    release();
    await closing;
    await observed;
    expect(returned).toBe(true);
    expect(await records(calls)).toEqual([]);
  },
  20_000,
);
