import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  localStorage,
  tool,
  type NativeProviderOptions,
} from '@openai/agents';

/** Open or cold-reopen a trusted local profile with current application bindings. */
export async function useLocalStorage(
  path: string,
  resume?: string,
  options: NativeProviderOptions = {},
) {
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    instructions: 'Use lookup for a record, then answer clearly.',
    provider,
    tools: [
      tool({
        name: 'lookup',
        description: 'Read the current application record.',
        parameters: z.object({ key: z.string() }),
        execute: ({ key }) => ({ key, value: 'current application value' }),
      }),
    ],
  });
  await using session = await agent.session({
    storage: localStorage(path),
    resume,
  });
  const result = await (
    await session.submit('Look up the example record.')
  ).wait();
  return { id: session.id, finalOutput: result.finalOutput };
}

/** Retain the profile and ID in application storage to reopen in another process. */
export async function runLocalConversation(
  path: string,
  options: NativeProviderOptions = {},
) {
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    instructions: 'Answer briefly and remember this conversation.',
    provider,
  });
  const storage = localStorage(path);
  let id: string;
  {
    await using session = await agent.session({ storage });
    const first = await session.submit('I prefer vegetarian meals.');
    await first.wait();
    id = session.id;
  }
  // The original writer is closed before the same conversation reopens.
  await using reopened = await agent.session({ storage, resume: id });
  const next = await reopened.submit('What meal preference did I share?');
  return { id, finalOutput: (await next.wait()).finalOutput };
}

async function main(): Promise<void> {
  await using directory = {
    path: await mkdtemp(join(tmpdir(), 'agents-local-conversation-')),
    async [Symbol.asyncDispose]() {
      await rm(this.path, { recursive: true, force: true });
    },
  };
  const result = await runLocalConversation(directory.path, {
    baseUrl: process.env.OPENAI_BASE_URL,
  });
  console.log('Reopened answer:', result.finalOutput);
}

// Local profiles cannot export portable checkpoints or retain live processes.
// This CLI removes its temporary profile; application callers retain their path.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
