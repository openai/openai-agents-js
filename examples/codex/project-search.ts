import { Agent, Environment, NativeProvider } from '@openai/agents';

/** Search an application-selected absolute project directory on the local executor. */
export async function searchProject(cwd: string) {
  await using provider = new NativeProvider();
  const agent = new Agent({
    provider,
    instructions:
      'Find relevant project files with project_glob, then inspect matching lines with project_grep. ' +
      'Check truncated, truncation_reasons, and errors. Narrow the path or pattern and rerun incomplete searches. ' +
      'Report paths and line numbers from the results.',
  });
  return await agent.run('Find references to project configuration.', {
    environment: Environment.local({
      cwd,
      tools: ['project_glob', 'project_grep'],
    }),
  });
}
