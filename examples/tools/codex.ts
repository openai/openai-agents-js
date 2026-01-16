import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, run, generateTraceId, withTrace } from '@openai/agents';
import {
  codexTool,
  type CodexToolStreamEvent,
} from '@openai/agents-extensions/experimental/codex';

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
  const eventType = event.type;

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
    const errorMessage = event.error?.message ?? 'Unknown error';
    log(`codex turn failed: ${errorMessage}`);
    return;
  }
  if (event.type === 'error') {
    log(`codex stream error: ${event.message}`);
    return;
  }

  if (
    event.type !== 'item.started' &&
    event.type !== 'item.updated' &&
    event.type !== 'item.completed'
  ) {
    return;
  }

  const item = event.item;

  if (item.type === 'reasoning') {
    log(`codex reasoning (${eventType}): ${item.text}`);
    return;
  }
  if (item.type === 'command_execution') {
    const outputPreview = item.aggregated_output?.slice(-200) ?? '';
    log(
      `codex command ${eventType}: ${item.command} | status=${item.status} | output=${outputPreview}`,
    );
    return;
  }
  if (item.type === 'mcp_tool_call') {
    log(
      `codex mcp ${eventType}: ${item.server}.${item.tool} | status=${item.status}`,
    );
    return;
  }
  if (item.type === 'file_change') {
    log(
      `codex file change ${eventType}: ${item.status} | ${JSON.stringify(item.changes)}`,
    );
    return;
  }
  if (item.type === 'web_search') {
    log(`codex web search ${eventType}: ${item.query}`);
    return;
  }
  if (item.type === 'todo_list') {
    log(`codex todo list ${eventType}: ${item.items.length} items`);
    return;
  }
  if (item.type === 'error') {
    log(`codex error ${eventType}: ${item.message}`);
  }
}

async function main(): Promise<void> {
  const traceId = generateTraceId();
  log(
    `View trace: https://platform.openai.com/traces/trace?trace_id=${traceId}`,
  );

  await withTrace(
    'Codex tool example',
    async () => {
      let workingDirectory = path.dirname(fileURLToPath(import.meta.url));
      while (
        !fs.existsSync(path.join(workingDirectory, 'pnpm-workspace.yaml'))
      ) {
        const parent = path.dirname(workingDirectory);
        if (parent === workingDirectory) {
          break;
        }
        // this needs to be top dir, not examples/tools
        workingDirectory = parent;
      }
      const codex = codexTool({
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
      });
      const agent = new Agent({
        name: 'Codex Agent',
        instructions: [
          'Use the codex tool to inspect the workspace and answer the question.',
          'When skill names, which usually start with `$`, are mentioned, you must rely on the codex tool to use the skill and answer the question.',
          'When you send the final answer, you must include the following info at the end:',
          'Run `codex resume <thread_id>` to continue the codex session.',
        ].join(' '),
        tools: [codex],
      });

      log(
        'Using $openai-knowledge skill to fetch the latest realtime model name...',
      );
      const result1 = await run(
        agent,
        'You must use `$openai-knowledge` skill to fetch the latest realtime model name.',
      );
      log(String(result1.finalOutput ?? ''));

      log(
        'Using $test-coverage-improver skill to analyze the test coverage of the project and improve it...',
      );
      const result2 = await run(
        agent,
        'You must use `$test-coverage-improver` skill to analyze the test coverage of the project and improve it.',
      );
      log(String(result2.finalOutput ?? ''));
    },
    { traceId },
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
