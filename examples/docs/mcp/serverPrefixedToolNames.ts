import { Agent, MCPServerStreamableHttp } from '@openai/agents';

const docsServer = new MCPServerStreamableHttp({
  url: 'https://your-own-domain-here/docs/mcp',
  name: 'docs',
});
const calendarServer = new MCPServerStreamableHttp({
  url: 'https://your-own-domain-here/calendar/mcp',
  name: 'calendar',
});

const agent = new Agent({
  name: 'Assistant',
  mcpServers: [docsServer, calendarServer],
  mcpConfig: {
    includeServerInToolNames: true,
  },
});
