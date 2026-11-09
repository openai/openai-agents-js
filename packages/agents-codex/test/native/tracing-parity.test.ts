import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const child = join(fixtures, 'tracing-parity-child.ts');
for (const mode of [
  'context',
  'control',
  'processors',
  'restore',
  'retained',
  'model-preparation',
  'parent-policy',
  'no-export',
  'custom-only',
]) {
  it(`qualifies real native tracing ${mode} (REQ423-429)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-tracing-'));
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', child, mode],
        {
          timeout: 50_000,
          maxBuffer: 2_097_152,
          env: { ...process.env, CODEX_HOME: join(directory, 'home') },
        },
      );
      expect(result.stdout).toContain(`PASS ${mode}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
}

type Export = {
  signal: string;
  headers: Record<string, string>;
  payload: {
    resourceSpans?: {
      scopeSpans?: { spans?: { name: string; traceId: string }[] }[];
    }[];
  };
};
function id(value: string): string {
  return /^[0-9a-f]+$/i.test(value)
    ? value.toLowerCase()
    : Buffer.from(value, 'base64').toString('hex');
}
for (const transport of ['http', 'grpc'] as const) {
  it(`partitions native ${transport} export by per-trace credentials (REQ427-428)`, async (context) => {
    const python = process.env.OTLP_TEST_PYTHON ?? 'python3';
    const missing = await execute(python, [
      '-c',
      'import grpc; from opentelemetry.proto.collector.trace.v1 import trace_service_pb2_grpc',
    ]).then(
      () => undefined,
      (error: Error) => error.message,
    );
    if (missing) {
      const message = `Real OTLP collector requires grpcio and opentelemetry-proto: ${missing}`;
      if (process.env.AGENTS_REQUIRE_TRACING_QUALIFICATION === '1')
        throw new Error(message);
      context.skip(message);
    }
    const directory = await mkdtemp(
      join(tmpdir(), 'agents-trace-credentials-'),
    );
    const collector = spawn(
      python,
      [join(fixtures, 'otlp-collector.py'), '--transport', transport],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = createInterface({ input: collector.stdout });
    const records: Export[] = [];
    let errors = '';
    collector.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Collector readiness timed out: ${errors}`)),
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
            resolve(value.endpoint);
          } else records.push(value);
        });
      });
      const options = join(directory, 'telemetry.json');
      await writeFile(
        options,
        JSON.stringify({
          traces: {
            kind: transport === 'http' ? 'otlp-http' : 'otlp-grpc',
            endpoint: transport === 'http' ? `${endpoint}/v1/traces` : endpoint,
            ...(transport === 'http' ? { protocol: 'json' } : {}),
            headers: {
              Authorization: 'Bearer synthetic-default',
              'x-inherited': 'synthetic-base',
            },
          },
        }),
      );
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', child, 'credentials', options],
        {
          timeout: 50_000,
          maxBuffer: 2_097_152,
          env: { ...process.env, CODEX_HOME: join(directory, 'home') },
        },
      );
      const { traceIds } = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      for (const [index, suffix] of ['one', 'two'].entries()) {
        const deliveries = records.filter(
          (record) =>
            record.signal === 'traces' &&
            record.payload.resourceSpans?.some((resource) =>
              resource.scopeSpans?.some((scope) =>
                scope.spans?.some(
                  (span) => id(span.traceId) === traceIds[index],
                ),
              ),
            ),
        );
        expect(deliveries.length).toBeGreaterThan(0);
        for (const delivery of deliveries) {
          const headers = Object.fromEntries(
            Object.entries(delivery.headers).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          );
          expect(headers.authorization).toBe(`Bearer synthetic-${suffix}`);
          expect(headers['x-inherited']).toBe('synthetic-base');
          expect(JSON.stringify(delivery.payload)).not.toContain(
            'synthetic-one',
          );
          expect(JSON.stringify(delivery.payload)).not.toContain(
            'synthetic-two',
          );
          expect(JSON.stringify(delivery.payload)).not.toContain(
            'credential_ref',
          );
        }
      }
    } finally {
      lines.close();
      if (collector.exitCode === null && collector.signalCode === null) {
        const closed = once(collector, 'exit');
        collector.kill();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
}

it('qualifies native capture controls, OpenAI export and dynamic fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-native-capture-'));
  try {
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', join(fixtures, 'tracing-capture-controls-child.ts')],
      {
        timeout: 50_000,
        maxBuffer: 2_097_152,
        env: { ...process.env, CODEX_HOME: join(directory, 'home') },
      },
    );
    expect(result.stdout).toContain(
      'PASS native capture controls and dynamic fixtures',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
