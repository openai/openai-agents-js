import type { CodexProviderOptions } from '@openai/agents-extensions/experimental/codex';
import { Runner } from '@openai/agents';

export async function exampleRunner(
  useCodex: boolean,
  codexOptions?: CodexProviderOptions['codexOptions'],
): Promise<Runner> {
  if (!useCodex) return new Runner({ model: process.env.OPENAI_MODEL });

  const { CodexProvider } =
    await import('@openai/agents-extensions/experimental/codex');
  return new Runner({
    model: process.env.CODEX_MODEL,
    modelProvider: new CodexProvider({
      codexOptions,
      threadOptions: { sandboxMode: 'read-only', approvalPolicy: 'never' },
    }),
  });
}
