import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, telemetry } from '../../../src';
import { text, withScriptedResponses } from '../../../src/testing';

async function main() {
  const records: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    records.push(...JSON.parse(Buffer.concat(chunks).toString()).data);
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let configured = false;
  let cleanupError: AggregateError | undefined;
  try {
    const exporter = new telemetry.OpenAITraceExporter({
      apiKey: 'synthetic',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    await telemetry.configure({ traceProcessors: [exporter] });
    configured = true;
    await telemetry.withTrace(
      {
        name: 'retained-root',
        metadata: { tenant: 'original' },
        groupId: 'original-group',
      },
      async () => {
        for (let index = 0; index < 1100; index++) {
          await telemetry.withTrace(
            { name: `completed-${index}`, detached: true },
            async () => {},
          );
          if (index % 32 === 31)
            assert.equal((await telemetry.forceFlush()).status, 'success');
        }
        await telemetry.withSpan({ name: 'retained-child' }, async () => {});
      },
    );
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const root = records.find((row) => row.workflow_name === 'retained-root');
    assert.ok(root);
    const descriptors = records.filter(
      (row) => row.object === 'trace' && row.id === root.id,
    );
    assert.ok(
      descriptors.every(
        (row) =>
          row.workflow_name === 'retained-root' &&
          row.group_id === 'original-group' &&
          row.metadata.tenant === 'original',
      ),
    );
    const called: string[] = [];
    const failure = new Error('synthetic-private-native-callback');
    await assert.rejects(
      withScriptedResponses(
        [
          async () => {
            called.push('broken');
            throw failure;
          },
          async () => {
            called.push('following');
            return [text('must remain queued')];
          },
        ],
        async (peer) => {
          const agent = new Agent({
            instructions: 'Respond',
            model: 'gpt-5.5',
            provider: peer.provider,
          });
          try {
            await agent.run('synthetic input');
          } catch {
            /* Fixture close must rethrow the original assertion. */
          }
          assert.equal(peer.requests.length, 1);
        },
      ),
      (error) => error === failure,
    );
    assert.deepEqual(called, ['broken']);
    console.log('PASS native active-root churn and callback retry fence');
  } finally {
    const errors: unknown[] = [];
    try {
      if (configured) await telemetry.shutdown({ timeoutMs: 1000 });
    } catch (error) {
      errors.push(error);
    }
    server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      cleanupError = new AggregateError(
        errors,
        'Tracing regression collector cleanup failed',
      );
  }
  if (cleanupError) throw cleanupError;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
