// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, run, generateTraceId, withTrace } from '@openai/agents';
import { codexTool } from '@openai/agents-extensions/experimental/codex';

async function onCodexStream(payload) {
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
    const outputPreview = item.aggregated_output.slice(-200);
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
      `codex file change ${eventType}: ${item.status} | ${JSON.stringify(
        item.changes,
      )}`,
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

async function main() {
  const codex = codexTool({
    sandboxMode: 'workspace-write',
    defaultThreadOptions: {
      model: 'gpt-5.2-codex',
      modelReasoningEffort: 'low',
      networkAccessEnabled: true,
      webSearchEnabled: false,
      approvalPolicy: 'never',
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
  const result = await run(
    agent,
    'You must use `$openai-knowledge` skill to fetch the latest realtime model name.',
  );
  console.log(`[CODEX_RESPONSE]${result.finalOutput}[/CODEX_RESPONSE]`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
