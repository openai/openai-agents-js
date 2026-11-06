import {
  Agent,
  Environment,
  NativeProvider,
  checklist,
  type NativeProviderOptions,
} from '@openai/agents';

/** The application provisions the executor and retains ownership of its workspace. */
export async function runRemoteTask(
  task: string,
  environment: Environment,
  options: NativeProviderOptions = {},
) {
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    instructions:
      'Inspect the assigned workspace and record your progress in the checklist.',
    model: 'gpt-5.5',
    tools: [checklist()],
    provider,
  });
  await using session = await agent.session({ environment });
  const result = await (await session.submit(task)).wait();
  return {
    answer: result.finalOutput,
    checklist: await session.checklist(),
  };
}

async function main() {
  const { EXECUTOR_URL, EXECUTOR_CWD, EXECUTOR_TOKEN } = process.env;
  if (!EXECUTOR_URL || !EXECUTOR_CWD || !EXECUTOR_TOKEN)
    throw new Error('Set EXECUTOR_URL, EXECUTOR_CWD and EXECUTOR_TOKEN.');
  const environment = new Environment({
    url: EXECUTOR_URL,
    cwd: EXECUTOR_CWD,
    headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}` },
    tools: ['exec_command', 'write_stdin', 'apply_patch'],
    capabilityDirectories: process.env.EXECUTOR_CAPABILITIES
      ? [process.env.EXECUTOR_CAPABILITIES]
      : [],
  });
  const result = await runRemoteTask(
    process.argv.slice(2).join(' ') || 'Inspect the assigned workspace.',
    environment,
    { baseUrl: process.env.OPENAI_BASE_URL },
  );
  console.log(JSON.stringify(result, null, 2));
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
