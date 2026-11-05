import {
  Agent,
  Environment,
  NativeProvider,
  type EnvironmentOptions,
  type NativeProviderOptions,
} from '@openai/agents';

/** The application provisions the remote workspace; discovery grants no execution. */
export async function runWorkspaceCatalog(
  task: string,
  workspace: Pick<EnvironmentOptions, 'url' | 'cwd' | 'headers'>,
  model: string,
  options: NativeProviderOptions = {},
) {
  const environment = new Environment({
    url: workspace.url,
    cwd: workspace.cwd,
    headers: workspace.headers,
    capabilityDirectories: [workspace.cwd],
    tools: [],
  });
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    instructions:
      'Describe the available skill names and descriptions from the catalog. ' +
      'Do not claim to read or execute workspace files.',
    model,
    provider,
    tools: [],
  });
  await using session = await agent.session({ environment });
  const turn = await session.submit(task);
  return await turn.wait();
}

async function main() {
  const {
    EXECUTOR_URL,
    EXECUTOR_CWD,
    EXECUTOR_TOKEN,
    AGENT_MODEL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
  } = process.env;
  if (
    !EXECUTOR_URL ||
    !EXECUTOR_CWD ||
    !EXECUTOR_TOKEN ||
    !AGENT_MODEL ||
    !OPENAI_API_KEY
  )
    throw new Error(
      'Set EXECUTOR_URL, EXECUTOR_CWD, EXECUTOR_TOKEN, AGENT_MODEL and OPENAI_API_KEY.',
    );
  const result = await runWorkspaceCatalog(
    process.argv.slice(2).join(' ') ||
      'List the available skill names and descriptions.',
    {
      url: EXECUTOR_URL,
      cwd: EXECUTOR_CWD,
      headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}` },
    },
    AGENT_MODEL,
    {
      apiKey: OPENAI_API_KEY,
      baseUrl: OPENAI_BASE_URL,
      supportsWebsockets: false,
    },
  );
  console.log(result.finalOutput);
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    console.error(
      'Workspace catalog failed. Check executor, model and provider settings.',
    );
    process.exitCode = 1;
  });
}
