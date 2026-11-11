import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Agent,
  NativeProvider,
  applyPatchTool,
  localStorage,
} from '../../../src';
async function main() {
  const config = JSON.parse(process.argv[2]) as { url: string; root: string };
  const provider = new NativeProvider({
    baseUrl: config.url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  const edit = () => {
    appendFileSync(join(config.root, 'effects'), 'one editor effect\n', {
      flush: true,
    });
    process.exit(67);
  };
  const agent = new Agent({
    instructions: 'Use editor.',
    model: 'gpt-5',
    provider,
    tools: [
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  const session = await agent.session({
    storage: localStorage(join(config.root, 'profile')),
  });
  await new Promise<void>((resolve, reject) =>
    process.send?.(
      { opened: session.id },
      undefined,
      undefined,
      (error: Error | null) => (error ? reject(error) : resolve()),
    ),
  );
  await (await session.submit('edit')).wait();
  throw new Error('Editor process must stop after its one effect');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
