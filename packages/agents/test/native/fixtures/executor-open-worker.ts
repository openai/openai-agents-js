import { inspect } from 'node:util';
import { Agent, Environment, NativeProvider } from '../../../src/index';

const config = JSON.parse(process.argv[2]) as {
  modelUrl: string;
  executorUrl: string;
  cwd: string;
  authorization: string;
};
async function main() {
  try {
    await using provider = new NativeProvider({
      baseUrl: config.modelUrl,
      apiKey: 'synthetic-negative-model-secret',
      supportsWebsockets: false,
    });
    const environment = new Environment({
      url: config.executorUrl,
      cwd: config.cwd,
      headers: { Authorization: config.authorization },
      tools: ['exec_command'],
      connectTimeout: 0.5,
    });
    try {
      await using session = await new Agent({
        instructions: 'Use the selected executor.',
        provider,
        model: 'gpt-5',
      }).session({ environment });
      void session;
      process.send?.({ opened: true });
    } catch (error) {
      process.send?.({
        opened: false,
        diagnostic: inspect(error, { depth: null }),
      });
    }
  } finally {
    process.disconnect?.();
  }
}
void main();
