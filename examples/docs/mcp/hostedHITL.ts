import { Agent, run, hostedMcpTool, RunToolApprovalItem } from '@openai/agents';

async function main(): Promise<void> {
  const agent = new Agent({
    name: 'MCP Assistant',
    instructions: 'You must always use the MCP tools to answer questions.',
    tools: [
      hostedMcpTool({
        serverLabel: 'deepwiki',
        serverUrl: 'https://mcp.deepwiki.com/mcp',
        // 'always' | 'never' | { never, always }
        requireApproval: {
          never: {
            toolNames: ['read_wiki_structure', 'read_wiki_contents'],
          },
          always: {
            toolNames: ['ask_question'],
          },
        },
      }),
    ],
  });

  let result = await run(
    agent,
    'For the repository openai/codex, tell me the primary programming language.',
  );
  while (result.interruptions && result.interruptions.length) {
    for (const interruption of result.interruptions) {
      // Human in the loop here
      const approval = await confirm(interruption);
      if (approval) {
        result.state.approve(interruption);
      } else {
        result.state.reject(interruption);
      }
    }
    result = await run(agent, result.state);
  }
  console.log(result.finalOutput);
}

import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

async function confirm(item: RunToolApprovalItem): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const name = item.name;
  const params = item.arguments;
  const answer = await rl.question(
    `Approve running tool (mcp: ${name}, params: ${params})? (y/n) `,
  );
  rl.close();
  return answer.toLowerCase().trim() === 'y';
}

main().catch(console.error);
