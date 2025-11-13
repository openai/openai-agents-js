import { Agent, run, hostedMcpTool, RunToolApprovalItem } from '@openai/agents';

async function main(): Promise<void> {
  const agent = new Agent({
    name: 'MCP Assistant',
    instructions: 'You must always use the MCP tools to answer questions.',
    tools: [
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        // 'always' | 'never' | { never, always }
        requireApproval: {
          never: {
            toolNames: ['search_codex_code', 'fetch_codex_documentation'],
          },
          always: {
            toolNames: ['fetch_generic_url_content'],
          },
        },
      }),
    ],
  });

  let result = await run(agent, 'Which language is this repo written in?');
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
