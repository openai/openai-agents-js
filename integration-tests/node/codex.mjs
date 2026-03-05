// @ts-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, run } from '@openai/agents';
import { codexTool } from '@openai/agents-extensions/experimental/codex';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

async function onCodexStream(payload) {
  const event = payload.event;
  const eventType = event.type;

  if (event.type === 'thread.started') {
    console.log(`codex thread started: ${event.thread_id}`);
    return;
  }
  if (event.type === 'turn.started') {
    console.log('codex turn started');
    return;
  }
  if (event.type === 'turn.completed') {
    console.log(`codex turn completed, usage: ${JSON.stringify(event.usage)}`);
    return;
  }
  if (event.type === 'turn.failed') {
    const errorMessage = event.error?.message ?? 'Unknown error';
    console.log(`codex turn failed: ${errorMessage}`);
    return;
  }
  if (event.type === 'error') {
    console.log(`codex stream error: ${event.message}`);
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
    console.log(`codex reasoning (${eventType}): ${item.text}`);
    return;
  }
  if (item.type === 'command_execution') {
    const outputPreview = item.aggregated_output.slice(-200);
    console.log(
      `codex command ${eventType}: ${item.command} | status=${item.status} | output=${outputPreview}`,
    );
    return;
  }
  if (item.type === 'mcp_tool_call') {
    console.log(
      `codex mcp ${eventType}: ${item.server}.${item.tool} | status=${item.status}`,
    );
    return;
  }
  if (item.type === 'file_change') {
    console.log(
      `codex file change ${eventType}: ${item.status} | ${JSON.stringify(
        item.changes,
      )}`,
    );
    return;
  }
  if (item.type === 'web_search') {
    console.log(`codex web search ${eventType}: ${item.query}`);
    return;
  }
  if (item.type === 'todo_list') {
    console.log(`codex todo list ${eventType}: ${item.items.length} items`);
    return;
  }
  if (item.type === 'error') {
    console.log(`codex error ${eventType}: ${item.message}`);
  }
}

function createCodexEnv() {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'CODEX_CI' || key === 'CODEX_THREAD_ID') {
      continue;
    }
    env[key] = value;
  }

  return env;
}

async function main() {
  const codex = codexTool({
    sandboxMode: 'workspace-write',
    workingDirectory: fixtureDirectory,
    codexOptions: {
      env: createCodexEnv(),
    },
    defaultThreadOptions: {
      model: 'gpt-5.2-codex',
      modelReasoningEffort: 'low',
      networkAccessEnabled: false,
      webSearchEnabled: false,
      approvalPolicy: 'never',
    },
    onStream: onCodexStream,
  });
  const agent = new Agent({
    name: 'Codex Agent',
    instructions: [
      'Use the codex tool to inspect the workspace and answer the question.',
      'Use only local workspace files for this task.',
      'Keep the final answer to one short sentence.',
    ].join(' '),
    tools: [codex],
  });
  const result = await run(
    agent,
    'Use the codex tool to inspect package.json in the current workspace and tell me the version of @openai/codex-sdk.',
  );
  console.log(`[CODEX_RESPONSE]${result.finalOutput}[/CODEX_RESPONSE]`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
