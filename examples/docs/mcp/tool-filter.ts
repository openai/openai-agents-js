import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  createMCPToolStaticFilter,
  MCPToolFilterContext,
} from '@openai/agents';

interface ToolFilterContext {
  allowAll: boolean;
}

const server = new MCPServerStdio({
  fullCommand: 'my-server',
  toolFilter: createMCPToolStaticFilter({
    allowed: ['safe_tool'],
    blocked: ['danger_tool'],
  }),
});

const dynamicServer = new MCPServerStreamableHttp({
  url: 'http://localhost:3000',
  toolFilter: async ({ runContext }: MCPToolFilterContext, tool) =>
    (runContext.context as ToolFilterContext).allowAll || tool.name !== 'admin',
});