import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, generateTraceId, run, withTrace } from '@openai/agents';
import {
  codexTool,
  type CodexToolStreamEvent,
} from '@openai/agents-extensions/experimental/codex';

const THREAD_ID_KEY = 'codexThreadIdEngineer';

type ExampleContext = {
  codexThreadIdEngineer?: string;
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
  log(
    `View trace: https://platform.openai.com/traces/trace?trace_id=${traceId}`,
  );

  await withTrace(
    'Codex same thread example',
    async () => {
      const workingDirectory = resolveWorkingDirectory();
      const agent = new Agent<ExampleContext>({
        name: 'Codex Agent (same thread)',
        instructions: [
          'Always use the codex tool to answer the user question.',
          'Even if context is limited, use the codex tool to continue the same task.',
        ].join(' '),
        tools: [
          codexTool({
            name: 'codex_engineer',
            sandboxMode: 'workspace-write',
            defaultThreadOptions: {
              model: 'gpt-5.2-codex',
              modelReasoningEffort: 'low',
              networkAccessEnabled: true,
              webSearchEnabled: false,
              approvalPolicy: 'never',
              workingDirectory,
            },
            onStream: onCodexStream,
            useRunContextThreadId: true,
          }),
        ],
      });

      const context: ExampleContext = {};

      log('Turn 1: ask for a Python Responses API example.');
      const first = await run(
        agent,
        "Write a working Python example for OpenAI's Responses API with web search enabled.",
        { context },
      );
      const firstThreadId = context[THREAD_ID_KEY] ?? null;
      log(String(first.finalOutput ?? ''));
      log(`thread after turn 1: ${firstThreadId}`);

      log('Turn 2: continue in the same Codex thread.');
      const second = await run(
        agent,
        'Rewrite the same example in TypeScript.',
        {
          context,
        },
      );
      const secondThreadId = context[THREAD_ID_KEY] ?? null;
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
