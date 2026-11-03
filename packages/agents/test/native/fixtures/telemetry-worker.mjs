import { parentPort } from 'node:worker_threads';
// Register the same TS source loader in each isolate; bootstrap owns shutdown.
import { register } from 'tsx/esm/api';
register();
const { Agent, NativeProvider, telemetry } =
  await import('../../../src/index.ts');
const { ModelServer, message } = await import('./model-server.ts');
let count = 0;
parentPort.on('message', async (command) => {
  if (command === 'close') {
    await ModelServer.closeAll();
    parentPort.close();
    return;
  }
  try {
    await import('node:assert/strict').then(async ({ default: assert }) => {
      await assert.rejects(telemetry.configure(), /only be configured once/);
    });
    const server = new ModelServer([
      [{ ...message(`WORKER_FINAL_${++count}`), phase: 'final_answer' }],
    ]);
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: config['model_providers.fixture'].base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    await agent.run('WORKER_PROMPT');
    await provider.close();
    server.assertExhausted();
    parentPort.postMessage({ done: true });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
});
parentPort.postMessage({ ready: true });
