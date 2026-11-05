import { inspect } from 'node:util';
import {
  Agent,
  Environment,
  NativeProvider,
  type SessionState,
} from '../../../src/index';

const config = JSON.parse(process.argv[2]) as {
  modelUrl: string;
  executorUrl: string;
  cwd: string;
  authorization: string;
  state?: SessionState;
};

async function main() {
  try {
    let result;
    {
      await using provider = new NativeProvider({
        baseUrl: config.modelUrl,
        apiKey: 'synthetic-retained-executor-provider',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Use the selected executor when requested.',
        model: 'gpt-5',
        provider,
      });
      await using session = await agent.session({
        state: config.state,
        environment: new Environment({
          url: config.executorUrl,
          cwd: config.cwd,
          headers: { Authorization: config.authorization },
          tools: ['exec_command'],
          connectTimeout: 3,
          approval: () => true,
        }),
      });
      const before = [];
      for await (const item of session.items()) before.push(item);
      const output = (await (await session.submit('Read the marker.')).wait())
        .finalOutput;
      const after = [];
      for await (const item of session.items()) after.push(item);
      result = {
        ok: true,
        pid: process.pid,
        before,
        after,
        output,
        state: await session.saveState(),
      };
    }
    // Report success only after Session and provider cleanup have joined.
    process.send?.(result);
  } catch (error) {
    process.send?.({
      ok: false,
      pid: process.pid,
      details: inspect(error, { depth: null }),
    });
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}

void main();
