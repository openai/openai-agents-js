import { Agent, run, hostedMCPTool } from '@openai/agents';

/**
 * This example demonstrates how to use the hosted MCP support in the OpenAI Responses API, with
 * approvals not required for any tools. You should only use this for trusted MCP servers.
 */

async function main(verbose: boolean, stream: boolean) {
  const agent = new Agent({
    name: 'Assistant',
    tools: [
      hostedMCPTool({
        serverLabel: 'deepwiki',
        serverUrl: 'https://mcp.deepwiki.com/mcp',
        requireApproval: 'never',
      }),
    ],
  });

  let result: any;
  if (stream) {
    result = await run(
      agent,
      'What transport protocols are supported in the 2025-03-26 version of the MCP spec?',
      {
        stream: true,
      },
    );
    for await (const event of result.toStream()) {
      if (event.type === 'run_item_stream_event') {
        console.log(`Got event of type ${event.item.constructor.name}`);
      } else if (event.type === 'run_item_stream_event') {
      }
    }
    console.log(`Done streaming; final result: ${result.finalOutput}`);
  } else {
    result = await run(
      agent,
      'What transport protocols are supported in the 2025-03-26 version of the MCP spec?',
    );
    console.log(result.finalOutput);
    // As of the **2025-03-26 version** of the **MCP (Mesh Configuration Protocol) specification**, the following **transport protocols are supported**:...
  }

  if (verbose) {
    for (const item of result.newItems) {
      console.log(item);
    }
  }
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || false;
const stream = args.includes('--stream') || false;

main(verbose, stream).catch(console.error);
