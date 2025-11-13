import { Agent, run, hostedMcpTool, RunToolApprovalItem } from '@openai/agents';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

async function confirm(item: RunToolApprovalItem): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const name = item.name;
  const params = JSON.parse(item.arguments ?? '{}');
  const answer = await rl.question(
    `Approve running tool (mcp: ${name}, params: ${JSON.stringify(params)})? (y/n) `,
  );
  rl.close();
  return answer.toLowerCase().trim() === 'y';
}

async function main(verbose: boolean, stream: boolean): Promise<void> {
  // 'always' | 'never' | { never, always }
  const requireApproval = {
    never: { toolNames: ['search_codex_code'] },
    always: {
      toolNames: ['fetch_generic_url_content', 'fetch_codex_documentation'],
    },
  };
  const agent = new Agent({
    name: 'MCP Assistant',
    instructions:
      'You must always use the MCP tools to answer questions. The mcp server knows which repo to investigate, so you do not need to ask the user about it.',
    tools: [
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval,
        // when you don't pass onApproval, the agent loop will handle the approval process
      }),
    ],
  });

  const input = 'Which language is this repo written in?';

  if (stream) {
    // Streaming
    const result = await run(agent, input, { stream: true, maxTurns: 100 });
    for await (const event of result) {
      if (verbose) {
        console.log(JSON.stringify(event, null, 2));
      } else {
        if (
          event.type === 'raw_model_stream_event' &&
          event.data.type === 'model'
        ) {
          console.log(event.data.event.type);
        }
      }
    }
    console.log(`Done streaming; final result: ${result.finalOutput}`);
  } else {
    // Non-streaming
    let result = await run(agent, input);
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

    if (verbose) {
      console.log('----------------------------------------------------------');
      console.log(JSON.stringify(result.newItems, null, 2));
      console.log('----------------------------------------------------------');
    }
  }
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const stream = args.includes('--stream');

main(verbose, stream).catch((err) => {
  console.error(err);
  process.exit(1);
});
