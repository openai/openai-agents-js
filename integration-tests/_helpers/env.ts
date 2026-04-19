export function createIntegrationSubprocessEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.CODEX_CI;
  delete env.CODEX_THREAD_ID;

  return {
    ...env,
    // The Vitest parent runs with NODE_ENV=test, where SDK tracing is disabled by default.
    NODE_ENV: 'development',
    NODE_OPTIONS: '',
    TS_NODE_PROJECT: '',
    TS_NODE_COMPILER_OPTIONS: '',
    ...overrides,
  };
}
