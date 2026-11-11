import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { telemetry } from '../../../src';
import type { TraceEvent } from '../../../src/runtime/telemetry';

type ExportReceipt = {
  path: string | undefined;
  auth: string | undefined;
  organization: string | undefined;
  records: any[];
};

async function checkCredentialRegression(
  mode: 'mixed' | 'early-shutdown',
  endpoint: string,
  exporter: telemetry.OpenAITraceExporter,
  received: ExportReceipt[],
) {
  if (mode === 'early-shutdown') {
    await assert.rejects(telemetry.shutdown(), {
      message: 'Configure telemetry successfully before shutdown',
    });
  }
  const hostProcessor = {
    onEvents: (events: readonly TraceEvent[]) => exporter.onEvents(events),
  };
  await telemetry.configure({
    traces:
      mode === 'mixed'
        ? { kind: 'otlp-http', endpoint: `${endpoint}/otlp`, protocol: 'json' }
        : undefined,
    traceProcessors: [hostProcessor],
  });
  const hostCredential = new telemetry.TraceExportCredentials({
    headers: { Authorization: 'Bearer host-scope' },
  });
  try {
    if (mode === 'mixed') {
      const otlpCredential = new telemetry.TraceExportCredentials({
        headers: { Authorization: 'Bearer otlp-scope' },
      });
      const root = await telemetry.startTrace({
        name: 'held-otlp-root',
        exportCredential: otlpCredential,
      });
      try {
        (
          await telemetry.startSpan({ name: 'otlp-child', parent: root })
        ).close();
        assert.equal((await telemetry.forceFlush()).status, 'success');
        await telemetry.setTraceProcessors([hostProcessor]);
        (
          await telemetry.startSpan({ name: 'late-otlp-child', parent: root })
        ).close();
      } finally {
        root.close();
        otlpCredential.close();
      }
    }
    (
      await telemetry.startTrace({
        name: 'host-root',
        exportCredential: hostCredential,
      })
    ).close();
    hostCredential.close();
    assert.equal((await telemetry.forceFlush()).status, 'success');

    const otlpSpans = received
      .filter(({ path }) => path === '/otlp')
      .flatMap(({ auth, records }) => records.map((span) => [span.name, auth]));
    const hostReceipts = received.filter(({ path }) => path === '/ingest');
    const hostSpans = hostReceipts
      .flatMap(({ auth, records }) =>
        records
          .filter((record) => record.object === 'trace.span')
          .map((record) => [record.span_data.name, auth]),
      )
      .sort();
    assert.deepEqual(
      { otlpSpans, hostSpans },
      {
        otlpSpans:
          mode === 'mixed' ? [['otlp-child', 'Bearer otlp-scope']] : [],
        hostSpans:
          mode === 'mixed'
            ? [
                ['held-otlp-root', 'Bearer fallback-secret'],
                ['host-root', 'Bearer host-scope'],
                ['late-otlp-child', 'Bearer fallback-secret'],
                ['otlp-child', 'Bearer fallback-secret'],
              ]
            : [['host-root', 'Bearer host-scope']],
      },
    );
    assert(hostReceipts.every(({ auth }) => auth !== 'Bearer otlp-scope'));
  } finally {
    hostCredential.close();
    await telemetry.shutdown();
  }
}

async function checkHostRegistration(
  endpoint: string,
  exporterA: telemetry.OpenAITraceExporter,
  received: ExportReceipt[],
) {
  const exporterB = new telemetry.OpenAITraceExporter({
    apiKey: 'b-default',
    endpoint: `${endpoint}/ingest-b`,
  });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let originalA: TraceEvent | undefined;
  let fallbackB: TraceEvent | undefined;
  const processorA = {
    async onEvent(event: TraceEvent) {
      if (event.name === 'before-add' && event.lifecycle === 'end')
        originalA = event;
      if (event.name === 'queued' && event.lifecycle === 'start') {
        enter();
        await gate;
      }
      await exporterA.onEvent(event);
    },
  };
  const processorB = {
    async onEvents(events: readonly TraceEvent[]) {
      const event = events.find(
        (item) => item.name === 'after-add' && item.lifecycle === 'end',
      );
      if (event) {
        assert(originalA);
        assert.equal(event.credential_required, true);
        await assert.rejects(
          exporterB.onEvent(originalA),
          /credential delivery is unavailable/,
        );
        await assert.rejects(
          exporterB.onEvent({ ...event }),
          /credential delivery is unavailable/,
        );
        fallbackB = event;
      }
      await exporterB.onEvents(events);
    },
  };
  await telemetry.configure({ traceProcessors: [processorA] });
  const credentialA = new telemetry.TraceExportCredentials({
    headers: { Authorization: 'Bearer a-scope' },
  });
  const credentialB = new telemetry.TraceExportCredentials({
    headers: { Authorization: 'Bearer b-scope' },
  });
  try {
    const held = await telemetry.startTrace({
      name: 'held-add',
      exportCredential: credentialA,
    });
    const replacement = await telemetry.startTrace({
      name: 'held-replace',
      exportCredential: credentialA,
    });
    credentialA.close();
    (await telemetry.startSpan({ name: 'before-add', parent: held })).close();
    assert.equal((await telemetry.forceFlush()).status, 'success');

    await telemetry.addTraceProcessor(processorB);
    held.close();
    (await telemetry.startSpan({ name: 'after-add', parent: held })).close();
    assert.equal((await telemetry.forceFlush()).status, 'success');
    assert(fallbackB);
    await assert.rejects(
      exporterB.onEvent(fallbackB),
      /credential delivery is unavailable/,
    );

    const queued = await telemetry.startSpan({
      name: 'queued',
      parent: held,
      exportCredential: credentialB,
    });
    await entered;
    // The first callback is still handling the start, so the end is queued
    // under the old registrations when the routes are replaced.
    queued.close();
    await telemetry.setTraceProcessors([processorB]);
    release();
    replacement.close();
    (
      await telemetry.startSpan({
        name: 'after-replacement',
        parent: replacement,
      })
    ).close();
    (
      await telemetry.startSpan({ name: 'late-queued-child', parent: queued })
    ).close();
    (
      await telemetry.startTrace({
        name: 'fresh',
        exportCredential: credentialB,
      })
    ).close();
    credentialB.close();
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const spans = received
      .flatMap(({ path, auth, records }) =>
        records
          .filter((record) => record.object === 'trace.span')
          .map((record) => [path, record.span_data.name, auth]),
      )
      .sort();
    assert.deepEqual(spans, [
      ['/ingest', 'after-add', 'Bearer a-scope'],
      ['/ingest', 'before-add', 'Bearer a-scope'],
      ['/ingest', 'held-add', 'Bearer a-scope'],
      ['/ingest', 'queued', 'Bearer b-scope'],
      ['/ingest-b', 'after-add', 'Bearer b-default'],
      ['/ingest-b', 'after-replacement', 'Bearer b-default'],
      ['/ingest-b', 'fresh', 'Bearer b-scope'],
      ['/ingest-b', 'held-add', 'Bearer b-default'],
      ['/ingest-b', 'held-replace', 'Bearer b-default'],
      ['/ingest-b', 'late-queued-child', 'Bearer b-default'],
      ['/ingest-b', 'queued', 'Bearer b-scope'],
    ]);
  } finally {
    release();
    credentialA.close();
    credentialB.close();
    await telemetry.shutdown();
  }
}

async function main() {
  const mode = process.argv[2];
  const received: ExportReceipt[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({
      path: request.url,
      auth: request.headers.authorization,
      organization: request.headers['openai-organization'] as
        string | undefined,
      records:
        request.url === '/otlp'
          ? body.resourceSpans.flatMap((resource: any) =>
              resource.scopeSpans.flatMap((scope: any) => scope.spans),
            )
          : body.data,
    });
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const exporter = new telemetry.OpenAITraceExporter({
    apiKey: 'fallback-secret',
    organization: 'fallback-org',
    endpoint: `${endpoint}/ingest`,
  });
  const observed: TraceEvent[] = [];
  const groups: (readonly TraceEvent[])[] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    if (mode === 'host-registration') {
      await checkHostRegistration(endpoint, exporter, received);
      console.log('PASS host-auth native host-registration');
      return;
    }
    if (mode === 'mixed' || mode === 'early-shutdown') {
      await checkCredentialRegression(mode, endpoint, exporter, received);
      console.log(`PASS host-auth native ${mode}`);
      return;
    }
    await telemetry.configure({
      traceProcessors: [
        {
          onEvents: async (events) => {
            await ready;
            observed.push(...events);
            groups.push(events);
            const scoped = events.find(
              (event) => event.credential_required === true,
            );
            if (scoped)
              await assert.rejects(
                exporter.onEvent({ ...scoped, name: 'copied foreign root' }),
                /credential delivery is unavailable/,
              );
            await exporter.onEvents(events);
          },
        },
      ],
    });
    const a = new telemetry.TraceExportCredentials({
      headers: { Authorization: 'Bearer trace-secret-A' },
    });
    const rootA = await telemetry.startTrace({
      name: 'authenticated-A',
      exportCredential: a,
    });
    a.close();
    rootA.close();
    const b = new telemetry.TraceExportCredentials({
      headers: { Authorization: 'Bearer trace-secret-B' },
    });
    const rootB = await telemetry.startTrace({
      name: 'authenticated-B',
      exportCredential: b,
    });
    rootB.close();
    (
      await telemetry.startSpan({
        name: 'override-B-under-A',
        parent: rootA,
        exportCredential: b,
      })
    ).close();
    b.close();
    (
      await telemetry.startSpan({ name: 'late-child-A', parent: rootA })
    ).close();
    (
      await telemetry.startSpan({ name: 'late-child-B', parent: rootB })
    ).close();
    (await telemetry.startTrace({ name: 'fallback' })).close();
    release();
    const result = await telemetry.forceFlush();
    assert.equal(result.status, 'success');
    const expected = new Map([
      ['Bearer trace-secret-A', new Set(['authenticated-A', 'late-child-A'])],
      [
        'Bearer trace-secret-B',
        new Set(['authenticated-B', 'late-child-B', 'override-B-under-A']),
      ],
      ['Bearer fallback-secret', new Set(['fallback'])],
    ]);
    for (const [auth, names] of expected) {
      const requests = received.filter((request) => request.auth === auth);
      assert(requests.length > 0);
      assert(
        requests.every((request) => request.organization === 'fallback-org'),
      );
      const records = requests.flatMap((request) => request.records);
      assert.deepEqual(
        new Set(
          records
            .filter((record) => record.object === 'trace.span')
            .map((record) => record.span_data.name),
        ),
        names,
      );
      assert(records.some((record) => record.object === 'trace'));
    }
    assert(
      groups.some(
        (events) => new Set(events.map((event) => event.trace_id)).size >= 2,
      ),
    );
    assert(
      !/trace-secret-A|trace-secret-B|fallback-secret|authorization/i.test(
        JSON.stringify(observed),
      ),
    );
    const scoped = observed.find(
      (event) => event.credential_required === true,
    )!;
    const count = received.length;
    await assert.rejects(
      exporter.onEvent(scoped),
      /credential delivery is unavailable/,
    );
    assert.equal(received.length, count);
    await telemetry.shutdown();
    console.log('PASS host-auth native host-only');
  } finally {
    release();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
