import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startCollector } from '../../../../examples/codex/observability/collector';
import {
  artifactJson,
  readHistory,
} from '../../../../examples/codex/observability/history-reader';
import type { walkthrough } from '../../../../examples/codex/observability/trace-walkthrough';

type WalkthroughArtifact = Awaited<ReturnType<typeof walkthrough>>;

const exec = promisify(execFile);
const child = fileURLToPath(
  new URL(
    '../../../../examples/codex/observability/trace-walkthrough.ts',
    import.meta.url,
  ),
);
type ObjectRow = Record<string, any>; // The fixture inspects received JSON, not an SDK event schema.

function rows(batches: ObjectRow[], signal: 'traces' | 'logs'): ObjectRow[] {
  const [resource, scope, entries] =
    signal === 'traces'
      ? ['resourceSpans', 'scopeSpans', 'spans']
      : ['resourceLogs', 'scopeLogs', 'logRecords'];
  return batches
    .filter((batch) => batch.signal === signal)
    .flatMap((batch) =>
      batch.data[resource].flatMap((value: ObjectRow) =>
        value[scope].flatMap((value: ObjectRow) => value[entries]),
      ),
    );
}
function attributes(row: ObjectRow): ObjectRow {
  return Object.fromEntries(
    row.attributes.map((entry: ObjectRow) => [
      entry.key,
      Object.values(entry.value)[0],
    ]),
  );
}

for (const [scenario, outcome, callback] of [
  ['tool-error', 'tool_returned_error', 'returned_error'],
  ['tool', 'tool_callback_exception', 'threw'],
  ['validation', 'output_validation_failure', 'not_called'],
  ['provider', 'provider_failure', 'not_called'],
]) {
  it(`receives real trace/log records and separate application settlement: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observability-'));
    try {
      const output = join(directory, 'receipt.json');
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      // Successful return proves natural child exit; the watchdog fails leaked ownership.
      const result = await exec(
        process.execPath,
        ['--import', 'tsx', child, '--scenario', scenario, '--output', output],
        {
          env,
          timeout: 45_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const encoded = await readFile(output, 'utf8');
      const artifact = JSON.parse(encoded) as WalkthroughArtifact;
      const receipt = artifact.receipt;
      expect(receipt.outcome).toBe(outcome);
      expect(receipt.callback).toBe(callback);
      expect(receipt.sessionId).toBeTruthy();
      expect(receipt.turnId).toBeTruthy();
      expect(receipt.settlement.status).toBe(
        scenario === 'tool-error' ? 'completed' : 'rejected',
      );
      expect(receipt.toolCalls).toEqual(
        scenario.startsWith('tool') ? ['A'] : [],
      );
      if (scenario.startsWith('tool'))
        expect(receipt.history.functionResults[0].name).toBe('lookup');
      if (scenario === 'tool-error')
        expect(receipt.settlement).toEqual({
          status: 'completed',
          finalOutput: 'The catalog is unavailable.',
        });
      if (scenario === 'provider') {
        expect(receipt.providerRequests).toBe(1);
        expect(receipt.nativeError).toHaveProperty('statusCode');
        expect(receipt.nativeError).toHaveProperty('category');
        // Unsupported/missing provider metadata remains nullable; no invented category.
      }
      const spans = rows(artifact.batches, 'traces');
      expect(
        spans.some(
          (span) =>
            span.name === 'run_turn' &&
            span.traceId &&
            attributes(span)['example.run_id'] === artifact.runId,
        ),
      ).toBe(true);
      const requests = rows(artifact.batches, 'logs')
        .map(attributes)
        .filter((log) => log['event.name'] === 'codex.api_request');
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every((log) => log['conversation.id'] === receipt.sessionId),
      ).toBe(true);
      expect([
        ...new Set(
          requests.map((log) => String(log['http.response.status_code'])),
        ),
      ]).toEqual([scenario === 'provider' ? '400' : '200']);
      for (const secret of [
        'synthetic-agents-testing-key',
        'synthetic-provider-key',
      ]) {
        expect(encoded + result.stdout + result.stderr).not.toContain(secret);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 50_000);
}

it('pairs only the latest preceding unconsumed call within its turn and preserves other records', async () => {
  const items = [
    {
      type: 'function_call',
      turnId: 'a',
      callId: 'same',
      name: 'displaced',
      arguments: { old: true },
    },
    {
      type: 'function_call',
      turnId: 'b',
      callId: 'same',
      name: 'other-turn',
      arguments: null,
    },
    {
      type: 'function_call',
      turnId: 'a',
      callId: 'same',
      name: 'latest',
      arguments: { accepted: true },
    },
    {
      type: 'function_call_output',
      turnId: 'a',
      callId: 'same',
      output: 'first',
      status: 'completed',
      error: null,
    },
    {
      type: 'function_call_output',
      turnId: 'b',
      callId: 'same',
      output: 'second',
      status: 'failed',
      error: 'recorded failure',
    },
    {
      type: 'function_call_output',
      turnId: 'a',
      callId: 'same',
      output: 'unpaired',
      status: 'completed',
      error: null,
    },
    { type: 'future-item', extra: { unknown: true } },
    { type: 'function_call', callId: 'missing-turn', name: 'must-not-pair' },
    { type: 'function_call_output', callId: 'missing-turn', output: null },
    null,
  ];
  const turns = [{ id: 'a', createdAt: null, usage: null }];
  const history = await readHistory({
    async *turns() {
      yield* turns;
    },
    async *items() {
      yield* items;
    },
  });
  expect(history.turns).toEqual(turns);
  expect(history.items).toEqual(items);
  expect(history.functionResults.map((result) => result.name)).toEqual([
    'latest',
    'other-turn',
    null,
    null,
  ]);
  expect(history.functionResults[1]).toMatchObject({
    arguments: null,
    output: 'second',
    error: 'recorded failure',
    status: 'failed',
  });
  expect(history.functionResults[3]).toMatchObject({
    turnId: null,
    name: null,
    arguments: null,
    output: null,
    error: null,
  });
});

it('preserves unavailable usage and exact bigint counters in the artifact', () => {
  expect(
    JSON.parse(artifactJson({ usage: null, count: 9007199254740993n })),
  ).toEqual({ usage: null, count: '9007199254740993' });
});

it('receives detached JSON without retaining request headers and closes its listener', async () => {
  const collector = await startCollector();
  try {
    const response = await fetch(`${collector.url}/v1/logs`, {
      method: 'POST',
      headers: { 'x-synthetic-secret': 'header-only-canary' },
      body: '{"received":true}',
    });
    expect(response.status).toBe(200);
    await response.text();
    const snapshot = collector.snapshot();
    expect(snapshot).toEqual([{ signal: 'logs', data: { received: true } }]);
    (snapshot[0].data as { received: boolean }).received = false;
    expect(collector.snapshot()[0].data).toEqual({ received: true });
    expect(JSON.stringify(collector.snapshot())).not.toContain(
      'header-only-canary',
    );
  } finally {
    await collector.close();
  }
  await expect(
    fetch(`${collector.url}/v1/logs`, { method: 'POST', body: '{}' }),
  ).rejects.toThrow();
});

it('rejects oversized bodies without retaining a partial batch', async () => {
  const collector = await startCollector({ maxBytes: 4 });
  await fetch(`${collector.url}/v1/traces`, {
    method: 'POST',
    body: '{"tooLarge":true}',
  }).then(
    (response) => response.text(),
    () => undefined,
  );
  expect(collector.snapshot()).toEqual([]);
  await expect(collector.close()).rejects.toThrow('collector rejected');
});

it('rejects requests beyond the retained-batch budget', async () => {
  const collector = await startCollector({ maxRequests: 1 });
  await (
    await fetch(`${collector.url}/v1/logs`, { method: 'POST', body: '{}' })
  ).text();
  expect(
    (await fetch(`${collector.url}/v1/logs`, { method: 'POST', body: '{}' }))
      .status,
  ).toBe(429);
  expect(collector.snapshot()).toHaveLength(1);
  await expect(collector.close()).rejects.toThrow('collector rejected');
});

it('joins an owned connection whose request body never completes', async () => {
  const collector = await startCollector();
  const url = new URL(collector.url);
  const socket = connect(Number(url.port), url.hostname);
  socket.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const ended = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.write(
      'POST /v1/logs HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{',
    );
    await setImmediate();
    await collector.close();
    await ended;
    expect(socket.destroyed).toBe(true);
    expect(collector.snapshot()).toEqual([]);
  } finally {
    socket.destroy();
    await collector.close();
  }
});
