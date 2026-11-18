import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, generateTraceId, run, withTrace } from '@openai/agents';
import {
  codexTool,
  type CodexToolStreamEvent,
} from '@openai/agents-extensions/experimental/codex';

// Derived from codexTool({ name: 'codex_engineer' }) when runContextThreadIdKey is omitted.
const THREAD_ID_KEY = 'codexThreadId_engineer';

type ExampleContext = {
  codexThreadId_engineer?: string;
};

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function log(message: string): void {
  const lines = String(message).split('\n');
  const stamp = timestamp();
  for (const line of lines) {
    console.log(`${stamp} ${line}`);
  }
}

async function onCodexStream(payload: CodexToolStreamEvent): Promise<void> {
  const event = payload.event;
  if (event.type === 'thread.started') {
    log(`codex thread started: ${event.thread_id}`);
    return;
  }
  if (event.type === 'turn.started') {
    log('codex turn started');
    return;
  }
  if (event.type === 'turn.completed') {
    log(`codex turn completed, usage: ${JSON.stringify(event.usage)}`);
    return;
  }
  if (event.type === 'turn.failed') {
    log(`codex turn failed: ${event.error?.message ?? 'unknown error'}`);
    return;
  }
  if (event.type === 'error') {
    log(`codex stream error: ${event.message}`);
  }
}

function resolveWorkingDirectory(): string {
  // Walk up to the repository root so Codex can work against this workspace.
  let workingDirectory = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(workingDirectory, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(workingDirectory);
    if (parent === workingDirectory) {
      break;
    }
    workingDirectory = parent;
  }
  return workingDirectory;
}

async function main(): Promise<void> {
  const traceId = generateTraceId();
  log(`View trace: https://platform.openai.com/logs/trace?trace_id=${traceId}`);

  await withTrace(
    'Codex same thread example',
    async () => {
      const workingDirectory = resolveWorkingDirectory();
      let completedCodexTurns = 0;
      const agent = new Agent<ExampleContext>({
        name: 'Codex Agent (same thread)',
        modelSettings: { toolChoice: 'required' },
        instructions: [
          'Delegate every question to the codex_engineer SDK function tool. Do not use your own native shell or workspace tools instead.',
          'Even if context is limited, use the codex tool to continue the same task.',
          'Ask Codex to return example code in its response only. Do not modify files or run implementation checks.',
        ].join(' '),
        tools: [
          codexTool({
            // `name` is optional for a single Codex tool.
            // We set it so the run-context key is tool-specific and to avoid collisions when adding more Codex tools.
            name: 'codex_engineer',
            sandboxMode: 'read-only',
            defaultThreadOptions: {
              model: 'gpt-5.4',
              modelReasoningEffort: 'low',
              networkAccessEnabled: true,
              webSearchEnabled: false,
              approvalPolicy: 'never',
              workingDirectory,
            },
            onStream: async (payload) => {
              if (payload.event.type === 'turn.completed')
                completedCodexTurns++;
              await onCodexStream(payload);
            },
            // Reuse the same Codex thread across runs that share this context object.
            useRunContextThreadId: true,
          }),
        ],
      });

      // The default key for useRunContextThreadId with name=codex_engineer is codexThreadId_engineer.
      const context: ExampleContext = {};

      log('Turn 1: ask for a Python Responses API example.');
      const beforeFirst = completedCodexTurns;
      const first = await run(
        agent,
        "Call the codex_engineer SDK function tool to return a working Python example for OpenAI's Responses API with web search enabled. Return code in the response only; do not modify files or run implementation checks.",
        { context },
      );
      const firstThreadId = context[THREAD_ID_KEY] ?? null;
      if (!firstThreadId || completedCodexTurns <= beforeFirst) {
        throw new Error(
          'The first question did not complete a Codex tool turn.',
        );
      }
      log(String(first.finalOutput ?? ''));
      log(`thread after turn 1: ${firstThreadId}`);

      log('Turn 2: continue in the same Codex thread.');
      const beforeSecond = completedCodexTurns;
      const second = await run(
        agent,
        'Call the codex_engineer SDK function tool to continue its existing thread and rewrite the same example in TypeScript. Return code in the response only; do not modify files or run implementation checks.',
        {
          context,
        },
      );
      const secondThreadId = context[THREAD_ID_KEY] ?? null;
      if (
        secondThreadId !== firstThreadId ||
        completedCodexTurns <= beforeSecond
      ) {
        throw new Error(
          'The second question did not complete a turn in the same Codex thread.',
        );
      }
      log(String(second.finalOutput ?? ''));
      log(`thread after turn 2: ${secondThreadId}`);
      log(
        `same thread reused: ${Boolean(
          firstThreadId && secondThreadId && firstThreadId === secondThreadId,
        )}`,
      );
    },
    { traceId },
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
