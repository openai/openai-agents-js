import assert from 'node:assert/strict';

import { Runner } from '@openai/agents';

export const integrationModel =
  process.env.OPENAI_AGENTS_INTEGRATION_MODEL ?? 'gpt-5.6';

export const hostedModel =
  process.env.OPENAI_AGENTS_INTEGRATION_HOSTED_MODEL ?? 'gpt-5.6-sol';

export const mcpServerUrl =
  process.env.OPENAI_AGENTS_INTEGRATION_MCP_SERVER_URL ??
  'https://mcp.deepwiki.com/mcp';

export function assertInstalledPackageBoundary() {
  const resolved = import.meta.resolve('@openai/agents');
  assert.match(resolved, /node_modules\/@openai\/agents\/dist\/index\.mjs$/);
  assert.doesNotMatch(resolved, /packages\/agents\/src/);
}

export function createRunner(config = {}) {
  return new Runner({
    tracingDisabled: true,
    ...config,
  });
}

export async function runAgent(runner, agent, input, options = {}) {
  const { stream = false, ...runOptions } = options;
  if (!stream) {
    return runner.run(agent, input, runOptions);
  }

  const result = await runner.run(agent, input, {
    ...runOptions,
    stream: true,
  });
  const events = [];
  for await (const event of result) {
    events.push(event);
  }
  return { result, events };
}

export function getToolCalls(result, name) {
  return result.newItems.filter(
    (item) =>
      item.type === 'tool_call_item' &&
      (name === undefined || item.rawItem?.name === name),
  );
}

export function getToolOutputs(result) {
  return result.newItems.filter(
    (item) => item.type === 'tool_call_output_item',
  );
}

export function hasRawModelEvent(events) {
  return events.some((event) => event.type === 'raw_model_stream_event');
}

export function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}
