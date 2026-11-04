import { telemetry } from '../../src/index';
import { runA2AExample } from '../../examples/a2a/two-agents';

async function main() {
  await telemetry.configure({
    traces: { kind: 'otlp-http', endpoint: process.argv[2]!, protocol: 'json' },
  });
  try {
    console.log(JSON.stringify({ result: await runA2AExample() }));
  } finally {
    await telemetry.shutdown();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
