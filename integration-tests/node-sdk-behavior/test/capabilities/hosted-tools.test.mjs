import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Agent,
  RunState,
  hostedMcpTool,
  setTracingDisabled,
  webSearchTool,
} from '@openai/agents';

import {
  createRunner,
  integrationModel,
  mcpServerUrl,
  normalizeText,
} from '../helpers.mjs';

setTracingDisabled(true);

test('web search emits a provider-owned call item', async () => {
  const agent = new Agent({
    name: 'Published web search agent',
    model: integrationModel,
    instructions:
      'Search the web before answering. Identify the organization that publishes the OpenAI Agents JS SDK, then answer with only OPENAI.',
    tools: [webSearchTool()],
    modelSettings: { maxTokens: 768, toolChoice: 'required' },
  });

  const result = await createRunner().run(
    agent,
    'Search for the official openai-agents-js GitHub repository publisher.',
  );

  assert.equal(normalizeText(result.finalOutput), 'OPENAI');
  assert.ok(
    result.newItems.some(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem?.type === 'hosted_tool_call' &&
        item.rawItem?.providerData?.type === 'web_search_call',
    ),
  );
});

test('hosted MCP lists and calls a trusted remote server', async () => {
  const agent = new Agent({
    name: 'Published hosted MCP agent',
    model: integrationModel,
    instructions:
      'Use the DeepWiki MCP server to identify the main programming language of openai/openai-agents-js.',
    tools: [
      hostedMcpTool({
        serverLabel: 'published_deepwiki',
        serverUrl: mcpServerUrl,
        allowedTools: ['ask_question'],
        requireApproval: 'never',
      }),
    ],
    modelSettings: { maxTokens: 768, toolChoice: 'required' },
  });

  const result = await createRunner().run(
    agent,
    'Which language is the openai/openai-agents-js repository mainly written in?',
    { maxTurns: 5 },
  );

  assert.match(String(result.finalOutput), /typescript/i);
  assert.ok(
    result.newItems.some(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem?.type === 'hosted_tool_call' &&
        item.rawItem?.providerData?.type === 'mcp_list_tools',
    ),
  );
  assert.ok(
    result.newItems.some(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem?.type === 'hosted_tool_call' &&
        item.rawItem?.providerData?.type === 'mcp_call',
    ),
  );
});

test('hosted MCP approval survives serialized pause and resume', async () => {
  const agent = new Agent({
    name: 'Published hosted MCP approval agent',
    model: integrationModel,
    instructions:
      'Use ask_question from DeepWiki to answer the repository language question.',
    tools: [
      hostedMcpTool({
        serverLabel: 'published_mcp_approval',
        serverUrl: mcpServerUrl,
        allowedTools: ['ask_question'],
        requireApproval: 'always',
      }),
    ],
    modelSettings: { maxTokens: 768, toolChoice: 'required' },
  });
  const first = await createRunner().run(
    agent,
    'Which language is the openai/openai-agents-js repository mainly written in?',
    { maxTurns: 6 },
  );

  assert.equal(first.interruptions?.length, 1);
  assert.ok(
    first.newItems.some(
      (item) =>
        item.type === 'tool_approval_item' &&
        item.rawItem?.type === 'hosted_tool_call' &&
        item.rawItem?.providerData?.type === 'mcp_approval_request',
    ),
  );

  const restored = await RunState.fromString(agent, first.state.toString());
  restored.approve(restored.getInterruptions()[0]);
  const resumed = await createRunner({
    modelSettings: { toolChoice: 'auto' },
  }).run(agent, restored, { maxTurns: 6 });

  assert.match(String(resumed.finalOutput), /typescript/i);
  assert.ok(
    resumed.newItems.some(
      (item) =>
        item.rawItem?.type === 'hosted_tool_call' &&
        item.rawItem?.name === 'mcp_approval_response',
    ),
  );
});
