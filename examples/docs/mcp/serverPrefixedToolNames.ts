import { Agent, MCPServerStreamableHttp } from '@openai/agents';

const docsServer = new MCPServerStreamableHttp({
  url: 'https://docs.example.com/mcp',
  name: 'docs',
});
const calendarServer = new MCPServerStreamableHttp({
  url: 'https://calendar.example.com/mcp',
  name: 'calendar',
});

const agent = new Agent({
  name: 'Assistant',
  mcpServers: [docsServer, calendarServer],
  mcpConfig: {
    includeServerInToolNames: true,
  },
});

console.log(agent.name);
