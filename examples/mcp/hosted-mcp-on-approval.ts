import * as readline from 'readline/promises';
import { stdin, stdout } from 'node:process';
import { Agent, run, hostedMcpTool, RunToolApprovalItem } from '@openai/agents';

async function promptApproval(item: RunToolApprovalItem): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const name = item.rawItem.name;
  const params = JSON.parse(item.rawItem.providerData?.arguments || '{}');
  const answer = await rl.question(
    `Approve running tool (mcp: ${name}, params: ${JSON.stringify(params)})? (y/n) `,
  );
  rl.close();
  return answer.toLowerCase().trim() === 'y';
}

async function main(verbose: boolean, stream: boolean): Promise<void> {
  // 'always' | 'never' | { never, always }
  const requireApproval = {
    never: {
      toolNames: ['fetch_codex_documentation', 'fetch_generic_url_content'],
    },
    always: {
      toolNames: ['search_codex_code'],
    },
  };
  const agent = new Agent({
    name: 'MCP Assistant',
    instructions: 'You must always use the MCP tools to answer questions.',
    tools: [
      hostedMcpTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval,
        onApproval: async (_context, item) => {
          // Human in the loop here
          const approval = await promptApproval(item);
          return { approve: approval, reason: undefined };
        },
      }),
    ],
  });

  const input = 'Which language is this repo written in?';

  if (stream) {
    // Streaming
    const result = await run(agent, input, { stream: true });
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
