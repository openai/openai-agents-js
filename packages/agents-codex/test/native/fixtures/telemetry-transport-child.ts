import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent, NativeProvider, telemetry } from '../../../src';
import type { TelemetryOptions } from '../../../src/runtime/telemetry';
import { message, ModelServer } from './model-server';

async function main() {
  const options: TelemetryOptions = JSON.parse(
    await readFile(process.argv[2], 'utf8'),
  );
  const expectation = process.argv[3];
  if (
    expectation === 'invalid_identity' ||
    expectation === 'incomplete_identity'
  ) {
    await assert.rejects(
      telemetry.configure(options),
      /Native telemetry operation failed/,
    );
    return;
  }
  await telemetry.configure(options);
  const server = new ModelServer([
    [
      {
        ...message('telemetry transport response'),
        phase: 'final_answer',
      },
    ],
  ]);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
  try {
    const agent = new Agent({
      instructions: 'Answer the transport fixture.',
      model: 'gpt-5',
      provider,
    });
    const result = await agent.run('telemetry transport prompt', {
      returnState: true,
    });
    assert.equal(result.finalOutput, 'telemetry transport response');
    const saved = JSON.stringify(result.state);
    for (const exporter of [options.logs, options.traces, options.metrics]) {
      if (!exporter) continue;
      assert(!saved.includes(exporter.endpoint));
      for (const path of Object.values(exporter.tls ?? {}))
        assert(!saved.includes(path));
    }
    assert(!saved.includes('x-otlp-fixture'));
    server.assertExhausted();
  } finally {
    await provider.close();
    await ModelServer.closeAll();
    await telemetry.shutdown();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
