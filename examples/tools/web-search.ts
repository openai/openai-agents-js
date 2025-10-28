import { Agent, run, webSearchTool, withTrace } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'Web searcher',
    instructions: 'You are a helpful agent.',
    tools: [
      webSearchTool({
        userLocation: { type: 'approximate', city: 'New York' },
      }),
    ],
  });

  await withTrace('Web search example', async () => {
    const result = await run(
      agent,
      "search the web for 'local sports news' and give me 1 interesting update in a sentence.",
    );
    console.log(result.finalOutput);
    // The New York Giants are reportedly pursuing quarterback Aaron Rodgers after his ...

    const messages = result.history;
    messages.push({
      role: 'user',
      content: 'search the web for more details of the highlighted player.',
    });

    const result2 = await run(agent, messages);
    console.log();
    console.log(result2.finalOutput);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
