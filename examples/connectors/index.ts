import { Agent, run, hostedMcpTool } from '@openai/agents';

async function main(verbose: boolean, stream: boolean): Promise<void> {
  // 1. Visit https://developers.google.com/oauthplayground/
  // 2. Input https://www.googleapis.com/auth/calendar.events as the required scope
  // 3. Grab the acccess token starting with "ya29."
  const authorization = process.env.GOOGLE_CALENDAR_AUTHORIZATION!;

  const agent = new Agent({
    name: 'My Calendar Assistant',
    instructions:
      'You are a helpful assistant that can help a user with their calendar.',
    tools: [
      hostedMcpTool({
        serverLabel: 'google_calendar',
        connectorId: 'connector_googlecalendar',
        authorization,
        requireApproval: 'never',
      }),
    ],
  });

  const today = new Date().toISOString().split('T')[0];
  const input = `What is my schedule for ${today}?`;
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
    if (verbose) {
      for (const item of res.output) {
        console.log(JSON.stringify(item, null, 2));
      }
    }
    console.log(res.finalOutput);
  }
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const stream = args.includes('--stream');

main(verbose, stream).catch((err) => {
  console.error(err);
  process.exit(1);
});
