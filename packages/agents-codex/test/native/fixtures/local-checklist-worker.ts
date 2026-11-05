import { inspect } from 'node:util';
import { Agent, NativeProvider, checklist, localStorage } from '../../../src';

const config = JSON.parse(process.argv[2]) as {
  profile: string;
  url: string;
  resume?: string;
  grant: boolean;
  mode: 'create' | 'inspect' | 'continue';
};
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: 'synthetic-local-checklist',
  supportsWebsockets: false,
});
async function main() {
  try {
    const agent = new Agent({
      instructions: 'Maintain only the requested native checklist.',
      model: 'gpt-5.1-codex',
      provider,
      tools: config.grant ? [checklist()] : [],
    });
    await using session = await agent.session({
      storage: localStorage(config.profile),
      resume: config.resume,
    });
    const before = await session.checklist();
    const historyBefore = [];
    for await (const item of session.items()) historyBefore.push(item);
    if (config.mode !== 'inspect')
      await (
        await session.submit('Perform the explicit requested turn.')
      ).wait();
    const historyAfter = [];
    for await (const item of session.items()) historyAfter.push(item);
    process.send?.({
      id: session.id,
      pid: process.pid,
      before,
      checklist: await session.checklist(),
      historyBefore,
      historyAfter,
    });
  } finally {
    await provider.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(inspect(error, { depth: 8 }) + '\n');
  process.exitCode = 1;
});
