import { Agent, NativeProvider, fileThreadStore } from '@openai/agents';

/** Retain directory and conversation ID to resume with a fresh process. */
export async function runCustomStorage(directory: string, resume?: string) {
  await using provider = new NativeProvider({
    baseUrl: process.env.OPENAI_BASE_URL,
  });
  const agent = new Agent({
    provider,
    instructions: 'Answer briefly and remember this conversation.',
  });
  await using session = await agent.session({
    storage: fileThreadStore(directory),
    resume,
  });
  const result = await (
    await session.submit(
      resume ? 'What preference did I share?' : 'I prefer vegetarian meals.',
    )
  ).wait();
  return { id: session.id, finalOutput: result.finalOutput };
}

// Node-only reference adapter for trusted local filesystems that support fsync
// and atomic rename. It writes a full native snapshot at each durable boundary.
// It saves canonical conversation state; it does not make tool effects atomic.
// After a process crash, first prove that process is dead, then explicitly remove
// `<directory>/<threadId>.lock` before reopening. Never recover a live writer.
// Keep the directory private: snapshots can contain prompts and tool results.
if (typeof require !== 'undefined' && require.main === module) {
  const directory = process.argv[2];
  if (!directory)
    throw new Error('Usage: custom-storage.ts DIRECTORY [THREAD_ID]');
  runCustomStorage(directory, process.argv[3])
    .then((result) => console.log(result))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
