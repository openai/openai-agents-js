import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
  type NativeProviderOptions,
} from '@openai/agents';

/** Keep child defaults for its first preparation, then select no new tools. */
export const oneToolStepPerChildTurn: NonNullable<
  NativeAgents['beforeStep']
> = ({ stepIndex, signal }) => {
  signal.throwIfAborted();
  return stepIndex === 0 ? undefined : [];
};

/** The application supplies an executor with all three execution tools admitted. */
export async function runNativeChildren(
  task: string,
  environment: Environment,
  options: NativeProviderOptions = {},
  beforeStep?: NativeAgents['beforeStep'],
) {
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    instructions:
      'Ask the reviewer role to inspect the assigned task. ' +
      'Wait for its answer, then summarize the findings.',
    model: 'gpt-5.5',
    tools: [
      new NativeAgents({
        additionalRoles: [
          new NativeRole({
            name: 'reviewer',
            description: 'Inspect the assigned task in the selected workspace.',
            instructions:
              'Inspect the task and report findings without editing files.',
            model: 'gpt-5.5',
            modelSettings: { reasoningEffort: 'medium' },
          }),
        ],
        maxChildren: 1,
        maxDepth: 1,
        beforeStep,
      }),
    ],
    provider,
  });
  await using session = await agent.session({ environment });
  const root = await (await session.submit(task)).wait();
  // Capture the current children before waiting; this is not a live tree reader.
  const captured = [];
  for await (const child of session.subagents()) captured.push(child);
  const children = [];
  for (const child of captured) {
    const turn = child.turn;
    // This wait joins only this issued child Turn, not later work or descendants.
    const result = turn ? await turn.wait() : null;
    children.push({
      id: child.id,
      statusAtSnapshot: child.status,
      isLiveAtSnapshot: child.isLive,
      turnId: turn?.turnId ?? null,
      answer: result?.finalOutput ?? null,
    });
  }
  // Session disposal stops and joins remaining owned work before provider disposal.
  return { rootAnswer: root.finalOutput, children };
}

/** Use the same explicitly provisioned executor configuration as remote-executor.ts. */
async function main(): Promise<void> {
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
  console.log(
    await runNativeChildren(
      process.argv.slice(2).join(' ') ||
        'Review the selected workspace without edits.',
      environment,
      { baseUrl: process.env.OPENAI_BASE_URL },
      oneToolStepPerChildTurn,
    ),
  );
}

// Requires Model credentials and a provisioned executor; this makes live calls.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
