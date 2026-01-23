import 'server-only';

import type { Agent } from '@openai/agents';

export type AttachCodexToolOptions = {
  onStream?: (payload: any) => void | Promise<void>;
};

/**
 * Best-effort Codex tool attachment.
 *
 * This helper is intentionally isolated so the rest of the example can run even when
 * the Codex SDK isn't installed. The Codex tool module may throw during import if
 * the optional dependency is missing.
 */
export async function attachCodexTool(
  agent: Agent,
  options: AttachCodexToolOptions = {},
): Promise<boolean> {
  if (process.env.EXAMPLES_CHATKIT_CODEX_ENABLED !== '1') {
    return false;
  }

  try {
    const codexTool = (
      await import('@openai/agents-extensions/experimental/codex')
    ).codexTool;
    const codex = codexTool({
      sandboxMode: 'read-only',
      defaultThreadOptions: {
        networkAccessEnabled: true,
        webSearchEnabled: true,
      },
      onStream: options.onStream,
    });

    agent.tools.push(codex as any);
    return true;
  } catch {
    // Ignore optional dependency failures so the example still runs without Codex installed.
    return false;
  }
}
