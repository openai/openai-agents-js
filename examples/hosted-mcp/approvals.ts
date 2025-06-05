import { Agent, run, hostedMCPTool } from '@openai/agents';
import * as readline from 'readline';

/**
 * This example demonstrates how to use the hosted MCP support in the OpenAI Responses API, with
 * approval callbacks.
 */

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function approvalCallback(toolName: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(
      `Approve running the tool \`${toolName}\`? (y/n) `,
      (answer) => {
        const approved = answer.toLowerCase() === 'y';
        if (!approved) {
          console.log('User denied');
        }
        resolve(approved);
      },
    );
  });
}

async function main(verbose: boolean, stream: boolean) {
  const agent = new Agent({
    name: 'Assistant',
    tools: [
      hostedMCPTool({
        serverLabel: 'gitmcp',
        serverUrl: 'https://gitmcp.io/openai/codex',
        requireApproval: 'always',
      }),
    ],
  });

  let result: any;

  if (stream) {
    result = await run(agent, 'Which language is this repo written in?', {
      stream: true,
    });

    for await (const event of result.toStream()) {
      if (event.type === 'run_item_stream_event') {
        console.log(`Got event of type ${event.item.constructor.name}`);
      }
    }
    console.log(`Done streaming; final result: ${result.finalOutput}`);
  } else {
    result = await run(agent, 'Which language is this repo written in?');
    console.log(result.finalOutput);
  }

  if (verbose) {
    for (const item of result.newItems) {
      console.log(item);
    }
  }

  // Close readline interface
  rl.close();
}

// Parse command line arguments
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const stream = args.includes('--stream');

main(verbose, stream).catch((error) => {
  console.error(error);
  rl.close();
  process.exit(1);
});
