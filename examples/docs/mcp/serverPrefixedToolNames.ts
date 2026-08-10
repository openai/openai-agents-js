import { Agent, MCPServerStreamableHttp } from '@openai/agents';

const docsServer = new MCPServerStreamableHttp({
  url: 'https://your-docs-server.invalid/mcp',
  name: 'docs',
});
const calendarServer = new MCPServerStreamableHttp({
  url: 'https://your-calendar-server.invalid/mcp',
  name: 'calendar',
});

const agent = new Agent({
  name: 'Assistant',
  mcpServers: [docsServer, calendarServer],
  mcpConfig: {
    includeServerInToolNames: true,
  },
});
