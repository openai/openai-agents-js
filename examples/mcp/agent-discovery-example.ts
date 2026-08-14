import {
  Agent,
  run,
  MCPServerStreamableHttp,
  createMCPToolStaticFilter,
  withTrace,
} from '@openai/agents';

// The registry exposes read-only lookups alongside tools that mutate registry state, such as
// registering an agent or proxying a paid call. Discovery needs only the read-only subset, so the
// filter keeps the agent from reaching the mutating tools at all.
const READ_ONLY_TOOLS = [
  // Discovery: find candidates by capability, or page through the whole registry.
  'match_agents',
  'list_registry',
  // Due diligence on a candidate that discovery surfaced.
  'verify_agent',
  'get_agent',
  'protocol_reference',
];

async function main() {
  const mcpServer = new MCPServerStreamableHttp({
    url: 'https://api.aidress.ai/mcp-http/mcp',
    name: 'Aidress Agent Registry MCP Server',
    clientSessionTimeoutSeconds: 15,
    timeout: 15000,
    toolFilter: createMCPToolStaticFilter({ allowed: READ_ONLY_TOOLS }),
    reconnectionOptions: {
      maxRetries: 2,
      initialReconnectionDelay: 2000,
      reconnectionDelayGrowFactor: 2,
      maxReconnectionDelay: 30000,
    },
  });

  const agent = new Agent({
    name: 'Agent Discovery Assistant',
    instructions: [
      'You find third-party agents that can do a task the user needs done.',
      'Start by searching the registry for agents offering the required capability, and report',
      'what you found: how many candidates there are and what each one does.',
      'Then, because the user has not worked with any of them before, check each candidate',
      'trust score, whether it is verified, how many transactions it has completed, and any flags.',
      'Close with the candidate you would pick and the evidence behind the choice.',
      'Report only the values the tools return; never invent an agent or a score.',
    ].join(' '),
    mcpServers: [mcpServer],
  });

  try {
    await withTrace('Aidress Agent Discovery Example', async () => {
      await mcpServer.connect();
      const result = await run(
        agent,
        "I need a web research task done, but I don't know which agents offer that. " +
          'Find the ones that do, then tell me which of them I can trust with the job.',
      );
      console.log(result.finalOutput);
    });
  } finally {
    await mcpServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
