import assert from 'node:assert/strict';
import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const { telemetry } = await import('../../../src/index.ts');
try {
  await assert.rejects(telemetry.configure(), /only be configured once/);
  await assert.rejects(
    telemetry.addTraceProcessor({ onEvent() {} }),
    /SDK instance that configured telemetry/,
  );
  await assert.rejects(
    telemetry.setTraceProcessors([]),
    /SDK instance that configured telemetry/,
  );
  await telemetry.withTrace({ name: 'worker.emitted_scope' }, () => {});
  parentPort.postMessage({ ownerRejected: true, emitted: true });
} catch (error) {
  parentPort.postMessage({ error: String(error) });
} finally {
  parentPort.close();
}
