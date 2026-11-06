import { Agent, Environment, type LocalStorageMount } from '@openai/agents';

/** The application owns both existing directories and their contents. */
export async function readLocalStorage(cwd: string, source: string) {
  const mount: LocalStorageMount = {
    source,
    destination: source,
    strategy: 'local_bind',
    readOnly: true,
  };
  const agent = new Agent({
    model: 'gpt-5',
    instructions:
      'Inspect the mounted storage with native commands. Summarize its files without changing them.',
  });
  await using session = await agent.session({
    environment: Environment.local({
      cwd,
      mounts: [mount],
      tools: ['exec_command'],
    }),
  });
  return (await (await session.submit(`List the files in ${source}.`)).wait())
    .finalOutput;
}
