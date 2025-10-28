import { Agent, run, webSearchTool, withTrace } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'OAI website searcher',
    model: 'gpt-5-nano',
    instructions:
      'You are a helpful agent that can search openai.com resources.',
    tools: [
      webSearchTool({
        // https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses#domain-filtering
        filters: {
          allowedDomains: [
            'openai.com',
            'developer.openai.com',
            'platform.openai.com',
            'help.openai.com',
          ],
        },
        searchContextSize: 'medium',
      }),
    ],
    modelSettings: {
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      providerData: {
        // https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses#sources
        include: ['web_search_call.action.sources'],
      },
    },
  });

  await withTrace('OpenAI website search example', async () => {
    const today = new Date().toISOString().split('T')[0];
    const query = `Write a summary of the latest OpenAI Platform updates for developers in the last few weeks (today is ${today}).`;
    const result = await run(agent, query);
    console.log('\n----- Sources -----\n');
    for (const item of result.history) {
      if (
        item.type === 'hosted_tool_call' &&
        item.name === 'web_search_call' &&
        item.providerData?.action?.sources
      ) {
        console.log(
          JSON.stringify(
            item.providerData.action.sources.map((s: any) => s.url),
            null,
            2,
          ),
        );
      }
    }
    console.log('\n----- Final Output -----\n');
    console.log(result.finalOutput);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
