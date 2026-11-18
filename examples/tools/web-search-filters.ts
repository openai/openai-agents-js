import { Agent, run, webSearchTool, withTrace } from '@openai/agents';
import { exampleRunner } from './example-runner';

const allowedDomains = [
  'openai.com',
  'developers.openai.com',
  'platform.openai.com',
  'help.openai.com',
];

function allowedSource(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      allowedDomains.some(
        (domain) =>
          parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

async function main() {
  const useCodex = process.argv.includes('--codex');
  const agent = new Agent({
    name: 'OAI website searcher',
    model: useCodex ? undefined : 'gpt-5.4',
    instructions: useCodex
      ? 'Search official OpenAI resources only. Open each source page with the web tool before answering. Include inline Markdown links only to pages that you actually opened.'
      : 'You are a helpful agent that can search openai.com resources.',
    tools: [
      webSearchTool({
        // https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses#domain-filtering
        filters: {
          allowedDomains,
        },
        searchContextSize: 'medium',
      }),
    ],
    modelSettings: {
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      providerData: useCodex
        ? undefined
        : {
            // https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses#sources
            include: ['web_search_call.action.sources'],
          },
    },
  });

  await withTrace('OpenAI website search example', async () => {
    const today = new Date().toISOString().split('T')[0];
    const query = `Write a summary of the latest OpenAI Platform updates for developers in the last few weeks (today is ${today}).`;
    const result = useCodex
      ? await (await exampleRunner(true)).run(agent, query)
      : await run(agent, query);
    if (useCodex) {
      const opened = new Set<string>();
      for (const item of result.history) {
        if (
          item.type !== 'hosted_tool_call' ||
          item.name !== 'web_search_call' ||
          item.status !== 'completed'
        )
          continue;
        const action = item.providerData?.action;
        if (action?.type !== 'open_page' || typeof action.url !== 'string')
          continue;
        if (!allowedSource(action.url))
          throw new Error('The web tool opened a disallowed source.');
        opened.add(action.url);
      }
      const cited = [
        ...String(result.finalOutput).matchAll(
          /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g,
        ),
      ].map((match) => match[1]);
      if (
        !opened.size ||
        !cited.length ||
        cited.some((url) => !allowedSource(url) || !opened.has(url))
      ) {
        throw new Error(
          `Expected official Markdown citations matching actual completed web open_page receipts. Opened: ${JSON.stringify([...opened])}; cited: ${JSON.stringify(cited)}`,
        );
      }
      console.log(
        'Verified opened sources:',
        JSON.stringify([...opened], null, 2),
      );
    }
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
