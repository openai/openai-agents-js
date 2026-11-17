import {
  Agent,
  createMCPToolStaticFilter,
  getAllMcpTools,
  MCPServerStreamableHttp,
  Runner,
} from '@openai/agents';

export const question =
  'Use ask_wiki_question to find the primary programming language of the public repository openai/codex.';

export async function prepareMcpExample(needsApproval = false) {
  const mode = process.argv[2];
  if (mode !== 'openai' && mode !== 'codex') {
    throw new Error('Pass openai or codex as the first argument.');
  }
  let modelProvider;
  if (mode === 'codex') {
    const { CodexProvider } =
      await import('@openai/agents-extensions/experimental/codex');
    modelProvider = new CodexProvider({
      threadOptions: {
        workingDirectory: process.cwd(),
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      },
    });
  }
  const runner = new Runner({
    modelProvider,
    model:
      mode === 'codex' ? process.env.CODEX_MODEL : process.env.OPENAI_MODEL,
    tracingDisabled: true,
  });
  const server = new MCPServerStreamableHttp({
    url: process.env.MCP_SERVER_URL ?? 'https://mcp.deepwiki.com/mcp',
    name: 'DeepWiki',
    toolFilter: createMCPToolStaticFilter({
      allowed: ['ask_wiki_question'],
    }),
  });

  try {
    await server.connect();
    const tools = await getAllMcpTools([server]);
    if (tools.length === 0) {
      throw new Error('The MCP server must expose ask_wiki_question.');
    }
    for (const tool of tools) {
      if (tool.type === 'function') {
        tool.needsApproval = async () => needsApproval;
      }
    }
    const agent = new Agent({
      name: 'Repository assistant',
      instructions:
        'Use ask_wiki_question for questions about the public openai/codex repository. If the user rejects a tool call, stop and explain that you could not query the repository.',
      tools,
    });
    return { agent, runner, server };
  } catch (error) {
    await server.close();
    throw error;
  }
}
