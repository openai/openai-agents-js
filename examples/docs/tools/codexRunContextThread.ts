import { Agent, run } from '@openai/agents';
import { codexTool } from '@openai/agents-extensions/experimental/codex';

// Derived from codexTool({ name: 'engineer' }) when runContextThreadIdKey is omitted.
type ExampleContext = {
  codexThreadId_engineer?: string;
};

const agent = new Agent<ExampleContext>({
  name: 'Codex assistant',
  instructions: 'Use the codex tool for workspace tasks.',
  tools: [
    codexTool({
      // `name` is optional for a single Codex tool.
      // We set it so the run-context key is tool-specific and to avoid collisions when adding more Codex tools.
      name: 'engineer',
      // Reuse the same Codex thread across runs that share this context object.
      useRunContextThreadId: true,
      sandboxMode: 'workspace-write',
      workingDirectory: '/path/to/repo',
      defaultThreadOptions: {
        model: 'gpt-5.2-codex',
        approvalPolicy: 'never',
      },
    }),
  ],
});

// The default key for useRunContextThreadId with name=engineer is codexThreadId_engineer.
const context: ExampleContext = {};

// First turn creates (or resumes) a Codex thread and stores the thread ID in context.
await run(agent, 'Inspect src/tool.ts and summarize it.', { context });
// Second turn reuses the same thread because it shares the same context object.
await run(agent, 'Now list refactoring opportunities.', { context });

const threadId = context.codexThreadId_engineer;

void threadId;
