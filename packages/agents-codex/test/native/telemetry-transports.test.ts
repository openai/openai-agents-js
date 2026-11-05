import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Exporter } from '../../src/runtime/telemetry';

const execute = promisify(execFile);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const python = process.env.OTLP_TEST_PYTHON ?? 'python3';
const dependencyProbe = await execute(python, [
  '-c',
  'import grpc; from google.protobuf.json_format import MessageToDict; from opentelemetry.proto.collector.logs.v1 import logs_service_pb2_grpc',
]).then(
  () => undefined,
  (error: Error) =>
    `OTLP collector requires test-only grpcio and opentelemetry-proto: ${error.message}`,
);

type Export = {
  signal: 'logs' | 'traces' | 'metrics';
  headers: Record<string, string>;
  payload: Record<string, any>;
  clientAuthenticated?: boolean;
};

async function certificates(directory: string) {
  const openssl = async (...args: string[]) =>
    execute('openssl', args, { cwd: directory });
  await openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-subj',
    '/CN=OTLP test CA',
    '-days',
    '1',
  );
  await writeFile(
    join(directory, 'server.ext'),
    'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n',
  );
  await writeFile(
    join(directory, 'client.ext'),
    'extendedKeyUsage=clientAuth\n',
  );
  for (const identity of ['server', 'client']) {
    await openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${identity}.key`,
      '-out',
      `${identity}.csr`,
      '-subj',
      `/CN=${identity === 'server' ? 'localhost' : 'OTLP test client'}`,
    );
    await openssl(
      'x509',
      '-req',
      '-in',
      `${identity}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${identity}.pem`,
      '-days',
      '1',
      '-extfile',
      `${identity}.ext`,
    );
  }
  await openssl(
    'verify',
    '-CAfile',
    'ca.pem',
    '-purpose',
    'sslclient',
    'client.pem',
  );
  const certificateKey = await openssl(
    'x509',
    '-in',
    'client.pem',
    '-pubkey',
    '-noout',
  );
  const privateKey = await openssl('pkey', '-in', 'client.key', '-pubout');
  expect(certificateKey.stdout).toBe(privateKey.stdout);
}

// A fresh Node process owns the process-global native subscriber in every case.
describe('native decoded OTLP transports', () => {
  const cases = [
    ['http', 'json', 'plain'],
    ['http', 'binary', 'plain'],
    ['grpc', 'binary', 'plain'],
    ['http', 'binary', 'ca'],
    ['http', 'binary', 'mtls'],
    ['grpc', 'binary', 'ca'],
    ['grpc', 'binary', 'mtls'],
    ['http', 'binary', 'plain', 'logs'],
    ['http', 'binary', 'plain', 'traces'],
    ['http', 'binary', 'plain', 'metrics'],
    ['http', 'json', 'mtls', 'logs'],
    ['http', 'json', 'mtls', 'metrics'],
    ['http', 'json', 'mtls'],
    ['http', 'json', 'mtls', undefined, 'mixed'],
    ['http', 'json', 'mtls', undefined, 'invalid_identity'],
    ['http', 'json', 'mtls', undefined, 'incomplete_identity'],
    ['http', 'json', 'mtls', undefined, 'untrusted_server'],
  ] as const;
  for (const [transport, protocol, security, onlySignal, scenario] of cases) {
    const signals = onlySignal
      ? [onlySignal]
      : (['logs', 'traces', 'metrics'] as const);
    const httpMtls = transport === 'http' && security === 'mtls';
    const rejectedIdentity =
      scenario === 'invalid_identity' || scenario === 'incomplete_identity';
    const failedTrust = scenario === 'untrusted_server';
    const title = rejectedIdentity
      ? `rejects HTTP mTLS ${scenario} without exporting`
      : failedTrust
        ? 'refuses delivery to an untrusted HTTP mTLS server'
        : `exports decoded ${transport}/${protocol} records with ${security} (${scenario ?? onlySignal ?? 'all signals'})`;
    it(
      title,
      async (context) => {
        if (dependencyProbe) {
          if (process.env.AGENTS_REQUIRE_TRACING_QUALIFICATION === '1')
            throw new Error(dependencyProbe);
          context.skip(dependencyProbe);
        }
        const directory = await mkdtemp(join(tmpdir(), 'agents-otlp-'));
        const args = [
          join(fixtures, 'otlp-collector.py'),
          '--transport',
          transport,
        ];
        let tls: NonNullable<Exporter['tls']> =
          security === 'plain'
            ? {}
            : {
                caCertificate: join(directory, 'ca.pem'),
                ...(security === 'mtls'
                  ? {
                      clientCertificate: join(directory, 'client.pem'),
                      clientPrivateKey: join(directory, 'client.key'),
                    }
                  : {}),
              };
        if (security !== 'plain') {
          try {
            await execute('openssl', ['version']);
          } catch {
            await rm(directory, { recursive: true, force: true });
            if (process.env.AGENTS_REQUIRE_TRACING_QUALIFICATION === '1')
              throw new Error(
                'OTLP TLS qualification requires test-only openssl',
              );
            context.skip('OTLP TLS qualification requires test-only openssl');
          }
          await certificates(directory);
          if (scenario === 'invalid_identity')
            await writeFile(
              join(directory, 'client.key'),
              'synthetic invalid private key',
            );
          if (scenario === 'incomplete_identity')
            tls = {
              caCertificate: tls.caCertificate,
              clientCertificate: tls.clientCertificate,
            };
          if (failedTrust)
            tls = { ...tls, caCertificate: join(directory, 'client.pem') };
          args.push(
            '--certificate',
            join(directory, 'server.pem'),
            '--key',
            join(directory, 'server.key'),
          );
          if (security === 'mtls') args.push('--ca', join(directory, 'ca.pem'));
        }
        if (scenario === 'mixed') args.push('--also-plain-http');
        const collector = spawn(python, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const records: Export[] = [];
        let errors = '';
        collector.stderr.on('data', (chunk) => {
          errors += chunk;
        });
        const lines = createInterface({ input: collector.stdout });
        try {
          const endpoints = await new Promise<{
            endpoint: string;
            plainEndpoint?: string;
          }>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(new Error(`Collector readiness timed out: ${errors}`)),
              10_000,
            );
            collector.once('error', reject);
            collector.once('exit', (code) => {
              clearTimeout(timer);
              reject(new Error(`Collector exited ${code}: ${errors}`));
            });
            lines.on('line', (line) => {
              const value = JSON.parse(line);
              if (value.endpoint) {
                clearTimeout(timer);
                resolve(value);
              } else records.push(value);
            });
          });
          if (scenario === 'mixed')
            expect(endpoints.plainEndpoint).toMatch(/^http:/);
          const exporter = (signal: string): Exporter => {
            const plain = scenario === 'mixed' && signal === 'metrics';
            const endpoint = plain
              ? endpoints.plainEndpoint!
              : endpoints.endpoint;
            return {
              kind: transport === 'http' ? 'otlp-http' : 'otlp-grpc',
              endpoint:
                transport === 'http' ? `${endpoint}/v1/${signal}` : endpoint,
              ...(transport === 'http' ? { protocol } : {}),
              headers: { 'x-otlp-fixture': signal },
              ...(security === 'plain' || plain ? {} : { tls }),
            };
          };
          const config = join(directory, 'telemetry.json');
          await writeFile(
            config,
            JSON.stringify({
              ...Object.fromEntries(
                signals.map((signal) => [signal, exporter(signal)]),
              ),
              environment: 'transport-qualification',
              spanAttributes: { 'fixture.transport': transport },
              logUserPrompt: httpMtls,
              logAgentResponses: httpMtls,
            }),
          );
          const nativeRun = execute(
            process.execPath,
            [
              '--import',
              'tsx',
              join(fixtures, 'telemetry-transport-child.ts'),
              config,
              scenario ?? 'delivery',
            ],
            {
              timeout: 40_000,
              env: { ...process.env, CODEX_HOME: join(directory, 'home') },
            },
          );
          await nativeRun;
          // Shutdown has requested a flush. EOF drains all decoded records,
          // including any unexpected signal, before we assert disabled signals.
          const closed = once(lines, 'close');
          collector.kill();
          await closed;
          if (rejectedIdentity || failedTrust) {
            expect(records).toEqual([]);
            return;
          }
          expect(
            [...new Set(records.map((record) => record.signal))].sort(),
          ).toEqual([...signals].sort());
          for (const signal of signals) {
            const exports = records.filter(
              (record) => record.signal === signal,
            );
            expect(exports.length, `${signal}: ${errors}`).toBeGreaterThan(0);
            for (const record of exports) {
              if (httpMtls)
                expect(record.clientAuthenticated).toBe(
                  !(scenario === 'mixed' && signal === 'metrics'),
                );
              expect(record.headers['x-otlp-fixture']).toBe(signal);
              if (transport === 'http')
                expect(record.headers['content-type']).toContain(
                  protocol === 'json'
                    ? 'application/json'
                    : 'application/x-protobuf',
                );
              const resourceKey = {
                logs: 'resourceLogs',
                traces: 'resourceSpans',
                metrics: 'resourceMetrics',
              }[signal];
              expect(record.payload[resourceKey].length).toBeGreaterThan(0);
              const attributes =
                record.payload[resourceKey][0].resource.attributes;
              expect(attributes).toContainEqual({
                key: 'service.name',
                value: { stringValue: 'codex_agents_js' },
              });
              expect(attributes).toContainEqual({
                key: 'env',
                value: { stringValue: 'transport-qualification' },
              });
            }
          }
          const logs = records
            .filter((record) => record.signal === 'logs')
            .flatMap((record) =>
              record.payload.resourceLogs.flatMap((resource: any) =>
                resource.scopeLogs.flatMap((scope: any) => scope.logRecords),
              ),
            );
          if (signals.includes('logs'))
            expect(
              logs.some((record) =>
                record.attributes?.some(
                  (attribute: any) =>
                    attribute.key === 'event.name' &&
                    attribute.value.stringValue === 'codex.conversation_starts',
                ),
              ),
            ).toBe(true);
          if (httpMtls && signals.includes('logs')) {
            const encoded = JSON.stringify(logs);
            expect(encoded).toContain('telemetry transport prompt');
            expect(encoded).toContain('telemetry transport response');
          }
          const spans = records
            .filter((record) => record.signal === 'traces')
            .flatMap((record) =>
              record.payload.resourceSpans.flatMap((resource: any) =>
                resource.scopeSpans.flatMap((scope: any) => scope.spans),
              ),
            );
          if (signals.includes('traces'))
            expect(
              spans.some(
                (span) =>
                  span.name &&
                  span.traceId &&
                  span.spanId &&
                  span.attributes?.some(
                    (attribute: any) =>
                      attribute.key === 'fixture.transport' &&
                      attribute.value.stringValue === transport,
                  ),
              ),
            ).toBe(true);
          const metrics = records
            .filter((record) => record.signal === 'metrics')
            .flatMap((record) =>
              record.payload.resourceMetrics.flatMap((resource: any) =>
                resource.scopeMetrics.flatMap((scope: any) => scope.metrics),
              ),
            );
          if (httpMtls && signals.includes('metrics')) {
            const points = metrics
              .filter((metric) => metric.name === 'codex.turn.tool.call')
              .flatMap((metric) => metric.histogram.dataPoints);
            expect(
              points.reduce((count, point) => count + Number(point.count), 0),
            ).toBe(1);
          }
          if (signals.includes('metrics'))
            expect(metrics).toContainEqual(
              expect.objectContaining({
                name: 'codex.process.start',
                sum: expect.objectContaining({
                  dataPoints: expect.arrayContaining([
                    expect.objectContaining({ asInt: '1' }),
                  ]),
                }),
              }),
            );
        } finally {
          if (collector.exitCode === null && collector.signalCode === null) {
            const exited = once(collector, 'exit');
            collector.kill();
            await exited;
          }
          lines.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
});
