import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const PARENT = '00-11111111111111111111111111111111-2222222222222222-01';
const OVERRIDE = '00-33333333333333333333333333333333-4444444444444444-01';
const WORKER = '00-55555555555555555555555555555555-6666666666666666-01';
type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: { key: string; value: Record<string, unknown> }[];
};
const attributes = (span: Span) =>
  Object.fromEntries(
    span.attributes.map((attribute) => [
      attribute.key,
      Object.values(attribute.value)[0],
    ]),
  );

it('exports isolated root parents, queued snapshots, exact callback ancestry, and fresh-worker manual recovery', async () => {
  const spans: Span[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    for (const resource of payload.resourceSpans ?? [])
      for (const scope of resource.scopeSpans ?? []) spans.push(...scope.spans);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) =>
    collector.listen(0, '127.0.0.1', resolve),
  );
  const address = collector.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing collector address');
  const directory = await mkdtemp(join(tmpdir(), 'agents-trace-context-'));
  const child = fileURLToPath(
    new URL('./fixtures/trace-context-child.ts', import.meta.url),
  );
  const run = async (mode: string) => {
    const result = await execute(
      process.execPath,
      [
        '--import',
        'tsx',
        child,
        mode,
        `http://127.0.0.1:${address.port}/v1/traces`,
        join(directory, 'state.json'),
      ],
      {
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, OPENAI_API_KEY: '' },
      },
    );
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  };
  const expectParent = (span: Span, parent: string) => {
    expect(span.traceId).toBe(parent.slice(3, 35));
    expect(span.parentSpanId).toBe(parent.slice(36, 52));
  };
  const dispatch = (turn: string) => {
    const matches = spans.filter(
      (span) =>
        span.name.startsWith('op.dispatch.') &&
        attributes(span)['submission.id'] === turn,
    );
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  try {
    const result = await run('graph');
    for (const [name, parent] of Object.entries({
      first: PARENT,
      queued: OVERRIDE,
      cancelled: OVERRIDE,
      after: PARENT,
      parallel: WORKER,
      idleRestored: WORKER,
    }))
      expectParent(dispatch(result[name]), parent);
    expectParent(dispatch(result.remote), result.callback.traceparent);
    const callback = spans.find(
      (span) => span.spanId === result.callback.traceparent.slice(36, 52),
    );
    expect(callback).toBeDefined();
    const ancestry: Span[] = [];
    for (
      let current = callback;
      current;
      current = spans.find((span) => span.spanId === current!.parentSpanId)
    )
      ancestry.push(current);
    expect(
      ancestry.some((span) => attributes(span).call_id === 'outbound-call'),
    ).toBe(true);
    expect(
      ancestry.some(
        (span) => attributes(span)['submission.id'] === result.first,
      ),
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.name === 'thread_spawn' &&
          span.parentSpanId === PARENT.slice(36, 52),
      ),
    ).toBe(true);
    const source = await run('suspend');
    const resumed = await run('resume');
    expect(resumed.turn).toBe(source.turn);
    const recoveries = spans.filter(
      (span) =>
        span.name.startsWith('op.dispatch.') &&
        attributes(span)['submission.id'] === source.turn,
    );
    expect(
      recoveries.some(
        (span) =>
          span.traceId === PARENT.slice(3, 35) &&
          span.parentSpanId === PARENT.slice(36, 52),
      ),
    ).toBe(true);
    expect(
      recoveries.some(
        (span) =>
          span.traceId === WORKER.slice(3, 35) &&
          span.parentSpanId === WORKER.slice(36, 52),
      ),
    ).toBe(true);
  } finally {
    collector.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
