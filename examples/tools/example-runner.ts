import { Runner } from '@openai/agents';

export async function exampleRunner(useCodex: boolean): Promise<Runner> {
  if (!useCodex) return new Runner({ model: process.env.OPENAI_MODEL });

  const { CodexProvider } =
    await import('@openai/agents-extensions/experimental/codex');
  return new Runner({
    model: process.env.CODEX_MODEL,
    modelProvider: new CodexProvider({
      threadOptions: { sandboxMode: 'read-only', approvalPolicy: 'never' },
    }),
  });
}
