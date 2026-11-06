import {
  Agent,
  Environment,
  NativeProvider,
  type NativeProviderOptions,
} from '@openai/agents';

/** The application supplies a trusted, already-provisioned executor workspace. */
export async function reviewProjectGuidance(
  environment: Environment,
  options: NativeProviderOptions = {},
  model = 'gpt-5.5',
): Promise<string> {
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    model,
    instructions:
      'Review src/ledger.ts without editing files. ' +
      'Use the native read_text_file tool to read it before answering. ' +
      'Explain what it does and the relevant project conventions.',
    tools: [],
    provider,
  });
  await using session = await agent.session({
    environment,
    projectGuidance: true,
  });
  const turn = await session.submit(
    'Read src/ledger.ts and review its amount handling.',
  );
  return (await turn.wait()).finalOutput;
}

async function main(): Promise<void> {
  const { EXECUTOR_URL, EXECUTOR_CWD, EXECUTOR_TOKEN, OPENAI_API_KEY } =
    process.env;
  if (!EXECUTOR_URL || !EXECUTOR_CWD || !EXECUTOR_TOKEN || !OPENAI_API_KEY)
    throw new Error(
      'Set EXECUTOR_URL, EXECUTOR_CWD, EXECUTOR_TOKEN and OPENAI_API_KEY.',
    );
  // cwd comes from the application's trust decision, never model arguments.
  const environment = new Environment({
    url: EXECUTOR_URL,
    cwd: EXECUTOR_CWD,
    headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}` },
    tools: [],
  });
  console.log(
    await reviewProjectGuidance(
      environment,
      { apiKey: OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL },
      process.env.AGENT_MODEL || 'gpt-5.5',
    ),
  );
}

// Requires a provisioned executor and model credentials; this makes live calls.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
