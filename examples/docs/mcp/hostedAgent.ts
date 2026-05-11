import { Agent, hostedMcpTool } from '@openai/agents';

export const agent = new Agent({
  name: 'MCP Assistant',
  instructions: 'You must always use the MCP tools to answer questions.',
  tools: [
    hostedMcpTool({
      serverLabel: 'deepwiki',
      serverUrl: 'https://mcp.deepwiki.com/mcp',
    }),
  ],
});
