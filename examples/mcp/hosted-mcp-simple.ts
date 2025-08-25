import { Agent, run, hostedMcpTool, withTrace } from '@openai/agents';

async function main(verbose: boolean, stream: boolean): Promise<void> {
  withTrace('Hosted MCP Example', async () => {
    const agent = new Agent({
      name: 'MCP Assistant',
      instructions:
        'You must always use the MCP tools to answer questions. The mcp server knows which repo to investigate, so you do not need to ask the user about it.',
      tools: [
        hostedMcpTool({
          serverLabel: 'gitmcp',
          serverUrl: 'https://gitmcp.io/openai/codex',
        }),
      ],
    });

    const input =
      'Which language is the repo I pointed in the MCP tool settings written in?';
    if (stream) {
      const result = await run(agent, input, { stream: true });
      for await (const event of result) {
        if (
          event.type === 'raw_model_stream_event' &&
          event.data.type === 'model' &&
          event.data.event.type !== 'response.mcp_call_arguments.delta' &&
          event.data.event.type !== 'response.output_text.delta'
        ) {
          console.log(`Got event of type ${JSON.stringify(event.data)}`);
        }
      }
      for (const item of result.newItems) {
        console.log(JSON.stringify(item, null, 2));
      }
      console.log(`Done streaming; final result: ${result.finalOutput}`);
    } else {
      const res = await run(agent, input);
      // The repository is primarily written in multiple languages, including Rust and TypeScript...
      if (verbose) {
        for (const item of res.output) {
          console.log(JSON.stringify(item, null, 2));
        }
      }
      console.log(res.finalOutput);
    }
  });
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const stream = args.includes('--stream');

main(verbose, stream).catch((err) => {
  console.error(err);
  process.exit(1);
});
