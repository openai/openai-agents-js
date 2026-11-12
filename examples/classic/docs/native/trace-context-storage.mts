import { AsyncLocalStorage } from 'node:async_hooks';
import { telemetry } from '@openai/agents';

const storage = new AsyncLocalStorage<telemetry.TraceSpan | undefined>();
telemetry.setTraceContextStorage({
  getStore: () => storage.getStore(),
  run: (span, callback) => storage.run(span, callback),
});
await telemetry.configure();
try {
  await telemetry.withTrace({ name: 'Application context' }, async (root) => {
    await Promise.resolve();
    console.log(storage.getStore() === root); // true
    console.log(telemetry.getCurrentSpan() === root); // true
  });
} finally {
  telemetry.setTraceContextStorage();
  await telemetry.shutdown();
}
