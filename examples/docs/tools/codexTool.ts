import { Agent } from '@openai/agents';
import { codexTool } from '@openai/agents-extensions/experimental/codex';

export const codexAgent = new Agent({
  name: 'Codex Agent',
  instructions:
    'Use the codex tool to inspect the workspace and answer the question. When skill names, which usually start with `$`, are mentioned, you must rely on the codex tool to use the skill and answer the question.',
  tools: [
    codexTool({
      sandboxMode: 'workspace-write',
      workingDirectory: '/path/to/repo',
      defaultThreadOptions: {
        model: 'gpt-5.2-codex',
        networkAccessEnabled: true,
        webSearchEnabled: false,
      },
      persistSession: true,
    }),
  ],
});
